use bcrypt::{hash, verify, DEFAULT_COST};
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use redis::{Commands, RedisResult};
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, Pool, Postgres, Row};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
struct ApiKey {
    id: Uuid,
    user_id: Uuid,
    name: String,
    key_secret_hash: String,
    scopes: serde_json::Value,
    rate_limit: i32,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    is_active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApiKeyUsage {
    id: Uuid,
    api_key_id: Uuid,
    endpoint: String,
    method: String,
    status: String,
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateApiKeyRequest {
    name: String,
    scopes: Vec<String>,
    expires_at: Option<String>,
    rate_limit: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateApiKeyResponse {
    api_key_id: String,
    key: String,
    created_at: String,
    expires_at: Option<String>,
    rate_limit: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct ListApiKeysResponse {
    keys: Vec<ApiKeyInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApiKeyInfo {
    api_key_id: String,
    name: String,
    scopes: serde_json::Value,
    created_at: String,
    last_used_at: Option<String>,
    rate_limit: i32,
    is_active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct RevokeApiKeyResponse {
    success: bool,
    revoked_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct RotateApiKeyResponse {
    new_key: String,
    old_key_revoked_at: String,
    grace_period_ends_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct UsageStatsResponse {
    api_key_id: String,
    total_requests: i64,
    requests_by_endpoint: HashMap<String, i64>,
    rate_limit_hits: i64,
    errors: HashMap<String, i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AdminListApiKeysResponse {
    keys: Vec<ApiKey>,
    total: i64,
}

#[derive(Debug)]
struct Database {
    pool: Pool<Postgres>,
    redis_client: redis::Client,
}

impl Database {
    async fn new(database_url: &str, redis_url: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;

        let redis_client = redis::Client::open(redis_url)?;

        let db = Database { pool, redis_client };
        db.init().await?;
        Ok(db)
    }

    async fn init(&self) -> Result<(), Box<dyn std::error::Error>> {
        // Create api_keys table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS api_keys (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL,
                name VARCHAR NOT NULL,
                key_secret_hash VARCHAR NOT NULL,
                scopes JSON NOT NULL,
                rate_limit INTEGER NOT NULL,
                expires_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                last_used_at TIMESTAMP,
                is_active BOOLEAN NOT NULL DEFAULT TRUE
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        // Create api_key_usage table
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS api_key_usage (
                id UUID PRIMARY KEY,
                api_key_id UUID NOT NULL,
                endpoint VARCHAR NOT NULL,
                method VARCHAR NOT NULL,
                status VARCHAR NOT NULL,
                timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
                FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn create_api_key(
        &self,
        user_id: Uuid,
        req: CreateApiKeyRequest,
    ) -> Result<CreateApiKeyResponse, Box<dyn std::error::Error>> {
        let key_secret = generate_api_key_secret();
        let key_secret_hash = hash(&key_secret, DEFAULT_COST)?;

        let scopes_json = serde_json::to_value(req.scopes)?;
        let expires_at = req.expires_at
            .as_ref()
            .map(|s| DateTime::parse_from_rfc3339(s).map(|dt| dt.with_timezone(&Utc)))
            .transpose()?;

        let api_key_id = Uuid::new_v4();
        let created_at = Utc::now();

        sqlx::query(
            r#"
            INSERT INTO api_keys (
                id, user_id, name, key_secret_hash, scopes, 
                rate_limit, expires_at, created_at, is_active
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(api_key_id)
        .bind(user_id)
        .bind(req.name)
        .bind(key_secret_hash)
        .bind(scopes_json)
        .bind(req.rate_limit)
        .bind(expires_at)
        .bind(created_at)
        .execute(&self.pool)
        .await?;

        let response = CreateApiKeyResponse {
            api_key_id: api_key_id.to_string(),
            key: key_secret,
            created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc),
            expires_at: expires_at.map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc)),
            rate_limit: req.rate_limit,
        };

        Ok(response)
    }

    async fn list_api_keys(
        &self,
        user_id: Uuid,
    ) -> Result<ListApiKeysResponse, Box<dyn std::error::Error>> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, scopes, created_at, last_used_at, rate_limit, is_active
            FROM api_keys
            WHERE user_id = $1
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        let mut keys = Vec::new();
        for row in rows {
            let api_key_id: Uuid = row.get("id");
            let name: String = row.get("name");
            let scopes: serde_json::Value = row.get("scopes");
            let created_at: DateTime<Utc> = row.get("created_at");
            let last_used_at: Option<DateTime<Utc>> = row.get("last_used_at");
            let rate_limit: i32 = row.get("rate_limit");
            let is_active: bool = row.get("is_active");

            keys.push(ApiKeyInfo {
                api_key_id: api_key_id.to_string(),
                name,
                scopes,
                created_at: created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc),
                last_used_at: last_used_at.map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc)),
                rate_limit,
                is_active,
            });
        }

        Ok(ListApiKeysResponse { keys })
    }

    async fn revoke_api_key(
        &self,
        api_key_id: Uuid,
        user_id: Uuid,
    ) -> Result<RevokeApiKeyResponse, Box<dyn std::error::Error>> {
        let revoked_at = Utc::now();

        let result = sqlx::query(
            r#"
            UPDATE api_keys
            SET is_active = FALSE
            WHERE id = $1 AND user_id = $2
            RETURNING id, is_active
            "#,
        )
        .bind(api_key_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;

        let is_active: bool = result.get("is_active");

        let response = RevokeApiKeyResponse {
            success: !is_active,
            revoked_at: revoked_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc),
        };

        Ok(response)
    }

    async fn rotate_api_key(
        &self,
        api_key_id: Uuid,
        user_id: Uuid,
    ) -> Result<RotateApiKeyResponse, Box<dyn std::error::Error>> {
        let old_key_revoked_at = Utc::now();
        let grace_period_ends_at = old_key_revoked_at + Duration::hours(24);

        let old_key: ApiKey = sqlx::query_as(
            r#"
            SELECT *
            FROM api_keys
            WHERE id = $1 AND user_id = $2
            "#,
        )
        .bind(api_key_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;

        let new_key_secret = generate_api_key_secret();
        let new_key_secret_hash = hash(&new_key_secret, DEFAULT_COST)?;

        sqlx::query(
            r#"
            UPDATE api_keys
            SET key_secret_hash = $1, is_active = TRUE
            WHERE id = $2
            "#,
        )
        .bind(new_key_secret_hash)
        .bind(api_key_id)
        .execute(&self.pool)
        .await?;

        let response = RotateApiKeyResponse {
            new_key: new_key_secret,
            old_key_revoked_at: old_key_revoked_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc),
            grace_period_ends_at: grace_period_ends_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, Utc),
        };

        Ok(response)
    }

    async fn use_api_key(
        &self,
        key_secret: &str,
        endpoint: &str,
        method: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let api_key: ApiKey = sqlx::query_as(
            r#"
            SELECT *
            FROM api_keys
            WHERE key_secret_hash = (
                SELECT key_secret_hash
                FROM api_keys
                WHERE key_secret_hash = crypt($1, key_secret_hash)
            )
            "#,
        )
        .bind(key_secret)
        .fetch_one(&self.pool)
        .await?;

        if !api_key.is_active {
            return Err("API key is not active".into());
        }

        let scopes: serde_json::Value = api_key.scopes;
        let scope_key = format!("{}:{}", method.to_lowercase(), endpoint);
        
        if !scopes.get(&scope_key).unwrap_or(&serde_json::Value::Bool(false)).as_bool().unwrap_or(false) {
            return Err("API key does not have permission for this endpoint".into());
        }

        let rate_limit_key = format!("rate_limit:{}:{}", api_key.id, Utc::now().format("%Y-%m-%dT%H:00:00"));
        let mut redis_conn = self.redis_client.get_connection()?;
        
        let current_count: i32 = redis_conn.get(&rate_limit_key).unwrap_or(0);
        
        if current_count >= api_key.rate_limit {
            return Err("Rate limit exceeded".into());
        }

        redis_conn.incr(&rate_limit_key, 1)?;
        redis_conn.expire(&rate_limit_key, 3600)?;

        let usage_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO api_key_usage (id, api_key_id, endpoint, method, status)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(usage_id)
        .bind(api_key.id)
        .bind(endpoint)
        .bind(method)
        .bind("200")
        .execute(&self.pool)
        .await?;

        let last_used_at = Utc::now();
        sqlx::query(
            r#"
            UPDATE api_keys
            SET last_used_at = $1
            WHERE id = $2
            "#,
        )
        .bind(last_used_at)
        .bind(api_key.id)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn get_usage_stats(
        &self,
        api_key_id: Uuid,
        from: &str,
        to: &str,
    ) -> Result<UsageStatsResponse, Box<dyn std::error::Error>> {
        let from_dt = DateTime::parse_from_rfc3339(from)?.with_timezone(&Utc);
        let to_dt = DateTime::parse_from_rfc3339(to)?.with_timezone(&Utc);

        let rows = sqlx::query(
            r#"
            SELECT 
                endpoint, method, status, COUNT(*) as count
            FROM api_key_usage
            WHERE api_key_id = $1 AND timestamp BETWEEN $2 AND $3
            GROUP BY endpoint, method, status
            "#,
        )
        .bind(api_key_id)
        .bind(from_dt)
        .bind(to_dt)
        .fetch_all(&self.pool)
        .await?;

        let mut total_requests = 0;
        let mut requests_by_endpoint: HashMap<String, i64> = HashMap::new();
        let mut errors: HashMap<String, i64> = HashMap::new();
        let mut rate_limit_hits = 0;

        for row in rows {
            let endpoint: String = row.get("endpoint");
            let method: String = row.get("method");
            let status: String = row.get("status");
            let count: i64 = row.get("count");

            total_requests += count;
            
            let endpoint_key = format!("{} {}", method, endpoint);
            *requests_by_endpoint.entry(endpoint_key).or_insert(0) += count;
            
            if status.starts_with('4') || status.starts_with('5') {
                *errors.entry(status).or_insert(0) += count;
            }
            
            if status == "429" {
                rate_limit_hits += count;
            }
        }

        let response = UsageStatsResponse {
            api_key_id: api_key_id.to_string(),
            total_requests,
            requests_by_endpoint,
            rate_limit_hits,
            errors,
        };

        Ok(response)
    }

    async fn admin_list_api_keys(
        &self,
        user_id: Option<Uuid>,
        status: Option<String>,
    ) -> Result<AdminListApiKeysResponse, Box<dyn std::error::Error>> {
        let mut query = String::from(
            r#"
            SELECT *
            FROM api_keys
            WHERE 1=1
            "#,
        );
        
        let mut params: Vec<sqlx::types::Uuid> = Vec::new();
        
        if let Some(uid) = user_id {
            query.push_str(" AND user_id = $1");
            params.push(uid);
        }
        
        if let Some(st) = status {
            query.push_str(" AND is_active = $2");
            params.push(st.parse::<bool>().unwrap_or(true).to_string().parse::<Uuid>().unwrap_or(Uuid::nil()));
        }
        
        query.push_str(" ORDER BY created_at DESC");
        
        let mut query_builder = sqlx::query_as::<_, ApiKey>(&query);
        
        for param in params {
            query_builder = query_builder.bind(param);
        }
        
        let keys = query_builder.fetch_all(&self.pool).await?;
        
        let total = keys.len() as i64;
        
        let response = AdminListApiKeysResponse {
            keys,
            total,
        };
        
        Ok(response)
    }
}

fn generate_api_key_secret() -> String {
    let mut rng = rand::thread_rng();
    let mut key = String::from("sk_live_");
    
    for _ in 0..32 {
        let c = rng.gen_range(b'0'..b'f');
        key.push(c as char);
    }
    
    key
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")?;
    let redis_url = std::env::var("REDIS_URL")?;
    
    let db = Database::new(&database_url, &redis_url).await?;
    
    // Example usage
    let user_id = Uuid::new_v4();
    
    let create_req = CreateApiKeyRequest {
        name: "My Integration".to_string(),
        scopes: vec!["read:deployments".to_string(), "write:webhooks".to_string()],
        expires_at: Some("2026-12-31T23:59:59Z".to_string()),
        rate_limit: 1000,
    };
    
    let create_response = db.create_api_key(user_id, create_req).await?;
    println!("Created API key: {:?}", create_response);
    
    let list_response = db.list_api_keys(user_id).await?;
    println!("Listed API keys: {:?}", list_response);
    
    let api_key_id = Uuid::parse_str(&create_response.api_key_id)?;
    let revoke_response = db.revoke_api_key(api_key_id, user_id).await?;
    println!("Revoked API key: {:?}", revoke_response);
    
    let rotate_response = db.rotate_api_key(api_key_id, user_id).await?;
    println!("Rotated API key: {:?}", rotate_response);
    
    let usage_response = db.get_usage_stats(api_key_id, "2026-09-01T00:00:00Z", "2026-09-24T23:59:59Z").await?;
    println!("Usage stats: {:?}", usage_response);
    
    let admin_response = db.admin_list_api_keys(None, Some("active".to_string())).await?;
    println!("Admin list: {:?}", admin_response);
    
    Ok(())
}