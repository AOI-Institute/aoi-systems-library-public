import { test } from "node:test";
import assert from "node:assert";
import {
  handle,
  is_required,
  purge_expired,
  _test_store,
} from "./idempotency_keys_typescript.ts";

type OpResult = { status: number; body: any };

function makeOp(counter: { count: number }, succeed = true, delay = 0) {
  return () => {
    if (delay > 0) {
      return new Promise<OpResult>((resolve, reject) => {
        setTimeout(() => {
          if (succeed) {
            counter.count++;
            resolve({ status: 200, body: { msg: "ok", count: counter.count } });
          } else {
            reject(new Error("operation failed"));
          }
        }, delay);
      });
    } else {
      if (!succeed) throw new Error("operation failed");
      counter.count++;
      return { status: 200, body: { msg: "ok", count: counter.count } };
    }
  };
}

/* Helper to parse problem+json body */
function parseProblem(body: string) {
  return JSON.parse(body);
}

/* 1. first call runs the operation once */
test("first call runs operation once", async () => {
  const counter = { count: 0 };
  const resp = await handle(
    "userA",
    "key-1",
    "POST",
    "/test",
    "payload",
    makeOp(counter)
  );
  assert.strictEqual(counter.count, 1);
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(resp.content_type, "application/json");
  const parsed = JSON.parse(resp.body);
  assert.strictEqual(parsed.msg, "ok");
});

/* 2. second identical call returns stored response */
test("second identical call returns stored response", async () => {
  const counter = { count: 0 };
  const op = makeOp(counter);
  const first = await handle("userB", "key-2", "POST", "/test", "payload", op);
  const second = await handle("userB", "key-2", "POST", "/test", "payload", op);
  assert.strictEqual(counter.count, 1);
  assert.deepStrictEqual(first.body, second.body);
});

/* 3. same key, different body -> 422 */
test("same key, different body yields 422", async () => {
  const counter = { count: 0 };
  const op = makeOp(counter);
  await handle("userC", "key-3", "POST", "/test", "payload1", op);
  const resp = await handle(
    "userC",
    "key-3",
    "POST",
    "/test",
    "different",
    op
  );
  assert.strictEqual(resp.status, 422);
  assert.strictEqual(resp.content_type, "application/problem+json");
  const prob = parseProblem(resp.body);
  assert.strictEqual(prob.title, "Payload Mismatch");
});

/* 4. same key while first is in progress -> 409 */
test("concurrent request while in progress yields 409", async () => {
  const counter = { count: 0 };
  const op = makeOp(counter, true, 100); // 100ms delay
  const firstPromise = handle(
    "userD",
    "key-4",
    "POST",
    "/test",
    "payload",
    op
  );
  // fire second request immediately
  const secondResp = await handle(
    "userD",
    "key-4",
    "POST",
    "/test",
    "payload",
    op
  );
  const second = secondResp;
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.content_type, "application/problem+json");
  const prob = parseProblem(second.body);
  assert.strictEqual(prob.title, "Request In Progress");
  await firstPromise; // ensure cleanup
});

/* 5. required operation with no key -> 400 */
test("missing key on required operation yields 400", async () => {
  const counter = { count: 0 };
  const resp = await handle(
    "userE",
    undefined,
    "POST",
    "/test",
    "payload",
    makeOp(counter)
  );
  assert.strictEqual(resp.status, 400);
  assert.strictEqual(resp.content_type, "application/problem+json");
  const prob = parseProblem(resp.body);
  assert.strictEqual(prob.title, "Missing Idempotency-Key");
});

/* 6. same key under different scopes runs twice */
test("same key under different scopes are independent", async () => {
  const counter = { count: 0 };
  const op = makeOp(counter);
  await handle("scope1", "shared-key", "POST", "/test", "payload", op);
  await handle("scope2", "shared-key", "POST", "/test", "payload", op);
  assert.strictEqual(counter.count, 2);
});

/* 7. expired key runs operation again */
test("expired key allows re‑execution", async () => {
  const counter = { count: 0 };
  const op = makeOp(counter);
  await handle("userF", "key-5", "POST", "/test", "payload", op);
  // force expiration
  const rec = _test_store.get("userF", "key-5");
  assert.ok(rec);
  rec.expires_at = new Date(Date.now() - 1000);
  purge_expired();
  await handle("userF", "key-5", "POST", "/test", "payload", op);
  assert.strictEqual(counter.count, 2);
});

/* 8. operation that throws frees the key */
test("failed operation frees the key for retry", async () => {
  const counter = { count: 0 };
  const failingOp = makeOp(counter, false);
  try {
    await handle("userG", "key-6", "POST", "/test", "payload", failingOp);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof Error);
  }
  // retry with a successful op
  const successOp = makeOp(counter);
  const resp = await handle("userG", "key-6", "POST", "/test", "payload", successOp);
  assert.strictEqual(counter.count, 1);
  assert.strictEqual(resp.status, 200);
});

/* 9. error responses have correct content type and fields */
test("error responses conform to problem+json spec", async () => {
  const counter = { count: 0 };
  const op = makeOp(counter);
  // 400 case
  const r400 = await handle("userH", undefined, "POST", "/test", "p", op);
  assert.strictEqual(r400.content_type, "application/problem+json");
  const p400 = parseProblem(r400.body);
  assert.ok(p400.type);
  assert.ok(p400.title);
  assert.ok(p400.detail);
  // 422 case
  await handle("userH", "k7", "POST", "/test", "a", op);
  const r422 = await handle("userH", "k7", "POST", "/test", "b", op);
  assert.strictEqual(r422.content_type, "application/problem+json");
  const p422 = parseProblem(r422.body);
  assert.ok(p422.type);
  assert.ok(p422.title);
  assert.ok(p422.detail);
  // 409 case (use delayed op)
  const delayedOp = makeOp(counter, true, 100);
  const p1 = handle("userI", "k8", "POST", "/test", "c", delayedOp);
  const r409 = await handle("userI", "k8", "POST", "/test", "c", delayedOp);
  assert.strictEqual(r409.status, 409);
  assert.strictEqual(r409.content_type, "application/problem+json");
  const p409 = parseProblem(r409.body);
  assert.ok(p409.type);
  assert.ok(p409.title);
  assert.ok(p409.detail);
  await p1; // cleanup
});