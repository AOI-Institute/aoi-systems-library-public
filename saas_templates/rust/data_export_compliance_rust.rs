use aws_config::meta::region::RegionProviderChain;
use aws_sdk_s3::{Client as S3Client, types::ByteStream};
use chrono::{DateTime, Duration, Utc};
use lettre::message::{Mailbox, Message};
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::env;
use thiserror::Error;
use tokio::task;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ComplianceError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("s3 error: {0}")]
    S3(#[from] aws_sdk_s3::Error),
    #[error("email error: {0}")]
    Email(#[from] lettre::error::Error),
    #[error("invalid format")]
    InvalidFormat,
    #[error("invalid reason")]
    InvalidReason,
    #[error("export not found")]
    ExportNotFound,
    #[error("deletion not found")]
    DeletionNotFound,
    #[error("confirmation token mismatch")]
    TokenMismatch,
    #[error("operation not allowed")]
    NotAllowed,
}

#[derive(Debug, Clone, Copy, sqlx::Type, Serialize, Deserialize, PartialEq, Eq)]
#[sqlx(type_name = "export_format", rename_all = "lowercase")]
pub enum ExportFormat {
    Json,
    Csv,
}

#[derive(Debug, Clone, Copy, sqlx::Type, Serialize, Deserialize, PartialEq, Eq)]
#[sqlx(type_name = "export_status", rename_all = "lowercase")]
pub enum ExportStatus {
    Pending,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, sqlx::Type, Serialize, Deserialize, PartialEq, Eq)]
#[sqlx(type_name = "deletion_status", rename_all = "lowercase")]
pub enum DeletionStatus {
    Pending,
    Approved,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, sqlx::Type, Serialize, Deserialize, PartialEq, Eq)]
#[sqlx(type_name = "deletion_reason", rename_all = "snake_case")]
pub enum DeletionReason {
    UserRequested,
    GdprRequest,
    GdprRightToBeForgotten,
    Other,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportRequest {
    pub id: Uuid,
    pub user_id: i64,
    pub requested_at: DateTime<Utc>,
    pub status: ExportStatus,
    pub format: ExportFormat,
    pub file_url: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeletionRequest {
    pub id: Uuid,
    pub user_id: i64,
    pub requested_at: DateTime<Utc>,
    pub status: DeletionStatus,
    pub reason: DeletionReason,
    pub deleted_at: Option<DateTime<Utc>>,
    pub confirmation_token: String,
}

#[derive(Debug, Serialize)]
pub struct ExportResponse {
    pub success: bool,
    pub export_id: Uuid,
    pub status: ExportStatus,
    pub will_email_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ExportStatusResponse {
    pub export_id: Uuid,
    pub status: ExportStatus,
    pub file_url: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub requested_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DeletionResponse {
    pub success: bool,
    pub deletion_id: Uuid,
    pub status: DeletionStatus,
    pub will_delete_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ConfirmDeletionResponse {
    pub success: bool,
    pub deletion_scheduled_for: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct CancelDeletionResponse {
    pub success: bool,
    pub status: DeletionStatus,
}

#[derive(Debug, Serialize)]
pub struct ExportListResponse {
    pub exports: Vec<ExportRequest>,
    pub total: i64,
}

#[derive(Debug, Serialize)]
pub struct DeletionListResponse {
    pub deletions: Vec<DeletionRequest>,
    pub total: i64,
}

// ---------------------------------------------------------------------------
// Database schema (executable DDL)
// ---------------------------------------------------------------------------
pub const MIGRATIONS: &[&str] = &[
    r#"
    CREATE TYPE export_format AS ENUM ('json', 'csv');
    CREATE TYPE export_status AS ENUM ('pending', 'completed', 'failed');
    CREATE TYPE deletion_status AS ENUM ('pending', 'approved', 'completed', 'cancelled');
    CREATE TYPE deletion_reason AS ENUM ('user_requested', 'gdpr_request', 'gdpr_right_to_be_forgotten', 'other');
    "#,
    r#"
    CREATE TABLE export_requests (
        id UUID PRIMARY KEY,
        user_id BIGINT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL,
        status export_status NOT NULL,
        format export_format NOT NULL,
        file_url TEXT,
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ
    );
    "#,
    r#"
    CREATE TABLE deletion_requests (
        id UUID PRIMARY KEY,
        user_id BIGINT NOT NULL,
        requested_at TIMESTAMPTZ NOT NULL,
        status deletion_status NOT NULL,
        reason deletion_reason NOT NULL,
        deleted_at TIMESTAMPTZ,
        confirmation_token TEXT NOT NULL
    );
    "#,
    // Minimal placeholder tables for cascade delete demonstration
    r#"
    CREATE TABLE sessions (id UUID PRIMARY KEY, user_id BIGINT NOT NULL);
    CREATE TABLE activity (id UUID PRIMARY KEY, user_id BIGINT NOT NULL);
    CREATE TABLE files (id UUID PRIMARY KEY, user_id BIGINT NOT NULL);
    CREATE TABLE preferences (id UUID PRIMARY KEY, user_id BIGINT NOT NULL);
    CREATE TABLE transactions (id UUID PRIMARY KEY, user_id BIGINT NOT NULL);
    CREATE TABLE api_keys (id UUID PRIMARY KEY, user_id BIGINT NOT NULL);
    CREATE TABLE audit_log (
        id UUID PRIMARY KEY,
        user_id BIGINT,
        action TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        details JSONB
    );
    "#,
];

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------
pub struct ComplianceService {
    db: PgPool,
    s3: S3Client,
    email_transport: AsyncSmtpTransport<Tokio1Executor>,
    bucket: String,
    email_from: Mailbox,
    base_url: String, // e.g., https://example.com
}

impl ComplianceService {
    pub async fn new() -> Result<Self, ComplianceError> {
        let database_url = env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await?;

        // S3 client
        let region_provider = RegionProviderChain::default_provider().or_else("us-east-1");
        let aws_config = aws_config::from_env().region(region_provider).load().await;
        let s3 = S3Client::new(&aws_config);
        let bucket = env::var("S3_BUCKET").expect("S3_BUCKET must be set");

        // Email
        let smtp_host = env::var("SMTP_HOST").expect("SMTP_HOST must be set");
        let smtp_user = env::var("SMTP_USER").expect("SMTP_USER must be set");
        let smtp_pass = env::var("SMTP_PASS").expect("SMTP_PASS must be set");
        let email_from_addr = env::var("EMAIL_FROM").expect("EMAIL_FROM must be set");
        let email_from = email_from_addr.parse().expect("Invalid EMAIL_FROM address");
        let transport = AsyncSmtpTransport::<Tokio1Executor>::relay(&smtp_host)?
            .credentials(lettre::transport::smtp::authentication::Credentials::new(
                smtp_user,
                smtp_pass,
            ))
            .build();

        let base_url = env::var("BASE_URL").unwrap_or_else(|_| "https://example.com".into());

        Ok(Self {
            db: pool,
            s3,
            email_transport: transport,
            bucket,
            email_from,
            base_url,
        })
    }

    // -----------------------------------------------------------------------
    // 1. Request data export
    // -----------------------------------------------------------------------
    pub async fn request_data_export(
        &self,
        user_id: i64,
        format: ExportFormat,
    ) -> Result<ExportResponse, ComplianceError> {
        let export_id = Uuid::new_v4();
        let now = Utc::now();

        sqlx::query!(
            r#"
            INSERT INTO export_requests (id, user_id, requested_at, status, format)
            VALUES ($1, $2, $3, $4, $5)
            "#,
            export_id,
            user_id,
            now,
            ExportStatus::Pending as ExportStatus,
            format as ExportFormat
        )
        .execute(&self.db)
        .await?;

        // Audit log
        self.log_audit(user_id, "data_export_requested", None).await?;

        // Spawn background job
        let svc = self.clone();
        task::spawn(async move {
            if let Err(e) = svc.generate_export_file(export_id, user_id, format).await {
                // Mark as failed
                let _ = sqlx::query!(
                    r#"
                    UPDATE export_requests SET status = $1 WHERE id = $2
                    "#,
                    ExportStatus::Failed as ExportStatus,
                    export_id
                )
                .execute(&svc.db)
                .await;
                eprintln!("Export generation failed: {}", e);
            }
        });

        Ok(ExportResponse {
            success: true,
            export_id,
            status: ExportStatus::Pending,
            will_email_at: now + Duration::hours(1), // assume email within an hour
        })
    }

    async fn generate_export_file(
        &self,
        export_id: Uuid,
        user_id: i64,
        format: ExportFormat,
    ) -> Result<(), ComplianceError> {
        // Gather data (placeholder minimal data)
        let profile = sqlx::query_as!(
            UserProfile,
            r#"
            SELECT id, email, name, created_at, tier, status
            FROM users WHERE id = $1
            "#,
            user_id
        )
        .fetch_one(&self.db)
        .await?;

        let sessions = sqlx::query_as!(
            SimpleRecord,
            r#"SELECT id, user_id FROM sessions WHERE user_id = $1"#,
            user_id
        )
        .fetch_all(&self.db)
        .await?;

        // ... similarly fetch activity, files, preferences, transactions, audit_log
        // For brevity we only include profile and sessions.

        let export_payload = ExportPayload {
            profile,
            sessions,
        };

        let bytes = match format {
            ExportFormat::Json => serde_json::to_vec(&export_payload)?,
            ExportFormat::Csv => {
                let mut wtr = csv::Writer::from_writer(vec![]);
                // Write header
                wtr.write_record(&["section", "json"])?;
                // Profile
                wtr.write_record(&["profile", serde_json::to_string(&export_payload.profile)?])?;
                // Sessions
                wtr.write_record(&[
                    "sessions",
                    serde_json::to_string(&export_payload.sessions)?,
                ])?;
                wtr.flush()?;
                wtr.into_inner()?
            }
        };

        // Upload to S3
        let key = format!("exports/{}.{:?}", export_id, format).to_lowercase();
        self.s3
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(ByteStream::from(bytes.clone()))
            .send()
            .await?;

        // Generate signed URL (7 days)
        let expires = Duration::days(7);
        let presigned_req = self
            .s3
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .presigned(expires)
            .await?;
        let url = presigned_req.uri().to_string();

        // Update DB
        let now = Utc::now();
        sqlx::query!(
            r#"
            UPDATE export_requests
            SET status = $1,
                file_url = $2,
                completed_at = $3,
                expires_at = $4
            WHERE id = $5
            "#,
            ExportStatus::Completed as ExportStatus,
            url,
            now,
            now + expires,
            export_id
        )
        .execute(&self.db)
        .await?;

        // Send email
        self.send_export_email(user_id, &url).await?;

        Ok(())
    }

    async fn send_export_email(&self, user_id: i64, download_url: &str) -> Result<(), ComplianceError> {
        let user_email = sqlx::query_scalar!(
            r#"SELECT email FROM users WHERE id = $1"#,
            user_id
        )
        .fetch_one(&self.db)
        .await?;

        let email = Message::builder()
            .from(self.email_from.clone())
            .to(user_email.parse().unwrap())
            .subject("Your data export is ready")
            .body(format!(
                "Your requested data export is ready. Download it here (valid for 7 days): {}",
                download_url
            ))?;

        self.email_transport.send(email).await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 2. Check export status
    // -----------------------------------------------------------------------
    pub async fn check_export_status(
        &self,
        export_id: Uuid,
    ) -> Result<ExportStatusResponse, ComplianceError> {
        let rec = sqlx::query_as!(
            ExportRequest,
            r#"
            SELECT id, user_id, requested_at, status as "status: ExportStatus",
                   format as "format: ExportFormat", file_url, completed_at, expires_at
            FROM export_requests WHERE id = $1
            "#,
            export_id
        )
        .fetch_optional(&self.db)
        .await?;

        let export = rec.ok_or(ComplianceError::ExportNotFound)?;

        Ok(ExportStatusResponse {
            export_id,
            status: export.status,
            file_url: export.file_url,
            expires_at: export.expires_at,
            requested_at: export.requested_at,
        })
    }

    // -----------------------------------------------------------------------
    // 3. Request account deletion
    // -----------------------------------------------------------------------
    pub async fn request_account_deletion(
        &self,
        user_id: i64,
        reason: DeletionReason,
    ) -> Result<DeletionResponse, ComplianceError> {
        let deletion_id = Uuid::new_v4();
        let token = Uuid::new_v4().to_string();
        let now = Utc::now();

        sqlx::query!(
            r#"
            INSERT INTO deletion_requests (id, user_id, requested_at, status, reason, confirmation_token)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
            deletion_id,
            user_id,
            now,
            DeletionStatus::Pending as DeletionStatus,
            reason as DeletionReason,
            token
        )
        .execute(&self.db)
        .await?;

        self.log_audit(user_id, "deletion_requested", Some(json!({ "reason": reason })))
            .await?;

        // Send confirmation email
        self.send_deletion_confirmation_email(user_id, deletion_id, &token)
            .await?;

        Ok(DeletionResponse {
            success: true,
            deletion_id,
            status: DeletionStatus::Pending,
            will_delete_at: now + Duration::days(30),
        })
    }

    async fn send_deletion_confirmation_email(
        &self,
        user_id: i64,
        deletion_id: Uuid,
        token: &str,
    ) -> Result<(), ComplianceError> {
        let user_email = sqlx::query_scalar!(
            r#"SELECT email FROM users WHERE id = $1"#,
            user_id
        )
        .fetch_one(&self.db)
        .await?;

        let confirm_url = format!(
            "{}/compliance/delete/{}/confirm?token={}",
            self.base_url, deletion_id, token
        );

        let email = Message::builder()
            .from(self.email_from.clone())
            .to(user_email.parse().unwrap())
            .subject("Confirm your account deletion")
            .body(format!(
                "Please confirm your account deletion by clicking the link: {}",
                confirm_url
            ))?;

        self.email_transport.send(email).await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 4. Approve/confirm deletion
    // -----------------------------------------------------------------------
    pub async fn confirm_deletion(
        &self,
        deletion_id: Uuid,
        token: &str,
    ) -> Result<ConfirmDeletionResponse, ComplianceError> {
        let mut tx = self.db.begin().await?;

        let rec = sqlx::query_as!(
            DeletionRequest,
            r#"
            SELECT id, user_id, requested_at, status as "status: DeletionStatus",
                   reason as "reason: DeletionReason", deleted_at, confirmation_token
            FROM deletion_requests WHERE id = $1
            "#,
            deletion_id
        )
        .fetch_optional(&mut tx)
        .await?;

        let mut deletion = rec.ok_or(ComplianceError::DeletionNotFound)?;

        if deletion.confirmation_token != token {
            return Err(ComplianceError::TokenMismatch);
        }

        // Update status to Approved
        sqlx::query!(
            r#"
            UPDATE deletion_requests
            SET status = $1
            WHERE id = $2
            "#,
            DeletionStatus::Approved as DeletionStatus,
            deletion_id
        )
        .execute(&mut tx)
        .await?;

        // Schedule actual deletion after 30 days (for test we just set deleted_at)
        let scheduled_at = Utc::now() + Duration::days(30);
        sqlx::query!(
            r#"
            UPDATE deletion_requests
            SET deleted_at = $1
            WHERE id = $2
            "#,
            scheduled_at,
            deletion_id
        )
        .execute(&mut tx)
        .await?;

        // Log audit
        self.log_audit(deletion.user_id, "deletion_confirmed", None)
            .await?;

        // Spawn background cascade delete after grace period (simulated immediate for demo)
        let svc = self.clone();
        let user_id = deletion.user_id;
        task::spawn(async move {
            // In real system, schedule with a job queue; here we wait 30 days (omitted)
            let _ = svc.cascade_delete_user(user_id).await;
        });

        tx.commit().await?;

        Ok(ConfirmDeletionResponse {
            success: true,
            deletion_scheduled_for: scheduled_at,
        })
    }

    // -----------------------------------------------------------------------
    // 5. Cancel deletion
    // -----------------------------------------------------------------------
    pub async fn cancel_deletion(&self, deletion_id: Uuid) -> Result<CancelDeletionResponse, ComplianceError> {
        let rec = sqlx::query_as!(
            DeletionRequest,
            r#"
            SELECT id, user_id, requested_at, status as "status: DeletionStatus",
                   reason as "reason: DeletionReason", deleted_at, confirmation_token
            FROM deletion_requests WHERE id = $1
            "#,
            deletion_id
        )
        .fetch_one(&self.db)
        .await?;

        if rec.status != DeletionStatus::Pending && rec.status != DeletionStatus::Approved {
            return Err(ComplianceError::NotAllowed);
        }

        sqlx::query!(
            r#"
            UPDATE deletion_requests
            SET status = $1
            WHERE id = $2
            "#,
            DeletionStatus::Cancelled as DeletionStatus,
            deletion_id
        )
        .execute(&self.db)
        .await?;

        self.log_audit(rec.user_id, "deletion_cancelled", None).await?;

        Ok(CancelDeletionResponse {
            success: true,
            status: DeletionStatus::Cancelled,
        })
    }

    // -----------------------------------------------------------------------
    // 6. List export requests (admin)
    // -----------------------------------------------------------------------
    pub async fn list_exports(
        &self,
        user_id: Option<i64>,
        status: Option<ExportStatus>,
    ) -> Result<ExportListResponse, ComplianceError> {
        let mut query = String::from(
            "SELECT id, user_id, requested_at, status as \"status: ExportStatus\", format as \"format: ExportFormat\", file_url, completed_at, expires_at FROM export_requests",
        );
        let mut args: Vec<(String, Box<dyn sqlx::Encode<'_, sqlx::Postgres> + Send + Sync>)> = vec![];
        let mut conditions = vec![];

        if let Some(uid) = user_id {
            conditions.push(format!("user_id = ${}", args.len() + 1));
            args.push((uid.to_string(), Box::new(uid)));
        }
        if let Some(st) = status {
            conditions.push(format!("status = ${}", args.len() + 1));
            args.push((format!("{:?}", st), Box::new(st as ExportStatus)));
        }

        if !conditions.is_empty() {
            query.push_str(" WHERE ");
            query.push_str(&conditions.join(" AND "));
        }

        let rows = sqlx::query_as::<_, ExportRequest>(&query)
            .bind_all(args.iter().map(|(_, v)| v.as_ref()))
            .fetch_all(&self.db)
            .await?;

        let total = rows.len() as i64;

        Ok(ExportListResponse { exports: rows, total })
    }

    // -----------------------------------------------------------------------
    // 7. List deletion requests (admin)
    // -----------------------------------------------------------------------
    pub async fn list_deletions(
        &self,
        status: Option<DeletionStatus>,
    ) -> Result<DeletionListResponse, ComplianceError> {
        let mut query = String::from(
            "SELECT id, user_id, requested_at, status as \"status: DeletionStatus\", reason as \"reason: DeletionReason\", deleted_at, confirmation_token FROM deletion_requests",
        );
        let mut args: Vec<(String, Box<dyn sqlx::Encode<'_, sqlx::Postgres> + Send + Sync>)> = vec![];
        if let Some(st) = status {
            query.push_str(" WHERE status = $1");
            args.push((format!("{:?}", st), Box::new(st as DeletionStatus)));
        }

        let rows = sqlx::query_as::<_, DeletionRequest>(&query)
            .bind_all(args.iter().map(|(_, v)| v.as_ref()))
            .fetch_all(&self.db)
            .await?;

        let total = rows.len() as i64;
        Ok(DeletionListResponse {
            deletions: rows,
            total,
        })
    }

    // -----------------------------------------------------------------------
    // Helper: audit logging
    // -----------------------------------------------------------------------
    async fn log_audit(
        &self,
        user_id: i64,
        action: &str,
        details: Option<serde_json::Value>,
    ) -> Result<(), ComplianceError> {
        sqlx::query!(
            r#"
            INSERT INTO audit_log (id, user_id, action, created_at, details)
            VALUES ($1, $2, $3, $4, $5)
            "#,
            Uuid::new_v4(),
            user_id,
            action,
            Utc::now(),
            details
        )
        .execute(&self.db)
        .await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Helper: cascade delete
    // -----------------------------------------------------------------------
    async fn cascade_delete_user(&self, user_id: i64) -> Result<(), ComplianceError> {
        let tables = [
            "sessions",
            "activity",
            "files",
            "preferences",
            "transactions",
            "api_keys",
        ];
        for tbl in tables.iter() {
            let q = format!("DELETE FROM {} WHERE user_id = $1", tbl);
            sqlx::query(&q).bind(user_id).execute(&self.db).await?;
        }
        // Finally delete user record (if exists)
        sqlx::query!("DELETE FROM users WHERE id = $1", user_id)
            .execute(&self.db)
            .await?;
        self.log_audit(user_id, "user_cascade_deleted", None).await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Data structures for export payload (simplified)
// ---------------------------------------------------------------------------
#[derive(Debug, Serialize, sqlx::FromRow)]
struct UserProfile {
    id: i64,
    email: String,
    name: String,
    created_at: DateTime<Utc>,
    tier: String,
    status: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct SimpleRecord {
    id: Uuid,
    user_id: i64,
}

#[derive(Debug, Serialize)]
struct ExportPayload {
    profile: UserProfile,
    sessions: Vec<SimpleRecord>,
}

// Implement Clone for ComplianceService to allow moving into async tasks
impl Clone for ComplianceService {
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            s3: self.s3.clone(),
            email_transport: self.email_transport.clone(),
            bucket: self.bucket.clone(),
            email_from: self.email_from.clone(),
            base_url: self.base_url.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Extension trait to bind a vector of parameters (used in list functions)
// ---------------------------------------------------------------------------
trait QueryBindAll<'q, DB>
where
    DB: sqlx::Database,
{
    fn bind_all<I>(self, iter: I) -> Self
    where
        I: IntoIterator<Item = &'q (dyn sqlx::Encode<'q, DB> + Send + Sync)>;
}

impl<'q, DB> QueryBindAll<'q, DB> for sqlx::query::Query<'q, DB, sqlx::postgres::PgArguments>
where
    DB: sqlx::Database,
{
    fn bind_all<I>(mut self, iter: I) -> Self
    where
        I: IntoIterator<Item = &'q (dyn sqlx::Encode<'q, DB> + Send + Sync)>,
    {
        for val in iter {
            self = self.bind(val);
        }
        self
    }
}