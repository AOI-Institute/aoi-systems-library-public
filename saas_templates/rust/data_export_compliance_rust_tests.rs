use super::*;
use chrono::Utc;
use sqlx::{Executor, PgPool, Connection, migrate::Migrator};
use std::env;
use uuid::Uuid;

static MIGRATOR: Migrator = sqlx::migrate!(); // expects migrations folder; we will run inline

async fn setup_db() -> PgPool {
    let database_url = env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/compliance_test".into());

    // Create a fresh database for each test run
    let mut conn = PgConnection::connect(&database_url).await.unwrap();
    conn.execute("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;")
        .await
        .unwrap();

    // Apply migrations defined in the module
    for stmt in data_export_compliance_rust::MIGRATIONS.iter() {
        conn.execute(*stmt).await.unwrap();
    }

    // Create a dummy users table
    conn.execute(
        r#"
        CREATE TABLE users (
            id BIGINT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            tier TEXT NOT NULL,
            status TEXT NOT NULL
        );
        INSERT INTO users (id, email, name, created_at, tier, status)
        VALUES (1, 'alice@example.com', 'Alice', now(), 'pro', 'active');
        "#,
    )
    .await
    .unwrap();

    PgPool::connect(&database_url).await.unwrap()
}

// Mock S3 client that does nothing but pretends success
struct MockS3Client;
impl MockS3Client {
    async fn put_object(&self) -> Result<(), aws_sdk_s3::Error> {
        Ok(())
    }
    async fn get_object(&self) -> Result<aws_sdk_s3::presigning::PresignedRequest, aws_sdk_s3::Error> {
        // Return a dummy presigned request
        let req = aws_sdk_s3::presigning::PresignedRequest::builder()
            .uri("https://example.com/dummy".parse().unwrap())
            .build()
            .unwrap();
        Ok(req)
    }
}

// Mock email transport that records sent messages
#[derive(Clone, Default)]
struct MockEmailTransport {
    sent: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}
#[async_trait::async_trait]
impl lettre::AsyncTransport for MockEmailTransport {
    type Ok = ();
    type Error = lettre::error::Error;

    async fn send(&self, email: lettre::Message) -> Result<Self::Ok, Self::Error> {
        let mut lock = self.sent.lock().unwrap();
        lock.push(email.formatted());
        Ok(())
    }
}

// Helper to build a ComplianceService with mocks
async fn build_service(pool: PgPool) -> ComplianceService {
    // Use real S3 client but point to a dummy endpoint via env vars
    let s3 = S3Client::new(&aws_config::load_from_env().await);
    let email_transport = MockEmailTransport::default();

    ComplianceService {
        db: pool,
        s3,
        email_transport,
        bucket: "test-bucket".into(),
        email_from: "no-reply@example.com".parse().unwrap(),
        base_url: "https://example.com".into(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_export_json_flow() {
    let pool = setup_db().await;
    let svc = build_service(pool.clone()).await;

    // Request export
    let resp = svc
        .request_data_export(1, ExportFormat::Json)
        .await
        .expect("request export");
    assert!(resp.success);
    assert_eq!(resp.status, ExportStatus::Pending);

    // Simulate background job completion
    svc.generate_export_file(resp.export_id, 1, ExportFormat::Json)
        .await
        .expect("generate export");

    // Check status
    let status = svc
        .check_export_status(resp.export_id)
        .await
        .expect("check status");
    assert_eq!(status.status, ExportStatus::Completed);
    assert!(status.file_url.is_some());
    assert!(status.expires_at.unwrap() > Utc::now());

    // Verify email sent
    // (In real test we would inspect MockEmailTransport)
}

#[tokio::test]
async fn test_export_csv_flow() {
    let pool = setup_db().await;
    let svc = build_service(pool.clone()).await;

    let resp = svc
        .request_data_export(1, ExportFormat::Csv)
        .await
        .expect("request export csv");
    svc.generate_export_file(resp.export_id, 1, ExportFormat::Csv)
        .await
        .expect("generate csv export");

    let status = svc.check_export_status(resp.export_id).await.unwrap();
    assert_eq!(status.status, ExportStatus::Completed);
    assert!(status.file_url.unwrap().ends_with(".csv"));
}

#[tokio::test]
async fn test_deletion_grace_period_and_cancel() {
    let pool = setup_db().await;
    let svc = build_service(pool.clone()).await;

    // Request deletion
    let del_resp = svc
        .request_account_deletion(1, DeletionReason::UserRequested)
        .await
        .expect("request deletion");
    assert_eq!(del_resp.status, DeletionStatus::Pending);

    // Confirm deletion
    // Retrieve token from DB
    let token: String = sqlx::query_scalar!(
        "SELECT confirmation_token FROM deletion_requests WHERE id = $1",
        del_resp.deletion_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let confirm = svc
        .confirm_deletion(del_resp.deletion_id, &token)
        .await
        .expect("confirm deletion");
    assert!(confirm.success);

    // Cancel within grace period
    let cancel = svc
        .cancel_deletion(del_resp.deletion_id)
        .await
        .expect("cancel deletion");
    assert_eq!(cancel.status, DeletionStatus::Cancelled);
}

#[tokio::test]
async fn test_cascade_delete_preserves_audit_log() {
    let pool = setup_db().await;
    let svc = build_service(pool.clone()).await;

    // Insert dummy related rows
    sqlx::query!("INSERT INTO sessions (id, user_id) VALUES ($1, $2)", Uuid::new_v4(), 1)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query!("INSERT INTO audit_log (id, user_id, action, created_at, details) VALUES ($1, $2, $3, $4, $5)",
        Uuid::new_v4(),
        1,
        "login",
        Utc::now(),
        json!({}))
        .execute(&pool)
        .await
        .unwrap();

    // Directly call cascade delete (as if grace period elapsed)
    svc.cascade_delete_user(1).await.expect("cascade delete");

    // Sessions should be gone
    let sess_cnt: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM sessions WHERE user_id = $1", 1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sess_cnt, 0);

    // Audit log must still exist
    let audit_cnt: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM audit_log WHERE user_id = $1", 1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(audit_cnt, 1);
}

#[tokio::test]
async fn test_admin_list_exports_and_deletions() {
    let pool = setup_db().await;
    let svc = build_service(pool.clone()).await;

    // Create two exports
    let e1 = svc
        .request_data_export(1, ExportFormat::Json)
        .await
        .unwrap();
    let e2 = svc
        .request_data_export(1, ExportFormat::Csv)
        .await
        .unwrap();

    // Create a deletion request
    let d1 = svc
        .request_account_deletion(1, DeletionReason::GdprRequest)
        .await
        .unwrap();

    // List exports
    let list = svc
        .list_exports(Some(1), Some(ExportStatus::Pending))
        .await
        .unwrap();
    assert_eq!(list.total, 2);
    assert!(list.exports.iter().any(|e| e.id == e1.export_id));
    assert!(list.exports.iter().any(|e| e.id == e2.export_id));

    // List deletions
    let dlist = svc.list_deletions(Some(DeletionStatus::Pending)).await.unwrap();
    assert_eq!(dlist.total, 1);
    assert_eq!(dlist.deletions[0].id, d1.deletion_id);
}