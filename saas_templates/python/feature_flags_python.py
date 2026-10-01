import json
import hashlib
import sqlite3
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional, List, Dict, Union

REASON_STATIC = "STATIC"
REASON_DEFAULT = "DEFAULT"
REASON_TARGETING_MATCH = "TARGETING_MATCH"
REASON_SPLIT = "SPLIT"
REASON_DISABLED = "DISABLED"
REASON_ERROR = "ERROR"

ERROR_FLAG_NOT_FOUND = "FLAG_NOT_FOUND"
ERROR_TYPE_MISMATCH = "TYPE_MISMATCH"
ERROR_PARSE_ERROR = "PARSE_ERROR"
ERROR_GENERAL = "GENERAL"

FLAG_TYPE_BOOLEAN = "boolean"
FLAG_TYPE_STRING = "string"
FLAG_TYPE_NUMBER = "number"
FLAG_TYPE_OBJECT = "object"

AUDIT_ACTION_CREATE = "create"
AUDIT_ACTION_UPDATE = "update"


@dataclass(frozen=True)
class EvaluationDetails:
    flag_key: str
    value: Any
    variant: Optional[str]
    reason: str
    error_code: Optional[str]
    error_message: Optional[str]


@dataclass(frozen=True)
class FlagRecord:
    key: str
    type: str
    default_value_json: str
    enabled: bool
    rules_json: str
    updated_at: int
    updated_by: str


@dataclass(frozen=True)
class AuditEntry:
    id: int
    flag_key: str
    action: str
    old_value: Optional[str]
    new_value: str
    actor_id: str
    at: int


class FeatureFlagError(Exception):
    def __init__(self, code: str, status: int, message: str):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


class FlagStore(ABC):
    @abstractmethod
    def get_flag(self, key: str) -> Optional[FlagRecord]:
        pass

    @abstractmethod
    def put_flag(self, record: FlagRecord) -> None:
        pass

    @abstractmethod
    def save_flag_audited(self, record: FlagRecord, actor_id: str, at: int) -> AuditEntry:
        pass

    @abstractmethod
    def list_audit(self, flag_key: str) -> List[AuditEntry]:
        pass


class InMemoryFlagStore(FlagStore):
    def __init__(self):
        self._flags: Dict[str, FlagRecord] = {}
        self._audit: List[AuditEntry] = []
        self._next_id = 1
        self._lock = threading.Lock()

    def get_flag(self, key: str) -> Optional[FlagRecord]:
        with self._lock:
            return self._flags.get(key)

    def put_flag(self, record: FlagRecord) -> None:
        with self._lock:
            self._flags[record.key] = record

    def save_flag_audited(self, record: FlagRecord, actor_id: str, at: int) -> AuditEntry:
        with self._lock:
            previous = self._flags.get(record.key)
            old_snapshot = _snapshot(previous) if previous else None
            new_snapshot = _snapshot(record)
            entry = AuditEntry(
                id=self._next_id,
                flag_key=record.key,
                action=AUDIT_ACTION_UPDATE if previous else AUDIT_ACTION_CREATE,
                old_value=old_snapshot,
                new_value=new_snapshot,
                actor_id=actor_id,
                at=at,
            )
            self._next_id += 1
            self._flags[record.key] = record
            self._audit.append(entry)
            return entry

    def list_audit(self, flag_key: str) -> List[AuditEntry]:
        with self._lock:
            return [e for e in self._audit if e.flag_key == flag_key]


class SqlFlagStore(FlagStore):
    SCHEMA_STATEMENTS = (
        "CREATE TABLE IF NOT EXISTS feature_flags (key TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('boolean','string','number','object')), default_value TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), rules TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS flag_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, flag_key TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('create','update')), old_value TEXT, new_value TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS flag_audit_by_key ON flag_audit (flag_key, id)",
    )

    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        with self._lock:
            for stmt in self.SCHEMA_STATEMENTS:
                self._conn.execute(stmt)

    def get_flag(self, key: str) -> Optional[FlagRecord]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT key, type, default_value, enabled, rules, updated_at, updated_by FROM feature_flags WHERE key = ?",
                (key,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return FlagRecord(
                key=row[0],
                type=row[1],
                default_value_json=row[2],
                enabled=bool(row[3]),
                rules_json=row[4],
                updated_at=row[5],
                updated_by=row[6],
            )

    def put_flag(self, record: FlagRecord) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET type=excluded.type, default_value=excluded.default_value, enabled=excluded.enabled, rules=excluded.rules, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                (record.key, record.type, record.default_value_json, 1 if record.enabled else 0, record.rules_json, record.updated_at, record.updated_by),
            )

    def save_flag_audited(self, record: FlagRecord, actor_id: str, at: int) -> AuditEntry:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                cur = self._conn.execute(
                    "SELECT key, type, default_value, enabled, rules, updated_at, updated_by FROM feature_flags WHERE key = ?",
                    (record.key,),
                )
                row = cur.fetchone()
                previous = FlagRecord(key=row[0], type=row[1], default_value_json=row[2], enabled=bool(row[3]), rules_json=row[4], updated_at=row[5], updated_by=row[6]) if row else None
                old_snapshot = _snapshot(previous) if previous else None
                new_snapshot = _snapshot(record)
                self._conn.execute(
                    "INSERT INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET type=excluded.type, default_value=excluded.default_value, enabled=excluded.enabled, rules=excluded.rules, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                    (record.key, record.type, record.default_value_json, 1 if record.enabled else 0, record.rules_json, record.updated_at, record.updated_by),
                )
                cur = self._conn.execute(
                    "INSERT INTO flag_audit (flag_key, action, old_value, new_value, actor_id, at) VALUES (?, ?, ?, ?, ?, ?)",
                    (record.key, AUDIT_ACTION_UPDATE if previous else AUDIT_ACTION_CREATE, old_snapshot, new_snapshot, actor_id, at),
                )
                audit_id = cur.lastrowid
                self._conn.execute("COMMIT")
                return AuditEntry(id=audit_id, flag_key=record.key, action=AUDIT_ACTION_UPDATE if previous else AUDIT_ACTION_CREATE, old_value=old_snapshot, new_value=new_snapshot, actor_id=actor_id, at=at)
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def list_audit(self, flag_key: str) -> List[AuditEntry]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT id, flag_key, action, old_value, new_value, actor_id, at FROM flag_audit WHERE flag_key = ? ORDER BY id ASC",
                (flag_key,),
            )
            return [AuditEntry(id=row[0], flag_key=row[1], action=row[2], old_value=row[3], new_value=row[4], actor_id=row[5], at=row[6]) for row in cur.fetchall()]


@dataclass
class FeatureFlagOptions:
    clock: Optional[callable] = None


def _default_clock() -> int:
    return int(time.time())


def _snapshot(record: FlagRecord) -> str:
    return '{"type":' + json.dumps(record.type) + ',"default_value":' + record.default_value_json + ',"enabled":' + ('true' if record.enabled else 'false') + ',"rules":' + record.rules_json + '}'


def _parse_json_strict(text: str) -> Any:
    def parse_constant(constant: str):
        raise ValueError(f"Invalid JSON constant: {constant}")
    return json.loads(text, parse_constant=parse_constant)


def _kind(value: Any) -> Optional[str]:
    if isinstance(value, bool):
        return FLAG_TYPE_BOOLEAN
    if isinstance(value, str):
        return FLAG_TYPE_STRING
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value == float('inf') or value == float('-inf')):
            return None
        return FLAG_TYPE_NUMBER
    if isinstance(value, dict):
        return FLAG_TYPE_OBJECT
    if value is None:
        return None
    if isinstance(value, list):
        return None
    return None


def _scalar_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) and isinstance(b, bool):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return False


def _parse_rules(text: str) -> List[Dict[str, Any]]:
    rules = _parse_json_strict(text)
    if not isinstance(rules, list):
        raise ValueError("Rules must be an array")
    for rule in rules:
        if not isinstance(rule, dict):
            raise ValueError("Each rule must be an object")
        if "conditions" not in rule or not isinstance(rule["conditions"], list):
            raise ValueError("Rule must have conditions array")
        if "variant" not in rule or not isinstance(rule["variant"], str) or rule["variant"] == "":
            raise ValueError("Rule must have non-empty variant string")
        if "value" not in rule:
            raise ValueError("Rule must have value")
        rollout = rule.get("rollout")
        if rollout is not None:
            if not isinstance(rollout, dict):
                raise ValueError("Rollout must be an object or null")
            if "percentage" not in rollout:
                raise ValueError("Rollout must have percentage")
            pct = rollout["percentage"]
            if not isinstance(pct, (int, float)) or pct < 0 or pct > 100:
                raise ValueError("Percentage must be a number 0..100")
        for cond in rule["conditions"]:
            if not isinstance(cond, dict):
                raise ValueError("Condition must be an object")
            if "attribute" not in cond or not isinstance(cond["attribute"], str) or cond["attribute"] == "":
                raise ValueError("Condition must have non-empty attribute")
            if "operator" not in cond or cond["operator"] not in ("equals", "not_equals", "in_list", "ends_with"):
                raise ValueError("Invalid operator")
            if "value" not in cond:
                raise ValueError("Condition must have value")
            op = cond["operator"]
            val = cond["value"]
            if op in ("equals", "not_equals"):
                if val is None or isinstance(val, (dict, list)):
                    raise ValueError("Equals/not_equals value must be scalar")
            elif op == "in_list":
                if not isinstance(val, list):
                    raise ValueError("In_list value must be an array")
                for item in val:
                    if item is None or isinstance(item, (dict, list)):
                        raise ValueError("In_list items must be scalars")
            elif op == "ends_with":
                if not isinstance(val, str):
                    raise ValueError("Ends_with value must be a string")
    return rules


def _condition_matches(cond: Dict[str, Any], context: Dict[str, Any]) -> bool:
    attr = cond["attribute"]
    if attr not in context:
        return False
    x = context[attr]
    if x is None or isinstance(x, (dict, list)):
        return False
    op = cond["operator"]
    v = cond["value"]
    if op == "equals":
        return _scalar_equal(x, v)
    if op == "not_equals":
        return not _scalar_equal(x, v)
    if op == "in_list":
        return any(_scalar_equal(x, item) for item in v)
    if op == "ends_with":
        return isinstance(x, str) and x.endswith(v)
    return False


def stable_bucket(flag_key: str, targeting_key: str) -> int:
    hash_bytes = hashlib.sha256((flag_key + ":" + targeting_key).encode("utf-8")).digest()
    bucket = 0
    for i in range(8):
        bucket = (bucket * 256 + hash_bytes[i]) % 100
    return bucket


class FeatureFlagClient:
    def __init__(self, store: FlagStore, options: Optional[FeatureFlagOptions] = None):
        self._store = store
        self._clock = options.clock if options and options.clock else _default_clock

    def get_boolean_value(self, flag_key: str, default_value: bool, context: Optional[Dict[str, Any]] = None) -> bool:
        return self.get_boolean_details(flag_key, default_value, context).value

    def get_string_value(self, flag_key: str, default_value: str, context: Optional[Dict[str, Any]] = None) -> str:
        return self.get_string_details(flag_key, default_value, context).value

    def get_number_value(self, flag_key: str, default_value: float, context: Optional[Dict[str, Any]] = None) -> float:
        return self.get_number_details(flag_key, default_value, context).value

    def get_object_value(self, flag_key: str, default_value: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.get_object_details(flag_key, default_value, context).value

    def get_boolean_details(self, flag_key: str, default_value: bool, context: Optional[Dict[str, Any]] = None) -> EvaluationDetails:
        return self._evaluate(flag_key, FLAG_TYPE_BOOLEAN, default_value, context)

    def get_string_details(self, flag_key: str, default_value: str, context: Optional[Dict[str, Any]] = None) -> EvaluationDetails:
        return self._evaluate(flag_key, FLAG_TYPE_STRING, default_value, context)

    def get_number_details(self, flag_key: str, default_value: float, context: Optional[Dict[str, Any]] = None) -> EvaluationDetails:
        return self._evaluate(flag_key, FLAG_TYPE_NUMBER, default_value, context)

    def get_object_details(self, flag_key: str, default_value: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> EvaluationDetails:
        return self._evaluate(flag_key, FLAG_TYPE_OBJECT, default_value, context)

    def set_flag(self, actor_id: str, key: str, flag_type: str, default_value_json: str, enabled: bool, rules_json: str) -> AuditEntry:
        if not isinstance(actor_id, str) or actor_id == "":
            raise FeatureFlagError("INVALID_ACTOR", 400, "actor_id must be a non-empty string")
        if not isinstance(key, str) or not (1 <= len(key) <= 128) or not all(c.isalnum() or c in "._-" for c in key):
            raise FeatureFlagError("INVALID_KEY", 400, "key must be 1..128 chars [A-Za-z0-9_.-]")
        if flag_type not in (FLAG_TYPE_BOOLEAN, FLAG_TYPE_STRING, FLAG_TYPE_NUMBER, FLAG_TYPE_OBJECT):
            raise FeatureFlagError("INVALID_TYPE", 400, "flag_type must be boolean, string, number, or object")
        if not isinstance(enabled, bool):
            raise FeatureFlagError("INVALID_ENABLED", 400, "enabled must be a boolean")
        try:
            default_parsed = _parse_json_strict(default_value_json)
        except Exception as e:
            raise FeatureFlagError("INVALID_DEFAULT_VALUE", 400, f"default_value_json parse error: {e}")
        if _kind(default_parsed) != flag_type:
            raise FeatureFlagError("INVALID_DEFAULT_VALUE", 400, "default_value kind does not match flag_type")
        try:
            rules = _parse_rules(rules_json)
        except Exception as e:
            raise FeatureFlagError("INVALID_RULES", 400, f"rules_json parse error: {e}")
        for rule in rules:
            if _kind(rule["value"]) != flag_type:
                raise FeatureFlagError("INVALID_RULES", 400, "rule value kind does not match flag_type")
        now = self._clock()
        record = FlagRecord(key=key, type=flag_type, default_value_json=default_value_json, enabled=enabled, rules_json=rules_json, updated_at=now, updated_by=actor_id)
        try:
            return self._store.save_flag_audited(record, actor_id, now)
        except FeatureFlagError:
            raise
        except Exception as e:
            raise FeatureFlagError("STORE_ERROR", 500, f"store error: {e}")

    def _evaluate(self, flag_key: str, want_type: str, caller_default: Any, context: Optional[Dict[str, Any]]) -> EvaluationDetails:
        try:
            if context is None:
                context = {}
            elif not isinstance(context, dict):
                return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_ERROR, error_code=ERROR_GENERAL, error_message="context must be a map")
            rec = self._store.get_flag(flag_key)
            if rec is None:
                return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_ERROR, error_code=ERROR_FLAG_NOT_FOUND, error_message="flag not found")
            if rec.type != want_type:
                return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_ERROR, error_code=ERROR_TYPE_MISMATCH, error_message="type mismatch")
            if not rec.enabled:
                return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_DISABLED, error_code=None, error_message=None)
            try:
                rules = _parse_rules(rec.rules_json)
                stored_default = _parse_json_strict(rec.default_value_json)
            except Exception as e:
                return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_ERROR, error_code=ERROR_PARSE_ERROR, error_message=f"parse error: {e}")
            tk = context.get("targeting_key")
            if not isinstance(tk, str) or tk == "":
                tk = None
            for rule in rules:
                all_match = True
                for cond in rule["conditions"]:
                    if not _condition_matches(cond, context):
                        all_match = False
                        break
                if not all_match:
                    continue
                rollout = rule.get("rollout")
                if rollout is None:
                    return self._serve(rule["value"], rec.type, caller_default, REASON_TARGETING_MATCH, rule["variant"], flag_key)
                if tk is None:
                    continue
                pct = rollout["percentage"]
                if stable_bucket(flag_key, tk) < pct:
                    return self._serve(rule["value"], rec.type, caller_default, REASON_SPLIT, rule["variant"], flag_key)
            return self._serve(stored_default, rec.type, caller_default, REASON_DEFAULT, None, flag_key)
        except Exception as e:
            return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_ERROR, error_code=ERROR_GENERAL, error_message=str(e))

    def _serve(self, value: Any, flag_type: str, caller_default: Any, reason: str, variant: Optional[str], flag_key: str) -> EvaluationDetails:
        if _kind(value) != flag_type:
            return EvaluationDetails(flag_key=flag_key, value=caller_default, variant=None, reason=REASON_ERROR, error_code=ERROR_TYPE_MISMATCH, error_message="served value type mismatch")
        return EvaluationDetails(flag_key=flag_key, value=value, variant=variant, reason=reason, error_code=None, error_message=None)


SCHEMA_STATEMENTS = SqlFlagStore.SCHEMA_STATEMENTS