import hashlib
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from typing import Optional, List, Callable, Any

DEFAULT_TTL_SECONDS = 86400

def ascii_upper(s: str) -> str:
    return ''.join(c.upper() if 'a' <= c <= 'z' else c for c in s)

def compute_fingerprint(method: str, path: str, body: str) -> str:
    m = ascii_upper(method or "")
    p = path or ""
    b = body or ""
    data = (m + " " + p + "\n" + b).encode("utf-8")
    return hashlib.sha256(data).hexdigest()

def _valid_key(key: str) -> bool:
    if not isinstance(key, str):
        return False
    if len(key) < 1 or len(key) > 255:
        return False
    return all(0x20 <= ord(c) <= 0x7E for c in key)

@dataclass
class IdempotencyOptions:
    clock: Callable[[], int] = field(default_factory=lambda: int(time.time()))
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    required_methods: tuple = ("POST", "PATCH")

    def __post_init__(self):
        if self.ttl_seconds < 1:
            raise IdempotencyError("INVALID_OPTIONS", 500, "ttl_seconds must be >= 1")
        self.required_methods = tuple(ascii_upper(m) for m in self.required_methods)

@dataclass
class IdempotencyRecord:
    scope: str
    idem_key: str
    request_fingerprint: str
    status: str
    response_status: Optional[int]
    response_body: Optional[str]
    created_at: int
    expires_at: int

class IdempotencyError(Exception):
    def __init__(self, code: str, status: int, message: str):
        self.code = code
        self.status = status
        self.message = message
        super().__init__(message)

class Store:
    def try_claim(self, record: IdempotencyRecord, now: int) -> bool:
        raise NotImplementedError
    def get(self, scope: str, idem_key: str) -> Optional[IdempotencyRecord]:
        raise NotImplementedError
    def complete(self, scope: str, idem_key: str, created_at: int, response_status: int, response_body: str) -> None:
        raise NotImplementedError
    def delete(self, scope: str, idem_key: str, created_at: int) -> None:
        raise NotImplementedError
    def purge_expired(self, now: int) -> int:
        raise NotImplementedError

class InMemoryStore(Store):
    def __init__(self):
        self._records = {}
        self._lock = threading.Lock()

    def try_claim(self, record: IdempotencyRecord, now: int) -> bool:
        with self._lock:
            key = (record.scope, record.idem_key)
            existing = self._records.get(key)
            if existing is None or existing.expires_at <= now:
                self._records[key] = IdempotencyRecord(
                    scope=record.scope,
                    idem_key=record.idem_key,
                    request_fingerprint=record.request_fingerprint,
                    status="in_progress",
                    response_status=None,
                    response_body=None,
                    created_at=record.created_at,
                    expires_at=record.expires_at
                )
                return True
            return False

    def get(self, scope: str, idem_key: str) -> Optional[IdempotencyRecord]:
        with self._lock:
            return self._records.get((scope, idem_key))

    def complete(self, scope: str, idem_key: str, created_at: int, response_status: int, response_body: str) -> None:
        with self._lock:
            key = (scope, idem_key)
            existing = self._records.get(key)
            if existing and existing.status == "in_progress" and existing.created_at == created_at:
                existing.status = "completed"
                existing.response_status = response_status
                existing.response_body = response_body

    def delete(self, scope: str, idem_key: str, created_at: int) -> None:
        with self._lock:
            key = (scope, idem_key)
            existing = self._records.get(key)
            if existing and existing.status == "in_progress" and existing.created_at == created_at:
                del self._records[key]

    def purge_expired(self, now: int) -> int:
        with self._lock:
            count = 0
            keys_to_delete = [k for k, v in self._records.items() if v.expires_at <= now]
            for k in keys_to_delete:
                del self._records[k]
                count += 1
            return count

class SqlStore(Store):
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn
        self._lock = threading.Lock()
        self.migrate()

    def migrate(self):
        with self._lock:
            self._conn.execute("""
                CREATE TABLE IF NOT EXISTS idempotency_records (
                    scope TEXT NOT NULL,
                    idem_key TEXT NOT NULL,
                    request_fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
                    response_status INTEGER NULL,
                    response_body TEXT NULL,
                    created_at BIGINT NOT NULL,
                    expires_at BIGINT NOT NULL,
                    PRIMARY KEY (scope, idem_key)
                )
            """)
            self._conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at
                ON idempotency_records (expires_at)
            """)
            self._conn.commit()

    def try_claim(self, record: IdempotencyRecord, now: int) -> bool:
        with self._lock:
            cursor = self._conn.execute("""
                INSERT INTO idempotency_records
                    (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at)
                VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?)
                ON CONFLICT (scope, idem_key) DO UPDATE SET
                    request_fingerprint = excluded.request_fingerprint,
                    status = 'in_progress',
                    response_status = NULL,
                    response_body = NULL,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at
                WHERE idempotency_records.expires_at <= ?
            """, (
                record.scope, record.idem_key, record.request_fingerprint,
                record.created_at, record.expires_at, now
            ))
            self._conn.commit()
            return cursor.rowcount == 1

    def get(self, scope: str, idem_key: str) -> Optional[IdempotencyRecord]:
        with self._lock:
            cursor = self._conn.execute("""
                SELECT scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at
                FROM idempotency_records WHERE scope = ? AND idem_key = ?
            """, (scope, idem_key))
            row = cursor.fetchone()
            if row is None:
                return None
            return IdempotencyRecord(
                scope=row[0], idem_key=row[1], request_fingerprint=row[2],
                status=row[3], response_status=row[4], response_body=row[5],
                created_at=row[6], expires_at=row[7]
            )

    def complete(self, scope: str, idem_key: str, created_at: int, response_status: int, response_body: str) -> None:
        with self._lock:
            cursor = self._conn.execute("""
                UPDATE idempotency_records
                SET status = 'completed', response_status = ?, response_body = ?
                WHERE scope = ? AND idem_key = ? AND created_at = ? AND status = 'in_progress'
            """, (response_status, response_body, scope, idem_key, created_at))
            self._conn.commit()

    def delete(self, scope: str, idem_key: str, created_at: int) -> None:
        with self._lock:
            cursor = self._conn.execute("""
                DELETE FROM idempotency_records
                WHERE scope = ? AND idem_key = ? AND created_at = ? AND status = 'in_progress'
            """, (scope, idem_key, created_at))
            self._conn.commit()

    def purge_expired(self, now: int) -> int:
        with self._lock:
            cursor = self._conn.execute("""
                DELETE FROM idempotency_records WHERE expires_at <= ?
            """, (now,))
            self._conn.commit()
            return cursor.rowcount

class IdempotencyService:
    def __init__(self, store: Store, options: Optional[IdempotencyOptions] = None):
        self._store = store
        if options is None:
            options = IdempotencyOptions()
        self._options = options

    def is_required(self, method: str, path: str) -> bool:
        return ascii_upper(method or "") in self._options.required_methods

    def purge_expired(self) -> int:
        return self._store.purge_expired(self._options.clock())

    def handle(self, scope: str, idempotency_key: Optional[str], method: str, path: str, body: Optional[str], operation: Callable[[], Any]) -> dict:
        M = ascii_upper(method or "")
        path = path or ""
        body = body or ""

        if M not in self._options.required_methods:
            r = operation()
            self._check_result(r)
            return {"status": r["status"], "content_type": "application/json", "body": r["body"]}

        if scope is None or scope == "":
            raise IdempotencyError("SCOPE_REQUIRED", 500, "scope is required")

        if idempotency_key is None or idempotency_key == "":
            return self._problem(400, "IDEMPOTENCY_KEY_MISSING")

        if not _valid_key(idempotency_key):
            return self._problem(400, "IDEMPOTENCY_KEY_INVALID")

        fp = compute_fingerprint(M, path, body)
        now = self._options.clock()
        rec = IdempotencyRecord(
            scope=scope, idem_key=idempotency_key, request_fingerprint=fp,
            status="in_progress", response_status=None, response_body=None,
            created_at=now, expires_at=now + self._options.ttl_seconds
        )

        for _ in range(2):
            if self._store.try_claim(rec, now):
                return self._run_claimed(rec, operation)
            ex = self._store.get(scope, idempotency_key)
            if ex is None or ex.expires_at <= now:
                continue
            if ex.request_fingerprint != fp:
                return self._problem(422, "IDEMPOTENCY_KEY_REUSED")
            if ex.status == "in_progress":
                return self._problem(409, "REQUEST_IN_PROGRESS")
            return {"status": ex.response_status, "content_type": "application/json", "body": ex.response_body}

        return self._problem(409, "REQUEST_IN_PROGRESS")

    def _run_claimed(self, rec: IdempotencyRecord, operation: Callable[[], Any]) -> dict:
        try:
            r = operation()
        except BaseException as err:
            try:
                self._store.delete(rec.scope, rec.idem_key, rec.created_at)
            except Exception:
                pass
            raise err

        self._check_result(r)
        self._store.complete(rec.scope, rec.idem_key, rec.created_at, r["status"], r["body"])
        return {"status": r["status"], "content_type": "application/json", "body": r["body"]}

    def _check_result(self, r: Any) -> None:
        if not isinstance(r, dict):
            raise IdempotencyError("INVALID_OPERATION_RESULT", 500, "operation result must be a dict")
        if "status" not in r or "body" not in r:
            raise IdempotencyError("INVALID_OPERATION_RESULT", 500, "operation result must have status and body")
        status = r["status"]
        if isinstance(status, bool) or not isinstance(status, int):
            raise IdempotencyError("INVALID_OPERATION_RESULT", 500, "status must be an integer")
        if status < 100 or status > 599:
            raise IdempotencyError("INVALID_OPERATION_RESULT", 500, "status must be between 100 and 599")
        if not isinstance(r["body"], str):
            raise IdempotencyError("INVALID_OPERATION_RESULT", 500, "body must be a string")

    def _problem(self, status: int, code: str) -> dict:
        bodies = {
            "IDEMPOTENCY_KEY_MISSING": '{"type":"https://developer.example.com/problems/idempotency-key-missing","title":"Idempotency-Key is missing","detail":"This operation requires an Idempotency-Key request header."}',
            "IDEMPOTENCY_KEY_INVALID": '{"type":"https://developer.example.com/problems/idempotency-key-invalid","title":"Idempotency-Key is invalid","detail":"An Idempotency-Key must be 1 to 255 printable ASCII characters."}',
            "IDEMPOTENCY_KEY_REUSED": '{"type":"https://developer.example.com/problems/idempotency-key-reused","title":"Idempotency-Key is already used","detail":"This Idempotency-Key was already used with a different request payload."}',
            "REQUEST_IN_PROGRESS": '{"type":"https://developer.example.com/problems/idempotency-request-outstanding","title":"A request is outstanding for this Idempotency-Key","detail":"A request with the same Idempotency-Key is still being processed. Retry later."}',
        }
        return {"status": status, "content_type": "application/problem+json", "body": bodies[code]}