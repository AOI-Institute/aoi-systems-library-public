import sqlite3
import json
import uuid
import time
from datetime import datetime, timedelta, timezone
import threading

class BackgroundJobSystem:
    def __init__(self, db_path="background_jobs.db"):
        self.db_path = db_path
        self._handlers = {}
        self._worker_thread = None
        self._stop_event = threading.Event()
        self._init_db()
        self._register_default_handlers()

    def _get_conn(self):
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_conn() as conn:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                task_type TEXT NOT NULL,
                params TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                progress TEXT,
                result TEXT,
                error TEXT,
                retry_count INTEGER DEFAULT 0,
                max_retries INTEGER DEFAULT 3,
                next_retry_at TEXT,
                scheduled_at TEXT
            )
            """)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS job_runs (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                result TEXT,
                FOREIGN KEY(job_id) REFERENCES jobs(id)
            )
            """)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL
            )
            """)
            conn.commit()

    def register_handler(self, task_type, handler_func):
        self._handlers[task_type] = handler_func

    def _register_default_handlers(self):
        self.register_handler("send_bulk_email", self._send_bulk_email_handler)
        self.register_handler("webhook_retry", self._webhook_retry_handler)
        self.register_handler("export_generate", self._export_generate_handler)
        self.register_handler("daily_report", self._daily_report_handler)
        self.register_handler("cleanup_old_sessions", self._cleanup_old_sessions_handler)
        self.register_handler("delete_user_cascade", self._delete_user_cascade_handler)

    def enqueue_job(self, task_type, params, scheduled_at=None, max_retries=3):
        job_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        status = "enqueued"
        params_str = json.dumps(params)

        with self._get_conn() as conn:
            conn.execute("""
                INSERT INTO jobs (id, task_type, params, status, created_at, max_retries, scheduled_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (job_id, task_type, params_str, status, now, max_retries, scheduled_at))
            conn.commit()

        return {"success": True, "job_id": job_id, "status": status}

    def get_job_status(self, job_id):
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise ValueError(f"Job {job_id} not found")

            return {
                "job_id": row["id"],
                "task_type": row["task_type"],
                "status": row["status"],
                "progress": row["progress"],
                "created_at": row["created_at"],
                "started_at": row["started_at"],
                "result": json.loads(row["result"]) if row["result"] else None,
                "next_retry_at": row["next_retry_at"]
            }

    def list_jobs(self, status=None, task_type=None, limit=10):
        query = "SELECT * FROM jobs WHERE 1=1"
        count_query = "SELECT COUNT(*) FROM jobs WHERE 1=1"
        args = []

        if status:
            query += " AND status = ?"
            count_query += " AND status = ?"
            args.append(status)
        if task_type:
            query += " AND task_type = ?"
            count_query += " AND task_type = ?"
            args.append(task_type)

        query += " ORDER BY created_at DESC LIMIT ?"
        args_with_limit = args + [limit]

        with self._get_conn() as conn:
            total = conn.execute(count_query, args).fetchone()[0]
            rows = conn.execute(query, args_with_limit).fetchall()

            jobs = []
            for row in rows:
                jobs.append({
                    "job_id": row["id"],
                    "task_type": row["task_type"],
                    "status": row["status"],
                    "progress": row["progress"],
                    "created_at": row["created_at"],
                    "started_at": row["started_at"],
                    "result": json.loads(row["result"]) if row["result"] else None,
                    "next_retry_at": row["next_retry_at"]
                })

            return {"jobs": jobs, "total": total}

    def cancel_job(self, job_id):
        with self._get_conn() as conn:
            row = conn.execute("SELECT status FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise ValueError(f"Job {job_id} not found")
            if row["status"] != "enqueued":
                raise ValueError("Cannot cancel job that has already started or completed")

            conn.execute("UPDATE jobs SET status = 'cancelled' WHERE id = ?", (job_id,))
            conn.commit()

        return {"success": True, "status": "cancelled"}

    def retry_job(self, job_id):
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise ValueError(f"Job {job_id} not found")

            new_job_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()

            conn.execute("""
                INSERT INTO jobs (id, task_type, params, status, created_at, max_retries)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (new_job_id, row["task_type"], row["params"], "enqueued", now, row["max_retries"]))
            conn.commit()

        return {"success": True, "new_job_id": new_job_id, "status": "enqueued"}

    def get_job_results(self, job_id):
        with self._get_conn() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                raise ValueError(f"Job {job_id} not found")

            res = json.loads(row["result"]) if row["result"] else None
            return {
                "job_id": row["id"],
                "status": row["status"],
                "result": res,
                "completed_at": row["completed_at"]
            }

    def start_worker(self):
        if self._worker_thread and self._worker_thread.is_alive():
            return
        self._stop_event.clear()
        self._worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker_thread.start()

    def stop_worker(self):
        self._stop_event.set()
        if self._worker_thread:
            self._worker_thread.join(timeout=5)

    def _worker_loop(self):
        while not self._stop_event.is_set():
            job = self._claim_next_job()
            if job:
                self._execute_job(job)
            else:
                self._stop_event.wait(0.05)

    def _claim_next_job(self):
        now = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE TRANSACTION")
            row = conn.execute("""
                SELECT id, task_type, params, retry_count, max_retries FROM jobs
                WHERE status = 'enqueued'
                  AND (scheduled_at IS NULL OR scheduled_at <= ?)
                  AND (next_retry_at IS NULL OR next_retry_at <= ?)
                LIMIT 1
            """, (now, now)).fetchone()

            if row:
                job_id = row["id"]
                conn.execute("""
                    UPDATE jobs 
                    SET status = 'running', started_at = ?, progress = '0/100'
                    WHERE id = ?
                """, (now, job_id))
                conn.commit()
                return {
                    "id": row["id"],
                    "task_type": row["task_type"],
                    "params": json.loads(row["params"]),
                    "retry_count": row["retry_count"],
                    "max_retries": row["max_retries"]
                }
            else:
                conn.commit()
                return None
        except Exception:
            conn.rollback()
            return None
        finally:
            conn.close()

    def _execute_job(self, job):
        job_id = job["id"]
        task_type = job["task_type"]
        params = job["params"]
        retry_count = job["retry_count"]
        max_retries = job["max_retries"]

        started_at = datetime.now(timezone.utc).isoformat()

        def progress_callback(current, total):
            progress_str = f"{current}/{total}"
            with self._get_conn() as conn:
                conn.execute("UPDATE jobs SET progress = ? WHERE id = ?", (progress_str, job_id))
                conn.commit()

        handler = self._handlers.get(task_type)
        if not handler:
            self._handle_failure(job_id, f"No handler registered for task type: {task_type}", retry_count, max_retries, started_at)
            return

        try:
            result = handler(params, progress_callback)
            completed_at = datetime.now(timezone.utc).isoformat()
            result_str = json.dumps(result)

            with self._get_conn() as conn:
                conn.execute("""
                    UPDATE jobs 
                    SET status = 'completed', completed_at = ?, result = ?, error = NULL
                    WHERE id = ?
                """, (completed_at, result_str, job_id))

                run_id = str(uuid.uuid4())
                conn.execute("""
                    INSERT INTO job_runs (id, job_id, status, started_at, completed_at, result)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (run_id, job_id, "completed", started_at, completed_at, result_str))
                conn.commit()

        except Exception as e:
            self._handle_failure(job_id, str(e), retry_count, max_retries, started_at)

    def _handle_failure(self, job_id, error_msg, retry_count, max_retries, started_at):
        completed_at = datetime.now(timezone.utc).isoformat()

        if retry_count < max_retries:
            backoff_seconds = 2 ** retry_count
            next_retry = datetime.now(timezone.utc) + timedelta(seconds=backoff_seconds)
            next_retry_at = next_retry.isoformat()
            new_retry_count = retry_count + 1

            with self._get_conn() as conn:
                conn.execute("""
                    UPDATE jobs 
                    SET status = 'enqueued', retry_count = ?, next_retry_at = ?, error = ?
                    WHERE id = ?
                """, (new_retry_count, next_retry_at, error_msg, job_id))

                run_id = str(uuid.uuid4())
                conn.execute("""
                    INSERT INTO job_runs (id, job_id, status, started_at, completed_at, result)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (run_id, job_id, "failed", started_at, completed_at, json.dumps({"error": error_msg})))
                conn.commit()
        else:
            with self._get_conn() as conn:
                conn.execute("""
                    UPDATE jobs 
                    SET status = 'failed', completed_at = ?, error = ?
                    WHERE id = ?
                """, (completed_at, error_msg, job_id))

                run_id = str(uuid.uuid4())
                conn.execute("""
                    INSERT INTO job_runs (id, job_id, status, started_at, completed_at, result)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (run_id, job_id, "failed", started_at, completed_at, json.dumps({"error": error_msg})))
                conn.commit()

    def _send_bulk_email_handler(self, params, progress_callback):
        emails = params.get("emails", [])
        if not emails:
            emails = [f"user{i}@example.com" for i in range(10)]

        total = len(emails)
        sent = 0
        failed = 0
        skipped = 0
        errors = []

        for idx, email in enumerate(emails):
            if "fail" in email:
                failed += 1
                errors