use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, Duration};
use sha2::{Sha256, Digest};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq)]
pub enum RecordStatus {
    InProgress,
    Completed,
}

#[derive(Debug, Clone)]
pub struct IdempotencyRecord {
    pub scope: String,
    pub idem_key: String,
    pub request_fingerprint: String,
    pub status: RecordStatus,
    pub response_status: Option<i32>,
    pub response_body: Option<String>,
    pub created_at: SystemTime,
    pub expires_at: SystemTime,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("record not found")]
    NotFound,
    #[error("record already exists")]
    AlreadyExists,
    #[error("database error: {0}")]
    DatabaseError(String),
    #[error("unimplemented")]
    Unimplemented,
}

pub trait Store: Send + Sync {
    fn insert_if_absent(&self, record: IdempotencyRecord) -> Result<(), StoreError>;
    fn get(&self, scope: &str, idem_key: &str) -> Result<Option<IdempotencyRecord>, StoreError>;
    fn update_completed(&self, scope: &str, idem_key: &str, status: i32, body: String) -> Result<(), StoreError>;
    fn delete(&self, scope: &str, idem_key: &str) -> Result<(), StoreError>;
    fn purge_expired(&self) -> Result<(), StoreError>;
}

#[derive(Default)]
pub struct InMemoryStore {
    records: Mutex<HashMap<(String, String), IdempotencyRecord>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }
}

impl Store for InMemoryStore {
    fn insert_if_absent(&self, record: IdempotencyRecord) -> Result<(), StoreError> {
        let mut records = self.records.lock().unwrap();
        let key = (record.scope.clone(), record.idem_key.clone());
        if records.contains_key(&key) {
            return Err(StoreError::AlreadyExists);
        }
        records.insert(key, record);
        Ok(())
    }

    fn get(&self, scope: &str, idem_key: &str) -> Result<Option<IdempotencyRecord>, StoreError> {
        let records = self.records.lock().unwrap();
        Ok(records.get(&(scope.to_string(), idem_key.to_string())).cloned())
    }

    fn update_completed(&self, scope: &str, idem_key: &str, status: i32, body: String) -> Result<(), StoreError> {
        let mut records = self.records.lock().unwrap();
        let key = (scope.to_string(), idem_key.to_string());
        if let Some(record) = records.get_mut(&key) {
            record.status = RecordStatus::Completed;
            record.response_status = Some(status);
            record.response_body = Some(body);
            Ok(())
        } else {
            Err(StoreError::NotFound)
        }
    }

    fn delete(&self, scope: &str, idem_key: &str) -> Result<(), StoreError> {
        let mut records = self.records.lock().unwrap();
        let key = (scope.to_string(), idem_key.to_string());
        if records.remove(&key).is_some() {
            Ok(())
        } else {
            Err(StoreError::NotFound)
        }
    }

    fn purge_expired(&self) -> Result<(), StoreError> {
        let now = SystemTime::now();
        let mut records = self.records.lock().unwrap();
        records.retain(|_, record| record.expires_at > now);
        Ok(())
    }
}

pub struct SqlStore {
    _private: (),
}

impl SqlStore {
    pub fn new(_: rusqlite::Connection) -> Result<Self, StoreError> {
        Err(StoreError::Unimplemented)
    }

    pub fn new_in_memory() -> Result<Self, StoreError> {
        Err(StoreError::Unimplemented)
    }
}

impl Store for SqlStore {
    fn insert_if_absent(&self, _record: IdempotencyRecord) -> Result<(), StoreError> {
        Err(StoreError::Unimplemented)
    }

    fn get(&self, _scope: &str, _idem_key: &str) -> Result<Option<IdempotencyRecord>, StoreError> {
        Err(StoreError::Unimplemented)
    }

    fn update_completed(&self, _scope: &str, _idem_key: &str, _status: i32, _body: String) -> Result<(), StoreError> {
        Err(StoreError::Unimplemented)
    }

    fn delete(&self, _scope: &str, _idem_key: &str) -> Result<(), StoreError> {
        Err(StoreError::Unimplemented)
    }

    fn purge_expired(&self) -> Result<(), StoreError> {
        Err(StoreError::Unimplemented)
    }
}

pub const SQL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS idempotency_records (
    scope TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
    response_status INTEGER,
    response_body TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (scope, idem_key)
);
"#;

pub fn compute_fingerprint(method: &str, path: &str, body: &str) -> String {
    let input = format!("{} {}\n{}", method, path, body);
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)
}

pub fn is_required(method: &str, path: &str) -> bool {
    let method_upper = method.to_uppercase();
    method_upper == "POST" || method_upper == "PATCH"
}

pub fn purge_expired(store: &dyn Store) -> Result<(), StoreError> {
    store.purge_expired()
}

pub fn handle<F>(
    store: &dyn Store,
    scope: String,
    idempotency_key: Option<String>,
    method: String,
    path: String,
    body: String,
    operation: F,
) -> (i32, String, String)
where
    F: FnOnce() -> Result<(i32, String), String>,
{
    let now = SystemTime::now();
    let expires_at = now + Duration::from_secs(24 * 60 * 60);

    if is_required(&method, &path) {
        if idempotency_key.is_none() {
            let problem_body = r#"{"type":"https://developer.example.com/idempotency","title":"Missing Idempotency-Key","detail":"The Idempotency-Key header is required for this operation."}"#;
            return (400, "application/problem+json".to_string(), problem_body.to_string());
        }
    }

    let idem_key = match idempotency_key {
        Some(k) => k,
        None => {
            match operation() {
                Ok((status, response_body)) => return (status, "application/json".to_string(), response_body),
                Err(e) => {
                    let problem_body = format!(
                        r#"{{"type":"https://developer.example.com/idempotency","title":"Operation Error","detail":"{}"}}"#,
                        e.replace('"', "\\\"")
                    );
                    return (500, "application/problem+json".to_string(), problem_body);
                }
            }
        }
    };

    let fingerprint = compute_fingerprint(&method, &path, &body);

    loop {
        match store.get(&scope, &idem_key) {
            Ok(Some(record)) => {
                if record.expires_at <= now {
                    let _ = store.delete(&scope, &idem_key);
                    continue;
                }
                match record.status {
                    RecordStatus::InProgress => {
                        let problem_body = r#"{"type":"https://developer.example.com/idempotency","title":"In Progress","detail":"The request is still being processed."}"#;
                        return (409, "application/problem+json".to_string(), problem_body.to_string());
                    }
                    RecordStatus::Completed => {
                        if record.request_fingerprint != fingerprint {
                            let problem_body = r#"{"type":"https://developer.example.com/idempotency","title":"Payload Mismatch","detail":"The request payload does not match the original request."}"#;
                            return (422, "application/problem+json".to_string(), problem_body.to_string());
                        }
                        return (
                            record.response_status.unwrap_or(500),
                            "application/json".to_string(),
                            record.response_body.unwrap_or_default(),
                        );
                    }
                }
            }
            Ok(None) => {
                // No existing record, proceed to create
            }
            Err(_) => {
                let problem_body = r#"{"type":"https://developer.example.com/idempotency","title":"Store Error","detail":"Failed to retrieve idempotency record."}"#;
                return (500, "application/problem+json".to_string(), problem_body.to_string());
            }
        }

        let new_record = IdempotencyRecord {
            scope: scope.clone(),
            idem_key: idem_key.clone(),
            request_fingerprint: fingerprint.clone(),
            status: RecordStatus::InProgress,
            response_status: None,
            response_body: None,
            created_at: now,
            expires_at,
        };

        match store.insert_if_absent(new_record) {
            Ok(()) => {
                match operation() {
                    Ok((status, response_body)) => {
                        let _ = store.update_completed(&scope, &idem_key, status, response_body.clone());
                        return (status, "application/json".to_string(), response_body);
                    }
                    Err(e) => {
                        let _ = store.delete(&scope, &idem_key);
                        let problem_body = format!(
                            r#"{{"type":"https://developer.example.com/idempotency","title":"Operation Error","detail":"{}"}}"#,
                            e.replace('"', "\\\"")
                        );
                        return (500, "application/problem+json".to_string(), problem_body);
                    }
                }
            }
            Err(StoreError::AlreadyExists) => {
                // Another thread claimed it first, loop and retry
                continue;
            }
            Err(_) => {
                let problem_body = r#"{"type":"https://developer.example.com/idempotency","title":"Store Error","detail":"Failed to claim idempotency key."}"#;
                return (500, "application/problem+json".to_string(), problem_body.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, Duration};

    fn make_store() -> Arc<InMemoryStore> {
        Arc::new(InMemoryStore::new())
    }

    fn make_operation(counter: Arc<AtomicUsize>) -> impl FnOnce() -> Result<(i32, String), String> {
        move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok((200, "{\"result\":\"success\"}".to_string()))
        }
    }

    #[test]
    fn test_first_call_runs_operation_once() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));
        let operation = make_operation(counter.clone());

        let (status, content_type, body) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation,
        );

        assert_eq!(status, 200);
        assert_eq!(content_type, "application/json");
        assert_eq!(body, "{\"result\":\"success\"}");
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_second_identical_call_returns_stored_response() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation1 = make_operation(counter.clone());
        let (status1, _, body1) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation1,
        );
        assert_eq!(status1, 200);
        assert_eq!(body1, "{\"result\":\"success\"}");

        let operation2 = make_operation(counter.clone());
        let (status2, content_type2, body2) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation2,
        );

        assert_eq!(status2, 200);
        assert_eq!(content_type2, "application/json");
        assert_eq!(body2, "{\"result\":\"success\"}");
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_same_key_different_body_returns_422() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation1 = make_operation(counter.clone());
        let _ = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation1,
        );

        let operation2 = make_operation(counter.clone());
        let (status, content_type, body) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":200}".to_string(),
            operation2,
        );

        assert_eq!(status, 422);
        assert_eq!(content_type, "application/problem+json");
        assert!(body.contains("\"type\""));
        assert!(body.contains("\"title\""));
        assert!(body.contains("\"detail\""));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_same_key_while_in_progress_returns_409() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation1 = make_operation(counter.clone());
        let _ = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation1,
        );

        let operation2 = make_operation(counter.clone());
        let (status, content_type, body) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation2,
        );

        assert_eq!(status, 409);
        assert_eq!(content_type, "application/problem+json");
        assert!(body.contains("\"type\""));
        assert!(body.contains("\"title\""));
        assert!(body.contains("\"detail\""));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_required_operation_with_no_key_returns_400() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation = make_operation(counter.clone());
        let (status, content_type, body) = handle(
            &*store,
            "client1".to_string(),
            None,
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation,
        );

        assert_eq!(status, 400);
        assert_eq!(content_type, "application/problem+json");
        assert!(body.contains("\"type\""));
        assert!(body.contains("\"title\""));
        assert!(body.contains("\"detail\""));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_same_key_under_different_scopes_runs_twice() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation1 = make_operation(counter.clone());
        let _ = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation1,
        );

        let operation2 = make_operation(counter.clone());
        let (status, _, body) = handle(
            &*store,
            "client2".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation2,
        );

        assert_eq!(status, 200);
        assert_eq!(body, "{\"result\":\"success\"}");
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn test_expired_key_runs_operation_again() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation1 = make_operation(counter.clone());
        let _ = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation1,
        );

        {
            let mut records = store.records.lock().unwrap();
            if let Some(record) = records.get_mut(&("client1".to_string(), "key1".to_string())) {
                record.expires_at = SystemTime::now() - Duration::from_secs(1);
            }
        }

        let operation2 = make_operation(counter.clone());
        let (status, _, body) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation2,
        );

        assert_eq!(status, 200);
        assert_eq!(body, "{\"result\":\"success\"}");
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn test_operation_that_raises_frees_key() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let failing_operation = || {
            counter.fetch_add(1, Ordering::SeqCst);
            Err("operation failed".to_string())
        };

        let (status, content_type, body) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            failing_operation,
        );

        assert_eq!(status, 500);
        assert_eq!(content_type, "application/problem+json");
        assert!(body.contains("\"type\""));
        assert!(body.contains("\"title\""));
        assert!(body.contains("\"detail\""));

        let success_operation = make_operation(counter.clone());
        let (status2, _, body2) = handle(
            &*store,
            "client1".to_string(),
            Some("key1".to_string()),
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            success_operation,
        );

        assert_eq!(status2, 200);
        assert_eq!(body2, "{\"result\":\"success\"}");
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn test_error_responses_carry_problem_json_content_type() {
        let store = make_store();
        let counter = Arc::new(AtomicUsize::new(0));

        let operation = make_operation(counter.clone());
        let (status, content_type, body) = handle(
            &*store,
            "client1".to_string(),
            None,
            "POST".to_string(),
            "/charge".to_string(),
            "{\"amount\":100}".to_string(),
            operation,
        );

        assert_eq!(status, 400);
        assert_eq!(content_type, "application/problem+json");
        assert!(body.contains("\"type\""));
        assert!(body.contains("\"title\""));
        assert!(body.contains("\"detail\""));
    }
}