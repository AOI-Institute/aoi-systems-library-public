use chrono::{DateTime, Duration, Utc};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension, Row, ToSql, NO_PARAMS};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;
use tokio::time::{sleep, Instant};

pub type DbPool = Pool<SqliteConnectionManager>;

#[derive(Debug, Error)]
pub enum JobError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Task execution error: {0}")]
    Task(String),
    #[error("Job not found")]
    NotFound,
    #[error("Invalid operation: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Enqueued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: i64,
    pub task_type: String,
    pub params: JsonValue,
    pub status: JobStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub progress: Option<String>,
    pub result: Option<JsonValue>,
    pub error: Option<String>,
    pub retry_count: i32,
    pub max_retries: i32,
    pub next_retry_at: Option<DateTime<Utc>>,
    pub scheduled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRun {
    pub id: i64,
    pub job_id: i64,
    pub status: JobStatus,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub result: Option<JsonValue>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EnqueueRequest {
    pub task_type: String,
    pub params: JsonValue,
    #[serde(default)]
    pub scheduled_at: Option<DateTime<Utc>>,
    #[serde(default = "default_max_retries")]
    pub max_retries: i32,
}

fn default_max_retries() -> i32 {
    3
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EnqueueResponse {
    pub success: bool,
    pub job_id: i64,
    pub status: JobStatus,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CancelResponse {
    pub success: bool,
    pub status: JobStatus,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RetryResponse {
    pub success: bool,
    pub new_job_id: i64,
    pub status: JobStatus,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResultResponse {
    pub job_id: i64,
    pub status: JobStatus,
    pub result: JsonValue,
    pub completed_at: DateTime<Utc>,
}

pub struct JobQueue {
    pool: DbPool,
    // Mutex to serialize progress updates per job
    progress_locks: Arc<Mutex<HashMap<i64, Arc<Mutex<()>>>>>,
}

impl JobQueue {
    pub fn new(pool: DbPool) -> Result<Self, JobError> {
        let q = JobQueue {
            pool,
            progress_locks: Arc::new(Mutex::new(HashMap::new())),
        };
        q.run_migrations()?;
        Ok(q)
    }

    fn conn(&self) -> Result<PooledConnection<SqliteConnectionManager>, JobError> {
        Ok(self.pool.get()?)
    }

    fn run_migrations(&self) -> Result<(), JobError> {
        let conn = self.conn()?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                task_type       TEXT NOT NULL,
                params          TEXT NOT NULL,
                status          TEXT NOT NULL,
                created_at      TEXT NOT NULL,
                started_at      TEXT,
                completed_at    TEXT,
                progress        TEXT,
                result          TEXT,
                error           TEXT,
                retry_count     INTEGER NOT NULL DEFAULT 0,
                max_retries     INTEGER NOT NULL,
                next_retry_at   TEXT,
                scheduled_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS job_runs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                status          TEXT NOT NULL,
                started_at      TEXT NOT NULL,
                completed_at    TEXT,
                result          TEXT
            );
            ",
        )?;
        Ok(())
    }

    pub fn enqueue(&self, req: EnqueueRequest) -> Result<EnqueueResponse, JobError> {
        let now = Utc::now();
        let params_str = serde_json::to_string(&req.params)?;
        let mut conn = self.conn()?;
        conn.execute(
            "INSERT INTO jobs (task_type, params, status, created_at, max_retries, scheduled_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                req.task_type,
                params_str,
                JobStatus::Enqueued.to_string(),
                now.to_rfc3339(),
                req.max_retries,
                req.scheduled_at.map(|d| d.to_rfc3339())
            ],
        )?;
        let job_id = conn.last_insert_rowid();
        Ok(EnqueueResponse {
            success: true,
            job_id,
            status: JobStatus::Enqueued,
        })
    }

    pub fn get(&self, job_id: i64) -> Result<Job, JobError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, task_type, params, status, created_at, started_at,
                    completed_at, progress, result, error,
                    retry_count, max_retries, next_retry_at, scheduled_at
             FROM jobs WHERE id = ?1",
        )?;
        let job = stmt
            .query_row(params![job_id], |row| Self::row_to_job(row))?
            .ok_or(JobError::NotFound)?;
        Ok(job)
    }

    pub fn list(
        &self,
        filter: HashMap<String, String>,
        limit: usize,
    ) -> Result<(Vec<Job>, usize), JobError> {
        let mut query = "SELECT id, task_type, params, status, created_at, started_at,
                    completed_at, progress, result, error,
                    retry_count, max_retries, next_retry_at, scheduled_at
                    FROM jobs".to_string();
        let mut conditions = Vec::new();
        let mut params_vec: Vec<(String, Box<dyn ToSql>)> = Vec::new();

        if let Some(status) = filter.get("status") {
            conditions.push("status = :status".to_string());
            params_vec.push((":status".to_string(), Box::new(status.clone())));
        }
        if let Some(task_type) = filter.get("task_type") {
            conditions.push("task_type = :task_type".to_string());
            params_vec.push((":task_type".to_string(), Box::new(task_type.clone())));
        }
        if !conditions.is_empty() {
            query.push_str(" WHERE ");
            query.push_str(&conditions.join(" AND "));
        }
        query.push_str(" ORDER BY created_at DESC LIMIT :limit");
        params_vec.push((":limit".to_string(), Box::new(limit as i64)));

        let conn = self.conn()?;
        let mut stmt = conn.prepare(&query)?;
        let mut rows = stmt.query_named(
            params_vec
                .iter()
                .map(|(k, v)| (k.as_str(), &**v as &dyn ToSql))
                .collect::<Vec<(&str, &dyn ToSql)>>()
                .as_slice(),
        )?;

        let mut jobs = Vec::new();
        while let Some(row) = rows.next()? {
            jobs.push(Self::row_to_job(row)?.ok_or(JobError::NotFound)?);
        }

        // total count
        let total: usize = conn.query_row(
            "SELECT COUNT(*) FROM jobs",
            NO_PARAMS,
            |r| r.get(0),
        )?;
        Ok((jobs, total))
    }

    pub fn cancel(&self, job_id: i64) -> Result<CancelResponse, JobError> {
        let mut conn = self.conn()?;
        let status: String = conn.query_row(
            "SELECT status FROM jobs WHERE id = ?1",
            params![job_id],
            |r| r.get(0),
        )?;
        if status != JobStatus::Enqueued.to_string() {
            return Err(JobError::Invalid(
                "Only enqueued jobs can be cancelled".into(),
            ));
        }
        conn.execute(
            "UPDATE jobs SET status = ?1, completed_at = ?2 WHERE id = ?3",
            params![
                JobStatus::Cancelled.to_string(),
                Utc::now().to_rfc3339(),
                job_id
            ],
        )?;
        Ok(CancelResponse {
            success: true,
            status: JobStatus::Cancelled,
        })
    }

    pub fn retry(&self, job_id: i64) -> Result<RetryResponse, JobError> {
        let mut conn = self.conn()?;
        let job: Job = {
            let mut stmt = conn.prepare(
                "SELECT id, task_type, params, status, created_at, started_at,
                    completed_at, progress, result, error,
                    retry_count, max_retries, next_retry_at, scheduled_at
                 FROM jobs WHERE id = ?1",
            )?;
            stmt
                .query_row(params![job_id], |row| Self::row_to_job(row))?
                .ok_or(JobError::NotFound)?
        };
        if job.status != JobStatus::Failed {
            return Err(JobError::Invalid(
                "Only failed jobs can be retried".into(),
            ));
        }
        let now = Utc::now();
        let new_job_id = {
            conn.execute(
                "INSERT INTO jobs (task_type, params, status, created_at, max_retries, scheduled_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    job.task_type,
                    serde_json::to_string(&job.params)?,
                    JobStatus::Enqueued.to_string(),
                    now.to_rfc3339(),
                    job.max_retries,
                    job.scheduled_at.map(|d| d.to_rfc3339())
                ],
            )?;
            conn.last_insert_rowid()
        };
        Ok(RetryResponse {
            success: true,
            new_job_id,
            status: JobStatus::Enqueued,
        })
    }

    pub fn get_results(&self, job_id: i64) -> Result<ResultResponse, JobError> {
        let conn = self.conn()?;
        let row = conn.query_row(
            "SELECT status, result, completed_at FROM jobs WHERE id = ?1",
            params![job_id],
            |r| {
                let status_str: String = r.get(0)?;
                let result_str: Option<String> = r.get(1)?;
                let completed_at_str: Option<String> = r.get(2)?;
                Ok((status_str, result_str, completed_at_str))
            },
        )?;
        let status = match row.0.as_str() {
            "completed" => JobStatus::Completed,
            other => return Err(JobError::Invalid(format!("Job not completed, status {}", other))),
        };
        let result = row
            .1
            .ok_or(JobError::Invalid("Result missing".into()))?;
        let completed_at = row
            .2
            .ok_or(JobError::Invalid("completed_at missing".into()))?;
        Ok(ResultResponse {
            job_id,
            status,
            result: serde_json::from_str(&result)?,
            completed_at: DateTime::parse_from_rfc3339(&completed_at)?
                .with_timezone(&Utc),
        })
    }

    fn row_to_job(row: &Row) -> Result<Option<Job>, rusqlite::Error> {
        let id: i64 = row.get(0)?;
        let task_type: String = row.get(1)?;
        let params_str: String = row.get(2)?;
        let status_str: String = row.get(3)?;
        let created_at_str: String = row.get(4)?;
        let started_at_str: Option<String> = row.get(5)?;
        let completed_at_str: Option<String> = row.get(6)?;
        let progress: Option<String> = row.get(7)?;
        let result_str: Option<String> = row.get(8)?;
        let error: Option<String> = row.get(9)?;
        let retry_count: i32 = row.get(10)?;
        let max_retries: i32 = row.get(11)?;
        let next_retry_at_str: Option<String> = row.get(12)?;
        let scheduled_at_str: Option<String> = row.get(13)?;

        Ok(Some(Job {
            id,
            task_type,
            params: serde_json::from_str(&params_str).unwrap_or(JsonValue::Null),
            status: serde_json::from_str(&format!("\"{}\"", status_str)).unwrap_or(JobStatus::Enqueued),
            created_at: DateTime::parse_from_rfc3339(&created_at_str)
                .unwrap()
                .with_timezone(&Utc),
            started_at: started_at_str
                .map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
            completed_at: completed_at_str
                .map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
            progress,
            result: result_str
                .map(|s| serde_json::from_str(&s).unwrap_or(JsonValue::Null)),
            error,
            retry_count,
            max_retries,
            next_retry_at: next_retry_at_str
                .map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
            scheduled_at: scheduled_at_str
                .map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
        }))
    }

    async fn update_progress(
        &self,
        job_id: i64,
        current: usize,
        total: usize,
    ) -> Result<(), JobError> {
        let progress_str = format!("{}/{}", current, total);
        let conn = self.conn()?;
        conn.execute(
            "UPDATE jobs SET progress = ?1 WHERE id = ?2",
            params![progress_str, job_id],
        )?;
        Ok(())
    }

    async fn set_job_status(
        &self,
        job_id: i64,
        status: JobStatus,
        error: Option<String>,
        result: Option<JsonValue>,
        next_retry_at: Option<DateTime<Utc>>,
    ) -> Result<(), JobError> {
        let now = Utc::now();
        let conn = self.conn()?;
        match status {
            JobStatus::Running => {
                conn.execute(
                    "UPDATE jobs SET status = ?1, started_at = ?2 WHERE id = ?3",
                    params![status.to_string(), now.to_rfc3339(), job_id],
                )?;
            }
            JobStatus::Completed => {
                conn.execute(
                    "UPDATE jobs SET status = ?1, completed_at = ?2, result = ?3, progress = ?4 WHERE id = ?5",
                    params![
                        status.to_string(),
                        now.to_rfc3339(),
                        result.as_ref().map(|r| serde_json::to_string(r).unwrap()),
                        format!("{} / {}", total_items(&result), total_items(&result)),
                        job_id
                    ],
                )?;
            }
            JobStatus::Failed => {
                conn.execute(
                    "UPDATE jobs SET status = ?1, error = ?2, next_retry_at = ?3 WHERE id = ?4",
                    params![
                        status.to_string(),
                        error,
                        next_retry_at.map(|d| d.to_rfc3339()),
                        job_id
                    ],
                )?;
            }
            JobStatus::Cancelled => {
                conn.execute(
                    "UPDATE jobs SET status = ?1, completed_at = ?2 WHERE id = ?3",
                    params![status.to_string(), now.to_rfc3339(), job_id],
                )?;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn start_worker(self: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                if let Err(e) = self.process_one_job().await {
                    eprintln!("Worker error: {:?}", e);
                }
                sleep(Duration::seconds(1).to_std().unwrap()).await;
            }
        });
    }

    async fn process_one_job(&self) -> Result<(), JobError> {
        let job_opt = {
            let conn = self.conn()?;
            let mut stmt = conn.prepare(
                "SELECT id FROM jobs
                 WHERE (status = 'enqueued' OR (status = 'failed' AND next_retry_at <= ?1))
                   AND (scheduled_at IS NULL OR scheduled_at <= ?1)
                 ORDER BY created_at ASC
                 LIMIT 1",
            )?;
            stmt
                .query_row(params![Utc::now().to_rfc3339()], |row| row.get(0))
                .optional()?
        };
        let job_id = match job_opt {
            Some(id) => id,
            None => return Ok(()),
        };
        // Mark as running
        self.set_job_status(job_id, JobStatus::Running, None, None, None)
            .await?;
        // Fetch full job
        let job = self.get(job_id)?;
        // Execute task
        let exec_result = self.execute_task(&job).await;
        match exec_result {
            Ok(res) => {
                self.set_job_status(job_id, JobStatus::Completed, None, Some(res), None)
                    .await?;
            }
            Err(err_msg) => {
                // Determine retry
                if job.retry_count < job.max_retries {
                    let backoff_secs = 2_i64.pow(job.retry_count as u32);
                    let next_retry = Utc::now() + Duration::seconds(backoff_secs);
                    // Increment retry count
                    let conn = self.conn()?;
                    conn.execute(
                        "UPDATE jobs SET retry_count = retry_count + 1 WHERE id = ?1",
                        params![job_id],
                    )?;
                    self.set_job_status(
                        job_id,
                        JobStatus::Failed,
                        Some(err_msg.clone()),
                        None,
                        Some(next_retry),
                    )
                    .await?;
                } else {
                    self.set_job_status(job_id, JobStatus::Failed, Some(err_msg), None, None)
                        .await?;
                }
            }
        }
        Ok(())
    }

    async fn execute_task(&self, job: &Job) -> Result<JsonValue, String> {
        match job.task_type.as_str() {
            "send_bulk_email" => self.task_send_bulk_email(job).await,
            "webhook_retry" => self.task_webhook_retry(job).await,
            "export_generate" => self.task_export_generate(job).await,
            "daily_report" => self.task_daily_report(job).await,
            "cleanup_old_sessions" => self.task_cleanup_old_sessions(job).await,
            "delete_user_cascade" => self.task_delete_user_cascade(job).await,
            _ => Err(format!("Unknown task_type {}", job.task_type)),
        }
    }

    async fn task_send_bulk_email(&self, job: &Job) -> Result<JsonValue, String> {
        // Expect params: { "total": number, "fail": bool }
        let total = job
            .params
            .get("total")
            .and_then(|v| v.as_u64())
            .unwrap_or(100) as usize;
        let fail = job.params.get("fail").and_then(|v| v.as_bool()).unwrap_or(false);
        for i in 1..=total {
            // Simulate work
            sleep(Duration::milliseconds(5).to_std().unwrap()).await;
            self.update_progress(job.id, i, total).await.map_err(|e| e.to_string())?;
            if fail && i == total / 2 {
                return Err("Simulated failure".into());
            }
        }
        Ok(json!({
            "sent": total,
            "failed": 0,
            "skipped": 0,
            "errors": []
        }))
    }

    async fn task_webhook_retry(&self, job: &Job) -> Result<JsonValue, String> {
        // Simulate 10 retries
        let attempts = job
            .params
            .get("attempts")
            .and_then(|v| v.as_u64())
            .unwrap_or(10) as usize;
        for i in 1..=attempts {
            sleep(Duration::milliseconds(10).to_std().unwrap()).await;
            self.update_progress(job.id, i, attempts).await.map_err(|e| e.to_string())?;
        }
        Ok(json!({ "retries": attempts, "status": "ok" }))
    }

    async fn task_export_generate(&self, job: &Job) -> Result<JsonValue, String> {
        let items = job
            .params
            .get("items")
            .and_then(|v| v.as_u64())
            .unwrap_or(500) as usize;
        for i in 1..=items {
            sleep(Duration::milliseconds(2).to_std().unwrap()).await;
            self.update_progress(job.id, i, items).await.map_err(|e| e.to_string())?;
        }
        Ok(json!({ "export_id": format!("exp-{}", job.id), "items": items }))
    }

    async fn task_daily_report(&self, _job: &Job) -> Result<JsonValue, String> {
        // Simulate quick aggregation
        sleep(Duration::seconds(1).to_std().unwrap()).await;
        Ok(json!({ "report": "daily", "generated_at": Utc::now().to_rfc3339() }))
    }

    async fn task_cleanup_old_sessions(&self, _job: &Job) -> Result<JsonValue, String> {
        // Simulate cleanup of 1000 sessions
        let total = 1000usize;
        for i in 1..=total {
            if i % 100 == 0 {
                sleep(Duration::milliseconds(5).to_std().unwrap()).await;
            }
            self.update_progress(_job.id, i, total).await.map_err(|e| e.to_string())?;
        }
        Ok(json!({ "deleted_sessions": total }))
    }

    async fn task_delete_user_cascade(&self, job: &Job) -> Result<JsonValue, String> {
        let user_id = job
            .params
            .get("user_id")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| "user_id missing".to_string())?;
        // Simulate deletion steps
        for step in 1..=3 {
            sleep(Duration::milliseconds(20).to_std().unwrap()).await;
            self.update_progress(job.id, step, 3).await.map_err(|e| e.to_string())?;
        }
        Ok(json!({ "user_id": user_id, "deleted": true }))
    }
}

// Helper to count total items in result for progress finalization
fn total_items(result: &Option<JsonValue>) -> usize {
    if let Some(JsonValue::Object(map)) = result {
        if let Some(JsonValue::Number(n)) = map.get("total") {
            return n.as_u64().unwrap_or(0) as usize;
        }
    }
    0
}

// Implement ToString for JobStatus
impl ToString for JobStatus {
    fn to_string(&self) -> String {
        match self {
            JobStatus::Enqueued => "enqueued".into(),
            JobStatus::Running => "running".into(),
            JobStatus::Completed => "completed".into(),
            JobStatus::Failed => "failed".into(),
            JobStatus::Cancelled => "cancelled".into(),
        }
    }
}

// Implement Deserialize for JobStatus from string
impl<'de> Deserialize<'de> for JobStatus {
    fn deserialize<D>(deserializer: D) -> Result<JobStatus, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "enqueued" => Ok(JobStatus::Enqueued),
            "running" => Ok(JobStatus::Running),
            "completed" => Ok(JobStatus::Completed),
            "failed" => Ok(JobStatus::Failed),
            "cancelled" => Ok(JobStatus::Cancelled),
            _ => Err(serde::de::Error::custom("invalid job status")),
        }
    }
}

// Implement Serialize for JobStatus as lower case string
impl Serialize for JobStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Helper macro for json! without pulling in full serde_json macro
#[macro_export]
macro_rules! json {
    ($($json:tt)+) => {
        serde_json::json!($($json)+)
    };
}