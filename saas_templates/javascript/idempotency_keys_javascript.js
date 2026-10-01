const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

class IdempotencyStore {
  async claim(scope, idemKey, fingerprint, expiresAt) {
    throw new Error('Not implemented');
  }
  async get(scope, idemKey) {
    throw new Error('Not implemented');
  }
  async complete(scope, idemKey, status, body) {
    throw new Error('Not implemented');
  }
  async deleteInProgress(scope, idemKey) {
    throw new Error('Not implemented');
  }
  async purgeExpired() {
    throw new Error('Not implemented');
  }
}

class InMemoryStore extends IdempotencyStore {
  constructor() {
    super();
    this.records = new Map();
  }

  _key(scope, idemKey) {
    return `${scope}:${idemKey}`;
  }

  async claim(scope, idemKey, fingerprint, expiresAt) {
    const key = this._key(scope, idemKey);
    const existing = this.records.get(key);
    const now = Date.now();

    if (existing) {
      if (existing.status === 'in_progress') {
        return { claimed: false, reason: 'in_progress', record: existing };
      }
      if (existing.status === 'completed') {
        if (existing.expires_at > now) {
          if (existing.request_fingerprint !== fingerprint) {
            return { claimed: false, reason: 'payload_mismatch', record: existing };
          }
          return { claimed: false, reason: 'completed', record: existing };
        }
      }
    }

    const record = {
      scope,
      idem_key: idemKey,
      request_fingerprint: fingerprint,
      status: 'in_progress',
      response_status: null,
      response_body: null,
      created_at: now,
      expires_at: expiresAt
    };
    this.records.set(key, record);
    return { claimed: true, record };
  }

  async get(scope, idemKey) {
    const key = this._key(scope, idemKey);
    const record = this.records.get(key);
    if (!record) return null;
    const now = Date.now();
    if (record.expires_at <= now) {
      this.records.delete(key);
      return null;
    }
    return record;
  }

  async complete(scope, idemKey, status, body) {
    const key = this._key(scope, idemKey);
    const record = this.records.get(key);
    if (record && record.status === 'in_progress') {
      record.status = 'completed';
      record.response_status = status;
      record.response_body = body;
    }
  }

  async deleteInProgress(scope, idemKey) {
    const key = this._key(scope, idemKey);
    const record = this.records.get(key);
    if (record && record.status === 'in_progress') {
      this.records.delete(key);
    }
  }

  async purgeExpired() {
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (record.expires_at <= now) {
        this.records.delete(key);
      }
    }
  }
}

class SqliteStore extends IdempotencyStore {
  constructor(dbPath = ':memory:') {
    super();
    this.db = new DatabaseSync(dbPath);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        scope TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
        response_status INTEGER,
        response_body TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, idem_key)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_expires_at ON idempotency_records(expires_at)`);
  }

  async claim(scope, idemKey, fingerprint, expiresAt) {
    const now = Date.now();
    const selectStmt = this.db.prepare('SELECT * FROM idempotency_records WHERE scope = ? AND idem_key = ?');
    const existing = selectStmt.get(scope, idemKey);

    if (existing) {
      if (existing.status === 'in_progress') {
        return { claimed: false, reason: 'in_progress', record: existing };
      }
      if (existing.status === 'completed') {
        if (existing.expires_at > now) {
          if (existing.request_fingerprint !== fingerprint) {
            return { claimed: false, reason: 'payload_mismatch', record: existing };
          }
          return { claimed: false, reason: 'completed', record: existing };
        }
      }
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at)
      VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?)
      ON CONFLICT(scope, idem_key) DO UPDATE SET
        request_fingerprint = excluded.request_fingerprint,
        status = 'in_progress',
        response_status = NULL,
        response_body = NULL,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
      WHERE idempotency_records.expires_at <= excluded.created_at
    `);

    const result = insertStmt.run(scope, idemKey, fingerprint, now, expiresAt);

    if (result.changes === 0) {
      const recheck = selectStmt.get(scope, idemKey);
      if (recheck && recheck.status === 'in_progress') {
        return { claimed: false, reason: 'in_progress', record: recheck };
      }
      if (recheck && recheck.status === 'completed') {
        if (recheck.expires_at > now) {
          if (recheck.request_fingerprint !== fingerprint) {
            return { claimed: false, reason: 'payload_mismatch', record: recheck };
          }
          return { claimed: false, reason: 'completed', record: recheck };
        }
      }
      return { claimed: true, record: { scope, idem_key: idemKey, request_fingerprint: fingerprint, status: 'in_progress', created_at: now, expires_at: expiresAt } };
    }

    return { claimed: true, record: { scope, idem_key: idemKey, request_fingerprint: fingerprint, status: 'in_progress', created_at: now, expires_at: expiresAt } };
  }

  async get(scope, idemKey) {
    const now = Date.now();
    const stmt = this.db.prepare('SELECT * FROM idempotency_records WHERE scope = ? AND idem_key = ? AND expires_at > ?');
    const record = stmt.get(scope, idemKey, now);
    return record || null;
  }

  async complete(scope, idemKey, status, body) {
    const stmt = this.db.prepare(`
      UPDATE idempotency_records
      SET status = 'completed', response_status = ?, response_body = ?
      WHERE scope = ? AND idem_key = ? AND status = 'in_progress'
    `);
    stmt.run(status, body, scope, idemKey);
  }

  async deleteInProgress(scope, idemKey) {
    const stmt = this.db.prepare('DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ? AND status = ?');
    stmt.run(scope, idemKey, 'in_progress');
  }

  async purgeExpired() {
    const now = Date.now();
    const stmt = this.db.prepare('DELETE FROM idempotency_records WHERE expires_at <= ?');
    stmt.run(now);
  }

  close() {
    this.db.close();
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDEMPOTENT_METHODS = new Set(['POST', 'PATCH']);

function computeFingerprint(method, path, body) {
  const bodyStr = body === undefined || body === null ? '' : JSON.stringify(body);
  const input = `${method} ${path}\n${bodyStr}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

function problemResponse(status, title, detail) {
  return {
    status,
    content_type: 'application/problem+json',
    body: JSON.stringify({ type: `https://developer.example.com/idempotency#${title.toLowerCase().replace(/\s+/g, '-')}`, title, detail })
  };
}

function isRequired(method, path, config = {}) {
  const methods = config.idempotentMethods || DEFAULT_IDEMPOTENT_METHODS;
  return methods.has(method.toUpperCase());
}

async function handle(scope, idempotencyKey, method, path, body, operation, config = {}) {
  const ttl = config.ttlMs || DEFAULT_TTL_MS;
  const store = config.store;
  const expiresAt = Date.now() + ttl;

  if (!idempotencyKey) {
    if (isRequired(method, path, config)) {
      return problemResponse(400, 'Missing Idempotency Key', 'The Idempotency-Key header is required for this operation');
    }
    const result = await operation();
    const responseBody = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      status: result.status,
      content_type: 'application/json',
      body: responseBody
    };
  }

  const fingerprint = computeFingerprint(method, path, body);
  const claimResult = await store.claim(scope, idempotencyKey, fingerprint, expiresAt);

  if (!claimResult.claimed) {
    if (claimResult.reason === 'in_progress') {
      return problemResponse(409, 'Conflict', 'Request with this idempotency key is already in progress');
    }
    if (claimResult.reason === 'payload_mismatch') {
      return problemResponse(422, 'Unprocessable Content', 'Idempotency key reused with different request payload');
    }
    if (claimResult.reason === 'completed') {
      const record = claimResult.record;
      return {
        status: record.response_status,
        content_type: 'application/json',
        body: record.response_body
      };
    }
  }

  try {
    const result = await operation();
    const responseBody = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    await store.complete(scope, idempotencyKey, result.status, responseBody);
    return {
      status: result.status,
      content_type: 'application/json',
      body: responseBody
    };
  } catch (error) {
    await store.deleteInProgress(scope, idempotencyKey);
    throw error;
  }
}

async function purgeExpired(config = {}) {
  await config.store.purgeExpired();
}

module.exports = {
  IdempotencyStore,
  InMemoryStore,
  SqliteStore,
  computeFingerprint,
  isRequired,
  handle,
  purgeExpired,
  problemResponse,
  DEFAULT_TTL_MS,
  DEFAULT_IDEMPOTENT_METHODS
};