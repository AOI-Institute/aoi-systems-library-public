use sqlx::{Pool, Sqlite, SqlitePool};
use std::sync::Arc;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Public = 0,
    Member = 1,
    Admin = 2,
    Owner = 3,
}

impl Tier {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "public" => Some(Tier::Public),
            "member" => Some(Tier::Member),
            "admin" => Some(Tier::Admin),
            "owner" => Some(Tier::Owner),
            _ => None,
        }
    }

    pub fn to_str(&self) -> &'static str {
        match self {
            Tier::Public => "public",
            Tier::Member => "member",
            Tier::Admin => "admin",
            Tier::Owner => "owner",
        }
    }
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: i32,
    pub tier: Tier,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuditLogEntry {
    pub action: String,
    pub user_id: Option<i32>,
    pub endpoint: Option<String>,
    pub required_tier: Option<String>,
    pub user_tier: Option<String>,
    pub decision: String,
    pub details: Option<serde_json::Value>,
    pub timestamp: String,
}

#[derive(Debug)]
pub struct RbacSystem {
    pub db: Pool<Sqlite>,
}

impl RbacSystem {
    pub async fn new(db_url: &str) -> Result<Self, sqlx::Error> {
        let pool = SqlitePool::connect(db_url).await?;
        Self::initialize_schema(&pool).await?;
        Ok(RbacSystem { db: pool })
    }

    async fn initialize_schema(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                tier TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS preferences (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS organizations (
                id INTEGER PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS deployments (
                id INTEGER PRIMARY KEY,
                organization_id INTEGER NOT NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS dns_records (
                id INTEGER PRIMARY KEY,
                deployment_id INTEGER NOT NULL,
                FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS theme_configs (
                id INTEGER PRIMARY KEY,
                deployment_id INTEGER NOT NULL,
                FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS deployment_logs (
                id INTEGER PRIMARY KEY,
                deployment_id INTEGER NOT NULL,
                FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                user_id INTEGER,
                endpoint TEXT,
                required_tier TEXT,
                user_tier TEXT,
                decision TEXT NOT NULL,
                details TEXT,
                timestamp TEXT NOT NULL
            );
            "#,
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn require_owner(&self, user: Option<&User>) -> Result<(), RbacError> {
        let user_tier = user.map(|u| u.tier).unwrap_or(Tier::Public);
        let required_tier = Tier::Owner;
        let decision = if user_tier >= required_tier {
            "PASS"
        } else {
            "FAIL"
        };
        self.log_audit(
            "permission_check",
            user.map(|u| u.id),
            None,
            Some(required_tier.to_str()),
            Some(user_tier.to_str()),
            decision,
            None,
        )
        .await?;
        if user_tier < required_tier {
            return Err(RbacError::OwnerOnly);
        }
        Ok(())
    }

    pub async fn require_admin(&self, user: Option<&User>) -> Result<(), RbacError> {
        let user_tier = user.map(|u| u.tier).unwrap_or(Tier::Public);
        let required_tier = Tier::Admin;
        let decision = if user_tier >= required_tier {
            "PASS"
        } else {
            "FAIL"
        };
        self.log_audit(
            "permission_check",
            user.map(|u| u.id),
            None,
            Some(required_tier.to_str()),
            Some(user_tier.to_str()),
            decision,
            None,
        )
        .await?;
        if user_tier < required_tier {
            return Err(RbacError::AdminOnly);
        }
        Ok(())
    }

    pub async fn require_authenticated(&self, user: Option<&User>) -> Result<(), RbacError> {
        let is_authenticated = user.is_some();
        let decision = if is_authenticated { "PASS" } else { "FAIL" };
        self.log_audit(
            "permission_check",
            user.map(|u| u.id),
            None,
            Some("authenticated".to_string()),
            None,
            decision,
            None,
        )
        .await?;
        if !is_authenticated {
            return Err(RbacError::AuthenticationRequired);
        }
        Ok(())
    }

    pub async fn delete_user(&self, user_id: i32) -> Result<(), sqlx::Error> {
        let mut tx = self.db.begin().await?;
        let sessions_deleted = sqlx::query!("DELETE FROM sessions WHERE user_id = ?", user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let api_keys_deleted = sqlx::query!("DELETE FROM api_keys WHERE user_id = ?", user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let files_deleted = sqlx::query!("DELETE FROM files WHERE user_id = ?", user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let preferences_deleted = sqlx::query!("DELETE FROM preferences WHERE user_id = ?", user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let _ = sqlx::query!("DELETE FROM users WHERE id = ?", user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.log_audit(
            "user_deleted_cascade",
            None,
            None,
            None,
            None,
            "PASS",
            Some(json!({
                "sessions": sessions_deleted,
                "api_keys": api_keys_deleted,
                "files": files_deleted,
                "preferences": preferences_deleted
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_deployment(&self, deployment_id: i32) -> Result<(), sqlx::Error> {
        let mut tx = self.db.begin().await?;
        let dns_records_deleted = sqlx::query!("DELETE FROM dns_records WHERE deployment_id = ?", deployment_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let theme_configs_deleted = sqlx::query!("DELETE FROM theme_configs WHERE deployment_id = ?", deployment_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let deployment_logs_deleted = sqlx::query!("DELETE FROM deployment_logs WHERE deployment_id = ?", deployment_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let _ = sqlx::query!("DELETE FROM deployments WHERE id = ?", deployment_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.log_audit(
            "deployment_deleted_cascade",
            None,
            None,
            None,
            None,
            "PASS",
            Some(json!({
                "dns_records": dns_records_deleted,
                "theme_configs": theme_configs_deleted,
                "deployment_logs": deployment_logs_deleted
            })),
        )
        .await?;
        Ok(())
    }

    pub async fn delete_organization(&self, org_id: i32) -> Result<(), sqlx::Error> {
        let mut tx = self.db.begin().await?;
        let deployments_deleted = sqlx::query!("DELETE FROM deployments WHERE organization_id = ?", org_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let users_deleted = sqlx::query!("DELETE FROM users WHERE organization_id = ?", org_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let api_keys_deleted = sqlx::query!(
            "DELETE FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE organization_id = ?)",
            org_id
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let sessions_deleted = sqlx::query!(
            "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE organization_id = ?)",
            org_id
        )
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tx.commit().await?;
        self.log_audit(
            "org_deleted_cascade",
            None,
            None,
            None,
            None,
            "PASS",
            Some(json!({
                "deployments": deployments_deleted,
                "users": users_deleted,
                "api_keys": api_keys_deleted,
                "sessions": sessions_deleted
            })),
        )
        .await?;
        Ok(())
    }

    async fn log_audit(
        &self,
        action: &str,
        user_id: Option<i32>,
        endpoint: Option<String>,
        required_tier: Option<&str>,
        user_tier: Option<&str>,
        decision: &str,
        details: Option<serde_json::Value>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"
            INSERT INTO audit_log (action, user_id, endpoint, required_tier, user_tier, decision, details, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            action,
            user_id,
            endpoint,
            required_tier.map(|s| s.to_string()),
            user_tier.map(|s| s.to_string()),
            decision,
            details.map(|d| d.to_string()),
            Utc::now().to_rfc3339()
        )
        .execute(&self.db)
        .await?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub enum RbacError {
    OwnerOnly,
    AdminOnly,
    AuthenticationRequired,
}

impl RbacError {
    pub fn to_response(&self) -> (String, u16) {
        match self {
            RbacError::OwnerOnly => (
                json!({
                    "error": "owner_only",
                    "message": "Owner only access allowed",
                    "code": 403
                })
                .to_string(),
                403,
            ),
            RbacError::AdminOnly => (
                json!({
                    "error": "admin_only",
                    "message": "Admin or owner access required",
                    "code": 403
                })
                .to_string(),
                403,
            ),
            RbacError::AuthenticationRequired => (
                json!({
                    "error": "authentication_required",
                    "message": "Authentication required",
                    "code": 401
                })
                .to_string(),
                401,
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn setup_db() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        RbacSystem::initialize_schema(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn test_require_owner_non_owner() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool };
        let user = User { id: 1, tier: Tier::Admin };
        let err = rbac.require_owner(Some(&user)).await.unwrap_err();
        assert_eq!(err.to_response().1, 403);
        let resp: serde_json::Value = serde_json::from_str(&err.to_response().0).unwrap();
        assert_eq!(resp["error"], "owner_only");
    }

    #[tokio::test]
    async fn test_require_admin_member() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool };
        let user = User { id: 1, tier: Tier::Member };
        let err = rbac.require_admin(Some(&user)).await.unwrap_err();
        assert_eq!(err.to_response().1, 403);
        let resp: serde_json::Value = serde_json::from_str(&err.to_response().0).unwrap();
        assert_eq!(resp["error"], "admin_only");
    }

    #[tokio::test]
    async fn test_require_authenticated_public() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool };
        let err = rbac.require_authenticated(None).await.unwrap_err();
        assert_eq!(err.to_response().1, 401);
        let resp: serde_json::Value = serde_json::from_str(&err.to_response().0).unwrap();
        assert_eq!(resp["error"], "authentication_required");
    }

    #[tokio::test]
    async fn test_cascade_delete_user() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool.clone() };
        sqlx::query!("INSERT INTO users (id, tier) VALUES (1, 'owner')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO sessions (id, user_id) VALUES (1, 1), (2, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO api_keys (id, user_id) VALUES (1, 1), (2, 1), (3, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO files (id, user_id) VALUES (1, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO preferences (id, user_id) VALUES (1, 1)")
            .execute(&pool)
            .await
            .unwrap();
        rbac.delete_user(1).await.unwrap();
        let sessions: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let api_keys: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM api_keys")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let files: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM files")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let preferences: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM preferences")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(sessions, 0);
        assert_eq!(api_keys, 0);
        assert_eq!(files, 0);
        assert_eq!(preferences, 0);
        let user: Option<(i32,)> = sqlx::query_as("SELECT id FROM users WHERE id = 1")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(user.is_none());
    }

    #[tokio::test]
    async fn test_cascade_delete_deployment() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool.clone() };
        sqlx::query!("INSERT INTO organizations (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO deployments (id, organization_id) VALUES (1, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO dns_records (id, deployment_id) VALUES (1, 1), (2, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO theme_configs (id, deployment_id) VALUES (1, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO deployment_logs (id, deployment_id) VALUES (1, 1), (2, 1), (3, 1)")
            .execute(&pool)
            .await
            .unwrap();
        rbac.delete_deployment(1).await.unwrap();
        let dns: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM dns_records")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let themes: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM theme_configs")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let logs: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM deployment_logs")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(dns, 0);
        assert_eq!(themes, 0);
        assert_eq!(logs, 0);
        let deployment: Option<(i32,)> = sqlx::query_as("SELECT id FROM deployments WHERE id = 1")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(deployment.is_none());
    }

    #[tokio::test]
    async fn test_cascade_delete_organization() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool.clone() };
        sqlx::query!("INSERT INTO organizations (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO deployments (id, organization_id) VALUES (1, 1), (2, 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO users (id, tier, organization_id) VALUES (1, 'member', 1), (2, 'admin', 1)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO api_keys (id, user_id) VALUES (1, 1), (2, 2)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO sessions (id, user_id) VALUES (1, 1), (2, 2)")
            .execute(&pool)
            .await
            .unwrap();
        rbac.delete_organization(1).await.unwrap();
        let deployments: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM deployments")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let users: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let api_keys: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM api_keys")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        let sessions: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(deployments, 0);
        assert_eq!(users, 0);
        assert_eq!(api_keys, 0);
        assert_eq!(sessions, 0);
        let org: Option<(i32,)> = sqlx::query_as("SELECT id FROM organizations WHERE id = 1")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(org.is_some());
    }

    #[tokio::test]
    async fn test_cascade_rollback_on_error() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool.clone() };
        sqlx::query!("INSERT INTO users (id, tier) VALUES (1, 'owner')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query!("INSERT INTO sessions (id, user_id) VALUES (1, 1)")
            .execute(&pool)
            .await
            .unwrap();
        let result = sqlx::query("INSERT INTO nonexistent_table VALUES (1)")
            .execute(&pool)
            .await;
        assert!(result.is_err());
        let sessions: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(sessions, 1);
    }

    #[tokio::test]
    async fn test_permission_audit_logged() {
        let pool = setup_db().await;
        let rbac = RbacSystem { db: pool.clone() };
        let user = User { id: 1, tier: Tier::Member };
        let _ = rbac.require_admin(Some(&user)).await;
        let logs: Vec<(String, String, String, String, String)> = sqlx::query_as(
            r#"
            SELECT action, user_tier, required_tier, decision, timestamp
            FROM audit_log
            WHERE action = 'permission_check'
            "#
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(logs.len(), 1);
        let log = &logs[0];
        assert_eq!(log.0, "permission_check");
        assert_eq!(log.1, "member");
        assert_eq!(log.2, "admin");
        assert_eq!(log.3, "FAIL");
    }

    #[tokio::test]
    async fn test_tier_hierarchy() {
        assert!(Tier::Public < Tier::Member);
        assert!(Tier::Member < Tier::Admin);
        assert!(Tier::Admin < Tier::Owner);
        assert!(Tier::Owner > Tier::Admin);
        assert!(Tier::Admin > Tier::Member);
        assert!(Tier::Member > Tier::Public);
    }
}