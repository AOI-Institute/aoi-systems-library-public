import { createHash } from "crypto";

type HttpResponse = {
  status: number;
  content_type: string;
  body: string;
};

type OperationResult = {
  status: number;
  body: any;
};

type Operation = () => OperationResult | Promise<OperationResult>;

type RecordStatus = "in_progress" | "completed";

type IdempotencyRecord = {
  scope: string;
  idem_key: string;
  request_fingerprint: string;
  status: RecordStatus;
  response_status?: number;
  response_body?: string;
  created_at: Date;
  expires_at: Date;
};

class InMemoryStore {
  private map: Map<string, IdempotencyRecord> = new Map();

  private key(scope: string, idem_key: string): string {
    return `${scope}|${idem_key}`;
  }

  get(scope: string, idem_key: string): IdempotencyRecord | undefined {
    return this.map.get(this.key(scope, idem_key));
  }

  set(record: IdempotencyRecord): void {
    this.map.set(this.key(record.scope, record.idem_key), record);
  }

  delete(scope: string, idem_key: string): void {
    this.map.delete(this.key(scope, idem_key));
  }

  entries(): IterableIterator<IdempotencyRecord> {
    return this.map.values();
  }
}

/* singleton store – all calls share the same instance */
const _store = new InMemoryStore();

/* ---------- helpers ---------- */
function fingerprint(method: string, path: string, body: string): string {
  const data = `${method} ${path}\n${body}`;
  return createHash("sha256").update(data).digest("hex");
}

function problemResponse(
  status: number,
  title: string,
  detail: string
): HttpResponse {
  const payload = {
    type: "about:blank",
    title,
    detail,
  };
  return {
    status,
    content_type: "application/problem+json",
    body: JSON.stringify(payload),
  };
}

/* ---------- public API ---------- */
export function is_required(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PATCH";
}

/**
 * Handles an idempotent request.
 *
 * @param scope            client/user identifier (string)
 * @param idempotency_key  value of Idempotency-Key header (string | undefined)
 * @param method           HTTP method (e.g., "POST")
 * @param path             request path (e.g., "/charge")
 * @param body             request body as string (raw payload)
 * @param operation        function that performs the real work; returns {status, body}
 *
 * @returns HttpResponse   {status, content_type, body}
 *
 * Errors are returned as problem+json responses (400, 409, 422).
 * If the operation throws, the in‑progress record is removed and the error is re‑thrown.
 */
export async function handle(
  scope: string,
  idempotency_key: string | undefined,
  method: string,
  path: string,
  body: string,
  operation: Operation
): Promise<HttpResponse> {
  const now = new Date();

  // 1. missing key
  if (is_required(method, path) && (!idempotency_key || idempotency_key === "")) {
    return problemResponse(
      400,
      "Missing Idempotency-Key",
      "The request requires an Idempotency-Key header."
    );
  }

  const fp = fingerprint(method, path, body);
  const existing = _store.get(scope, idempotency_key ?? "");

  // Helper to treat expired records as absent
  const isExpired = (rec: IdempotencyRecord) => rec.expires_at.getTime() <= now.getTime();

  if (existing && isExpired(existing)) {
    // purge stale entry
    _store.delete(scope, idempotency_key!);
  }

  const record = _store.get(scope, idempotency_key!);

  // 2. Existing record handling
  if (record) {
    if (record.status === "in_progress") {
      // payload mismatch while in progress must be 422 per spec
      if (record.request_fingerprint !== fp) {
        return problemResponse(
          422,
          "Payload Mismatch",
          "The request payload differs from the original request."
        );
      }
      return problemResponse(
        409,
        "Request In Progress",
        "A request with this Idempotency-Key is still being processed."
      );
    }

    // completed
    if (record.request_fingerprint !== fp) {
      return problemResponse(
        422,
        "Payload Mismatch",
        "The request payload differs from the original request."
      );
    }

    // return stored response
    return {
      status: record.response_status!,
      content_type: "application/json",
      body: record.response_body!,
    };
  }

  // 3. No record – claim atomically
  const newRecord: IdempotencyRecord = {
    scope,
    idem_key: idempotency_key!,
    request_fingerprint: fp,
    status: "in_progress",
    created_at: now,
    expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 24h
  };
  _store.set(newRecord);

  // 4. Run operation
  try {
    const result = await Promise.resolve(operation());
    const responseBody = JSON.stringify(result.body);
    // update record
    newRecord.status = "completed";
    newRecord.response_status = result.status;
    newRecord.response_body = responseBody;
    _store.set(newRecord); // overwrite

    return {
      status: result.status,
      content_type: "application/json",
      body: responseBody,
    };
  } catch (e) {
    // delete in‑progress record then re‑throw
    _store.delete(scope, idempotency_key!);
    throw e;
  }
}

/**
 * Removes all expired records from the store.
 */
export function purge_expired(): void {
  const now = new Date();
  for (const rec of _store.entries()) {
    if (rec.expires_at.getTime() <= now.getTime()) {
      _store.delete(rec.scope, rec.idem_key);
    }
  }
}

/* Exported for test introspection only */
export const _test_store = _store;