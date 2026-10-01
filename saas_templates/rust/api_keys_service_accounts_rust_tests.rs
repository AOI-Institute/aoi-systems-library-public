use super::*;
use sqlx::PgPool;
use redis::Client;
use uuid::Uuid;

#[tokio::test]
async fn test_create_key_with_scopes() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string(), "write:webhooks".to_string()],
        expires_at: Some("2026-12-31T23:59:59Z".to_string()),
        rate_limit: 1000,
    };
    
    let response = db.create_api_key(user_id, create_req).await.unwrap();
    
    assert!(!response.api_key_id.is_empty());
    assert!(response.key.starts_with("sk_live_"));
    assert_eq!(response.rate_limit, 1000);
    assert!(response.expires_at.is_some());
}

#[tokio::test]
async fn test_use_key_with_authorization_header() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: None,
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    
    let result = db.use_api_key(&create_response.key, "/api/deployments", "GET").await;
    
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_revoke_key() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: None,
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    let api_key_id = Uuid::parse_str(&create_response.api_key_id).unwrap();
    
    let revoke_response = db.revoke_api_key(api_key_id, user_id).await.unwrap();
    
    assert!(revoke_response.success);
    
    let result = db.use_api_key(&create_response.key, "/api/deployments", "GET").await;
    
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("API key is not active"));
}

#[tokio::test]
async fn test_rate_limit() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: None,
        rate_limit: 2,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    
    let result1 = db.use_api_key(&create_response.key, "/api/deployments", "GET").await;
    assert!(result1.is_ok());
    
    let result2 = db.use_api_key(&create_response.key, "/api/deployments", "GET").await;
    assert!(result2.is_ok());
    
    let result3 = db.use_api_key(&create_response.key, "/api/deployments", "GET").await;
    assert!(result3.is_err());
    assert!(result3.unwrap_err().to_string().contains("Rate limit exceeded"));
}

#[tokio::test]
async fn test_scope_check() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: None,
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    
    let result = db.use_api_key(&create_response.key, "/api/deployments", "POST").await;
    
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("API key does not have permission"));
}

#[tokio::test]
async fn test_rotate_key() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: None,
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    let api_key_id = Uuid::parse_str(&create_response.api_key_id).unwrap();
    
    let rotate_response = db.rotate_api_key(api_key_id, user_id).await.unwrap();
    
    assert!(!rotate_response.new_key.is_empty());
    assert!(rotate_response.new_key.starts_with("sk_live_"));
    assert!(!rotate_response.old_key_revoked_at.is_empty());
    assert!(!rotate_response.grace_period_ends_at.is_empty());
    
    let result = db.use_api_key(&rotate_response.new_key, "/api/deployments", "GET").await;
    
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_expired_key() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: Some("2020-01-01T00:00:00Z".to_string()),
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    
    let result = db.use_api_key(&create_response.key, "/api/deployments", "GET").await;
    
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("API key is not active"));
}

#[tokio::test]
async fn test_usage_stats() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string(), "write:webhooks".to_string()],
        expires_at: None,
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    let api_key_id = Uuid::parse_str(&create_response.api_key_id).unwrap();
    
    db.use_api_key(&create_response.key, "/api/deployments", "GET").await.unwrap();
    db.use_api_key(&create_response.key, "/api/deployments", "GET").await.unwrap();
    db.use_api_key(&create_response.key, "/api/webhooks", "POST").await.unwrap();
    
    let stats = db.get_usage_stats(api_key_id, "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z").await.unwrap();
    
    assert_eq!(stats.api_key_id, api_key_id.to_string());
    assert_eq!(stats.total_requests, 3);
    assert!(stats.requests_by_endpoint.contains_key("GET /api/deployments"));
    assert_eq!(stats.requests_by_endpoint["GET /api/deployments"], 2);
    assert!(stats.requests_by_endpoint.contains_key("POST /api/webhooks"));
    assert_eq!(stats.requests_by_endpoint["POST /api/webhooks"], 1);
}

#[tokio::test]
async fn test_admin_audit() {
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:password@localhost/test".to_string());
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    
    let db = Database::new(&database_url, &redis_url).await.unwrap();
    
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "Test Integration".to_string(),
        scopes: vec!["read:deployments".to_string()],
        expires_at: None,
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await.unwrap();
    
    let admin_response = db.admin_list_api_keys(Some(user_id), Some("active".to_string())).await.unwrap();
    
    assert_eq!(admin_response.total, 1);
    assert_eq!(admin_response.keys[0].id.to_string(), create_response.api_key_id);
}