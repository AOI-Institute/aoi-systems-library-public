import sqlite3
import threading
import time
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable, Optional, Dict, Any, List, Tuple
from datetime import datetime, timezone


@dataclass
class HealthCheck:
    component_id: str
    component_type: str
    check_fn: Callable[[], Dict[str, Any]]
    critical: bool
    timeout_ms: int


class HealthCheckStore(ABC):
    @abstractmethod
    def add_check(self, check: HealthCheck) -> None:
        pass

    @abstractmethod
    def get_all_checks(self) -> List[HealthCheck]:
        pass

    @abstractmethod
    def clear(self) -> None:
        pass


class InMemoryHealthCheckStore(HealthCheckStore):
    def __init__(self):
        self._checks: Dict[Tuple[str, str], HealthCheck] = {}
        self._lock = threading.Lock()

    def add_check(self, check: HealthCheck) -> None:
        with self._lock:
            self._checks[(check.component_id, check.component_type)] = check

    def get_all_checks(self) -> List[HealthCheck]:
        with self._lock:
            return list(self._checks.values())

    def clear(self) -> None:
        with self._lock:
            self._checks.clear()


class SqliteHealthCheckStore(HealthCheckStore):
    def __init__(self, db_path: str = ":memory:"):
        self._db_path = db_path
        self._local = threading.local()
        self._init_lock = threading.Lock()
        self._initialized = False
        self._checks_cache: Dict[Tuple[str, str], HealthCheck] = {}
        self._cache_lock = threading.Lock()

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, 'conn') or self._local.conn is None:
            if self._db_path == ":memory:":
                conn = sqlite3.connect("file::memory:?cache=shared", uri=True, check_same_thread=False)
            else:
                conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
            with self._init_lock:
                if not self._initialized:
                    self._init_schema(conn)
                    self._initialized = True
        return self._local.conn

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS health_checks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                component_id TEXT NOT NULL,
                component_type TEXT NOT NULL,
                check_fn_pickle BLOB,
                critical INTEGER NOT NULL,
                timeout_ms INTEGER NOT NULL,
                UNIQUE(component_id, component_type)
            )
        """)
        conn.commit()

    def add_check(self, check: HealthCheck) -> None:
        with self._cache_lock:
            self._checks_cache[(check.component_id, check.component_type)] = check
        
        conn = self._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO health_checks (component_id, component_type, check_fn_pickle, critical, timeout_ms) VALUES (?, ?, ?, ?, ?)",
            (check.component_id, check.component_type, b'', int(check.critical), check.timeout_ms)
        )
        conn.commit()

    def get_all_checks(self) -> List[HealthCheck]:
        with self._cache_lock:
            return list(self._checks_cache.values())

    def clear(self) -> None:
        with self._cache_lock:
            self._checks_cache.clear()
        conn = self._get_conn()
        conn.execute("DELETE FROM health_checks")
        conn.commit()


_DEFAULT_STORE: HealthCheckStore = InMemoryHealthCheckStore()
_STORE_LOCK = threading.Lock()


def _get_store() -> HealthCheckStore:
    global _DEFAULT_STORE
    with _STORE_LOCK:
        return _DEFAULT_STORE


def set_store(store: HealthCheckStore) -> None:
    global _DEFAULT_STORE
    with _STORE_LOCK:
        _DEFAULT_STORE = store


def register_check(component_id: str, component_type: str, check_fn: Callable[[], Dict[str, Any]], critical: bool, timeout_ms: int) -> None:
    check = HealthCheck(
        component_id=component_id,
        component_type=component_type,
        check_fn=check_fn,
        critical=critical,
        timeout_ms=timeout_ms
    )
    _get_store().add_check(check)


def _run_check_with_timeout(check: HealthCheck) -> Dict[str, Any]:
    result_container = {"result": None, "error": None}
    
    def target():
        try:
            result_container["result"] = check.check_fn()
        except Exception as e:
            result_container["error"] = e
    
    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout=check.timeout_ms / 1000.0)
    
    if thread.is_alive():
        return {
            "componentId": check.component_id,
            "componentType": check.component_type,
            "observedValue": None,
            "observedUnit": "ms",
            "status": "fail",
            "time": datetime.now(timezone.utc).isoformat()
        }
    
    if result_container["error"]:
        return {
            "componentId": check.component_id,
            "componentType": check.component_type,
            "observedValue": None,
            "observedUnit": "ms",
            "status": "fail",
            "time": datetime.now(timezone.utc).isoformat()
        }
    
    check_result = result_container["result"]
    if not isinstance(check_result, dict):
        check_result = {}
    
    status = check_result.get("status", "pass")
    if status not in ("pass", "fail", "warn"):
        status = "fail"
    
    return {
        "componentId": check.component_id,
        "componentType": check.component_type,
        "observedValue": check_result.get("observedValue"),
        "observedUnit": check_result.get("observedUnit", "ms"),
        "status": status,
        "time": datetime.now(timezone.utc).isoformat()
    }


def _build_response(status: str, checks: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    if status == "fail":
        http_status = 503
    else:
        http_status = 200
    
    body = {
        "status": status,
        "version": "1.0",
        "serviceId": "health-service",
        "checks": checks
    }
    
    return {
        "http_status": http_status,
        "content_type": "application/health+json",
        "body": body
    }


def liveness() -> Dict[str, Any]:
    return _build_response("pass", {})


def readiness() -> Dict[str, Any]:
    checks = _get_store().get_all_checks()
    check_results: Dict[str, List[Dict[str, Any]]] = {}
    has_critical_fail = False
    has_non_critical_fail = False
    
    for check in checks:
        result = _run_check_with_timeout(check)
        key = f"{check.component_id}:{check.component_type}"
        check_results[key] = [result]
        
        if result["status"] == "fail":
            if check.critical:
                has_critical_fail = True
            else:
                has_non_critical_fail = True
    
    if has_critical_fail:
        overall_status = "fail"
    elif has_non_critical_fail:
        overall_status = "warn"
    else:
        overall_status = "pass"
    
    return _build_response(overall_status, check_results)