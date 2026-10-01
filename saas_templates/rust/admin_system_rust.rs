use chrono::{DateTime, Utc};
use regex::Regex;
use rusqlite::{params, Connection, Result as SqlResult, NO_PARAMS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;

// ---------- Types ----------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Role {
    Owner,
    Admin,
    User,
}
impl Role {
    fn as_str(&self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::User => "user",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Tier {
    Basic,
    Premium,
    Enterprise,
}
impl Tier {
    fn as_str(&self) -> &'static str {
        match self {
            Tier::Basic => "basic",
            Tier::Premium => "premium",
            Tier::Enterprise => "enterprise",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub email: String,
    pub name: String,
    pub tier: Tier,
    pub status: String,
    pub created_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Customer {
    pub id: i64,
    pub email: String,
    pub name: String,
    pub tier: Tier,
    pub signup_date: DateTime<Utc>,
    pub invoice_count: i64,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deployment {
    pub id: i64,
    pub customer_id: i64,
    pub domain: String,
    pub tier: Tier,
    pub status: String,
    pub theme: String,
    pub published_at: Option<DateTime<Utc>>,
    pub suspend_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GovernanceAction {
    pub id: i64,
    pub action_type: String,
    pub actor_id: i64,
    pub target_resource_id: i64,
    pub reason: String,
    pub submitted_at: DateTime<Utc>,
    pub status: String,
    pub approved_by: Option<i64>,
    pub approved_at: Option<DateTime<Utc>>,
    pub rejection_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLog {
    pub id: i64,
    pub action: String,
    pub actor_id: i64,
    pub resource_type: String,
    pub resource_id: i64,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub reason: Option<String>,
    pub timestamp: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Refund {
    pub id: i64,
    pub invoice_id: i64,
    pub amount: i64,
    pub reason: String,
    pub created_by: i64,
    pub created_at: DateTime<Utc>,
    pub status: String,
}

// ---------- Errors ----------
#[derive(Debug)]
pub enum AdminError {
    Unauthorized,
    Forbidden(String),
    NotFound(String),
    Validation(String),
    Conflict(String),
    Internal(String),
}
impl std::fmt::Display for AdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdminError::Unauthorized => write!(f, "unauthorized"),
            AdminError::Forbidden(msg) => write!(f, "forbidden: {}", msg),
            AdminError::NotFound(msg) => write!(f, "not_found: {}", msg),
            AdminError::Validation(msg) => write!(f, "validation: {}", msg),
            AdminError::Conflict(msg) => write!(f, "conflict: {}", msg),
            AdminError::Internal(msg) => write!(f, "internal: {}", msg),
        }
    }
}
impl std::error::Error for AdminError {}
type AdminResult<T> = Result<T, AdminError>;

// ---------- Response ----------
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Success { success: bool, data: serde_json::Value },
    Error { error: String, message: String },
}
impl Response {
    fn success(data: serde_json::Value) -> Self {
        Response::Success { success: true, data }
    }
    fn error(code: &str, msg: &str) -> Self {
        Response::Error {
            error: code.to_string(),
            message: msg.to_string(),
        }
    }
}

// ---------- CSRF ----------
fn verify_csrf() -> AdminResult<()> {
    // In real system, check token. Here assume always valid.
    Ok(())
}

// ---------- Validation ----------
fn validate_email(email: &str) -> AdminResult<()> {
    let re = Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").unwrap();
    if re.is_match(email) {
        Ok(())
    } else {
        Err(AdminError::Validation("invalid_email".to_string()))
    }
}
fn validate_name(name: &str) -> AdminResult<()> {
    if name.len() >= 3 && name.len() <= 50 {
        Ok(())
    } else {
        Err(AdminError::Validation("invalid_name".to_string()))
    }
}
fn validate_tier(tier: &str) -> AdminResult<Tier> {
    match tier {
        "basic" => Ok(Tier::Basic),
        "premium" => Ok(Tier::Premium),
        "enterprise" => Ok(Tier::Enterprise),
        _ => Err(AdminError::Validation("invalid_tier".to_string())),
    }
}
fn validate_role(role: &str) -> AdminResult<Role> {
    match role {
        "owner" => Ok(Role::Owner),
        "admin" => Ok(Role::Admin),
        "user" => Ok(Role::User),
        _ => Err(AdminError::Validation("invalid_role".to_string())),
    }
}

// ---------- Stripe Client ----------
pub trait StripeClient {
    fn update_subscription(&self, stripe_id: &str, price_id: &str) -> AdminResult<()>;
}
pub struct LiveStripeClient;
impl StripeClient for LiveStripeClient {
    fn update_subscription(&self, stripe_id: &str, price_id: &str) -> AdminResult<()> {
        // In real system, call Stripe API. Here just simulate success.
        let _ = (stripe_id, price_id);
        Ok(())
    }
}

// ---------- Admin System ----------
pub struct AdminSystem {
    conn: Connection,
    stripe: Box<dyn StripeClient>,
}
impl AdminSystem {
    pub fn new(conn: Connection, stripe: Box<dyn StripeClient>) -> Self {
        Self { conn, stripe }
    }
    pub fn init_schema(&self) -> AdminResult<()> {
        let sql = r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            tier TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            name TEXT NOT NULL,
            tier TEXT NOT NULL,
            signup_date TEXT NOT NULL,
            invoice_count INTEGER NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deployments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            domain TEXT NOT NULL,
            tier TEXT NOT NULL,
            status TEXT NOT NULL,
            theme TEXT NOT NULL,
            published_at TEXT,
            suspend_reason TEXT,
            FOREIGN KEY(customer_id) REFERENCES customers(id)
        );
        CREATE TABLE IF NOT EXISTS governance_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            actor_id INTEGER NOT NULL,
            target_resource_id INTEGER NOT NULL,
            reason TEXT,
            submitted_at TEXT NOT NULL,
            status TEXT NOT NULL,
            approved_by INTEGER,
            approved_at TEXT,
            rejection_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            actor_id INTEGER NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id INTEGER NOT NULL,
            old_value TEXT,
            new_value TEXT,
            reason TEXT,
            timestamp TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL
        );
        "#;
        self.conn.execute_batch(sql).map_err(|e| AdminError::Internal(e.to_string()))?;
        Ok(())
    }
    // ---------- Gates ----------
    fn require_owner(&self, current: &User) -> AdminResult<()> {
        if current.tier == Tier::Enterprise && current.role() == Role::Owner {
            Ok(())
        } else {
            Err(AdminError::Unauthorized)
        }
    }
    fn require_admin_or_owner(&self, current: &User) -> AdminResult<()> {
        match current.role() {
            Role::Owner | Role::Admin => Ok(()),
            _ => Err(AdminError::Unauthorized),
        }
    }
    // ---------- Audit ----------
    fn audit_log(
        &self,
        action: &str,
        actor_id: i64,
        resource_type: &str,
        resource_id: i64,
        old_value: Option<&str>,
        new_value: Option<&str>,
        reason: Option<&str>,
    ) -> AdminResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn
            .execute(
                "INSERT INTO audit_logs (action, actor_id, resource_type, resource_id, old_value, new_value, reason, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    action,
                    actor_id,
                    resource_type,
                    resource_id,
                    old_value,
                    new_value,
                    reason,
                    now
                ],
            )
            .map_err(|e| AdminError::Internal(e.to_string()))?;
        Ok(())
    }
    // ---------- Helpers ----------
    fn get_user_by_id(&self, id: i64) -> AdminResult<User> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,email,name,tier,status,created_at,updated_at FROM users WHERE id=?1")?;
        let user = stmt.query_row(params![id], |row| {
            Ok(User {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                tier: validate_tier(&row.get::<_, String>(3)?)?,
                status: row.get(4)?,
                created_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map(|dt| dt.with_timezone(&Utc))?,
            })
        })?;
        Ok(user)
    }
    fn get_user_by_email(&self, email: &str) -> AdminResult<Option<User>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,email,name,tier,status,created_at,updated_at FROM users WHERE email=?1")?;
        let mut rows = stmt.query(params![email])?;
        if let Some(row) = rows.next()? {
            let user = User {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                tier: validate_tier(&row.get::<_, String>(3)?)?,
                status: row.get(4)?,
                created_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map(|dt| dt.with_timezone(&Utc))?,
            };
            Ok(Some(user))
        } else {
            Ok(None)
        }
    }
    fn last_active_owner(&self) -> AdminResult<Option<User>> {
        let mut stmt = self.conn.prepare(
            "SELECT id,email,name,tier,status,created_at,updated_at FROM users WHERE tier='enterprise' AND status='active'",
        )?;
        let mut rows = stmt.query(NO_PARAMS)?;
        if let Some(row) = rows.next()? {
            let user = User {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                tier: validate_tier(&row.get::<_, String>(3)?)?,
                status: row.get(4)?,
                created_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(5)?)
                    .map(|dt| dt.with_timezone(&Utc))?,
            };
            Ok(Some(user))
        } else {
            Ok(None)
        }
    }
    // ---------- Endpoints ----------
    // POST /admin/users/action
    pub fn create_user(
        &self,
        current: &User,
        email: &str,
        name: &str,
        tier: &str,
        notify: bool,
    ) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        if let Err(e) = validate_email(email) {
            return Response::error("invalid_email", &e.to_string());
        }
        if let Err(e) = validate_name(name) {
            return Response::error("invalid_name", &e.to_string());
        }
        let tier = match validate_tier(tier) {
            Ok(t) => t,
            Err(e) => return Response::error("invalid_tier", &e.to_string()),
        };
        if let Ok(Some(_)) = self.get_user_by_email(email) {
            return Response::error("email_exists", "Email already exists");
        }
        let now = Utc::now().to_rfc3339();
        let res = self.conn.execute(
            "INSERT INTO users (email,name,tier,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![email, name, tier.as_str(), "active", now, now],
        );
        match res {
            Ok(_) => {
                let user_id = self.conn.last_insert_rowid();
                let _ = self.audit_log(
                    "user_created",
                    current.id,
                    "users",
                    user_id,
                    None,
                    Some(&format!("email:{} tier:{}", email, tier.as_str())),
                    None,
                );
                let data = serde_json::json!({
                    "user_id": user_id,
                    "email": email,
                    "tier": tier.as_str(),
                    "created_at": now
                });
                Response::success(data)
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    pub fn reset_password(&self, current: &User, user_id: i64) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        if user_id == current.id {
            return Response::error("cannot_reset_own_password", "Cannot reset own password");
        }
        let target = match self.get_user_by_id(user_id) {
            Ok(u) => u,
            Err(_) => return Response::error("not_found", "User not found"),
        };
        if let Some(owner) = self.last_active_owner().ok().flatten() {
            if target.id == owner.id {
                return Response::error("cannot_reset_own_password", "Cannot reset last active owner");
            }
        }
        // Generate token (mock)
        let token = format!("reset-token-{}", user_id);
        let _ = self.audit_log(
            "password_reset_initiated",
            current.id,
            "users",
            user_id,
            None,
            Some(&token),
            None,
        );
        Response::success(serde_json::json!({"status":"reset_email_sent"}))
    }
    pub fn change_role(&self, current: &User, user_id: i64, new_tier: &str) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        if user_id == current.id {
            return Response::error("cannot_change_own_role", "Cannot change own role");
        }
        let target = match self.get_user_by_id(user_id) {
            Ok(u) => u,
            Err(_) => return Response::error("not_found", "User not found"),
        };
        let new_tier = match validate_tier(new_tier) {
            Ok(t) => t,
            Err(e) => return Response::error("invalid_tier", &e.to_string()),
        };
        if let Some(owner) = self.last_active_owner().ok().flatten() {
            if target.id == owner.id && new_tier != Tier::Enterprise {
                return Response::error("cannot_demote_last_owner", "Cannot demote last active owner");
            }
        }
        let res = self.conn.execute(
            "UPDATE users SET tier=?1, updated_at=?2 WHERE id=?3",
            params![new_tier.as_str(), Utc::now().to_rfc3339(), user_id],
        );
        match res {
            Ok(_) => {
                let _ = self.audit_log(
                    "role_changed",
                    current.id,
                    "users",
                    user_id,
                    Some(&target.tier.as_str()),
                    Some(&new_tier.as_str()),
                    None,
                );
                Response::success(serde_json::json!({
                    "user_id": user_id,
                    "old_tier": target.tier.as_str(),
                    "new_tier": new_tier.as_str()
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    pub fn suspend_user(&self, current: &User, user_id: i64, reason: &str) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        if user_id == current.id {
            return Response::error("cannot_suspend_yourself", "Cannot suspend yourself");
        }
        let target = match self.get_user_by_id(user_id) {
            Ok(u) => u,
            Err(_) => return Response::error("not_found", "User not found"),
        };
        if let Some(owner) = self.last_active_owner().ok().flatten() {
            if target.id == owner.id {
                return Response::error("cannot_suspend_last_owner", "Cannot suspend last active owner");
            }
        }
        let res = self.conn.execute(
            "UPDATE users SET status='suspended', updated_at=?1 WHERE id=?2",
            params![Utc::now().to_rfc3339(), user_id],
        );
        match res {
            Ok(_) => {
                let _ = self.audit_log(
                    "user_suspended",
                    current.id,
                    "users",
                    user_id,
                    None,
                    Some("suspended"),
                    Some(reason),
                );
                Response::success(serde_json::json!({
                    "user_id": user_id,
                    "suspended": true
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    // GET /admin/customers
    pub fn list_customers(&self, current: &User, page: i64, per_page: i64) -> Response {
        if let Err(e) = self.require_admin_or_owner(current) {
            return Response::error("unauthorized", &e.to_string());
        }
        let offset = (page - 1) * per_page;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,email,name,tier,signup_date,invoice_count,status FROM customers LIMIT ?1 OFFSET ?2",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![per_page, offset], |row| {
                Ok(serde_json::json!({
                    "customer_id": row.get::<_, i64>(0)?,
                    "email": row.get::<_, String>(1)?,
                    "name": row.get::<_, String>(2)?,
                    "tier": row.get::<_, String>(3)?,
                    "signup_date": row.get::<_, String>(4)?,
                    "invoice_count": row.get::<_, i64>(5)?,
                    "status": row.get::<_, String>(6)?
                }))
            })
            .unwrap();
        let mut list = Vec::new();
        for r in rows {
            list.push(r.unwrap());
        }
        Response::success(serde_json::json!(list))
    }
    // GET /admin/customers/{id}
    pub fn get_customer(&self, current: &User, customer_id: i64) -> Response {
        if let Err(e) = self.require_admin_or_owner(current) {
            return Response::error("unauthorized", &e.to_string());
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,email,name,tier,signup_date,invoice_count,status FROM customers WHERE id=?1",
            )
            .unwrap();
        let customer = stmt
            .query_row(params![customer_id], |row| {
                Ok(serde_json::json!({
                    "customer_id": row.get::<_, i64>(0)?,
                    "email": row.get::<_, String>(1)?,
                    "name": row.get::<_, String>(2)?,
                    "tier": row.get::<_, String>(3)?,
                    "subscription_status": row.get::<_, String>(4)?,
                    "payment_method": "mock",
                    "address": "mock",
                    "notes": "mock"
                }))
            })
            .map_err(|_| AdminError::NotFound("customer".to_string()))?;
        Response::success(customer)
    }
    // POST /admin/customers/{id}/action
    pub fn change_plan(
        &self,
        current: &User,
        customer_id: i64,
        new_tier: &str,
    ) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        let new_tier = match validate_tier(new_tier) {
            Ok(t) => t,
            Err(e) => return Response::error("invalid_tier", &e.to_string()),
        };
        // Mock stripe subscription id
        let stripe_id = format!("sub-{}", customer_id);
        let price_id = format!("price-{}", new_tier.as_str());
        if let Err(e) = self.stripe.update_subscription(&stripe_id, &price_id) {
            return Response::error("stripe_error", &e.to_string());
        }
        let old_tier = "basic"; // placeholder
        let res = self.conn.execute(
            "UPDATE customers SET tier=?1 WHERE id=?2",
            params![new_tier.as_str(), customer_id],
        );
        match res {
            Ok(_) => {
                let _ = self.audit_log(
                    "plan_changed",
                    current.id,
                    "customers",
                    customer_id,
                    Some(old_tier),
                    Some(new_tier.as_str()),
                    None,
                );
                Response::success(serde_json::json!({
                    "customer_id": customer_id,
                    "old_tier": old_tier,
                    "new_tier": new_tier.as_str(),
                    "effective_date": Utc::now().to_rfc3339()
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    pub fn queue_refund(
        &self,
        current: &User,
        invoice_id: i64,
        amount: i64,
        reason: &str,
    ) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        // Assume invoice exists and succeeded
        let now = Utc::now().to_rfc3339();
        let res = self.conn.execute(
            "INSERT INTO refunds (invoice_id, amount, reason, created_by, created_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![invoice_id, amount, reason, current.id, now, "queued"],
        );
        match res {
            Ok(_) => {
                let refund_id = self.conn.last_insert_rowid();
                let _ = self.audit_log(
                    "refund_queued",
                    current.id,
                    "refunds",
                    refund_id,
                    None,
                    Some("queued"),
                    Some(reason),
                );
                Response::success(serde_json::json!({
                    "refund_id": refund_id,
                    "status": "queued",
                    "amount": amount
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    // POST /admin/deployments/action
    pub fn create_deployment(
        &self,
        current: &User,
        customer_id: i64,
        domain: &str,
        tier: &str,
        theme_id: &str,
    ) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        // Check domain not registered
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM deployments WHERE domain=?1")
            .unwrap();
        if let Ok(Some(_)) = stmt.query_row(params![domain], |_| Ok(())) {
            return Response::error("conflict", "Domain already registered");
        }
        // Check theme exists (mock)
        let theme = theme_id.to_string();
        let tier = match validate_tier(tier) {
            Ok(t) => t,
            Err(e) => return Response::error("invalid_tier", &e.to_string()),
        };
        let now = Utc::now().to_rfc3339();
        let res = self.conn.execute(
            "INSERT INTO deployments (customer_id, domain, tier, status, theme, published_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![customer_id, domain, tier.as_str(), "draft", theme, None::<String>],
        );
        match res {
            Ok(_) => {
                let deployment_id = self.conn.last_insert_rowid();
                let _ = self.audit_log(
                    "deployment_created",
                    current.id,
                    "deployments",
                    deployment_id,
                    None,
                    Some(&format!("domain:{} tier:{}", domain, tier.as_str())),
                    None,
                );
                Response::success(serde_json::json!({
                    "deployment_id": deployment_id,
                    "domain": domain,
                    "tier": tier.as_str()
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    pub fn publish_deployment(&self, current: &User, deployment_id: i64) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        // Double gate: SafetyFlags.can_publish (mock true)
        let can_publish = true;
        if !can_publish {
            return Response::error("forbidden", "Publish not allowed");
        }
        let mut stmt = self
            .conn
            .prepare("SELECT status, domain_verified, theme_set FROM deployments WHERE id=?1")
            .unwrap();
        let row = stmt
            .query_row(params![deployment_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })
            .map_err(|_| AdminError::NotFound("deployment".to_string()))?;
        if row.0 != "draft" {
            return Response::error("invalid_state", "Deployment not in draft");
        }
        // Assume domain_verified and theme_set true
        let now = Utc::now().to_rfc3339();
        let res = self.conn.execute(
            "UPDATE deployments SET status='live', published_at=?1 WHERE id=?2",
            params![now, deployment_id],
        );
        match res {
            Ok(_) => {
                let _ = self.audit_log(
                    "deployment_published",
                    current.id,
                    "deployments",
                    deployment_id,
                    None,
                    Some("live"),
                    None,
                );
                Response::success(serde_json::json!({
                    "deployment_id": deployment_id,
                    "status": "live",
                    "public_url": format!("https://{}.example.com", deployment_id)
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    pub fn suspend_deployment(&self, current: &User, deployment_id: i64, reason: &str) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        let res = self.conn.execute(
            "UPDATE deployments SET status='suspended', suspend_reason=?1 WHERE id=?2",
            params![reason, deployment_id],
        );
        match res {
            Ok(_) => {
                let _ = self.audit_log(
                    "deployment_suspended",
                    current.id,
                    "deployments",
                    deployment_id,
                    None,
                    Some("suspended"),
                    Some(reason),
                );
                Response::success(serde_json::json!({
                    "deployment_id": deployment_id,
                    "status": "suspended"
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    pub fn retire_deployment(&self, current: &User, deployment_id: i64) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        let now = Utc::now().to_rfc3339();
        let res = self.conn.execute(
            "UPDATE deployments SET status='archived', published_at=?1 WHERE id=?2",
            params![now, deployment_id],
        );
        match res {
            Ok(_) => {
                let _ = self.audit_log(
                    "deployment_archived",
                    current.id,
                    "deployments",
                    deployment_id,
                    None,
                    Some("archived"),
                    None,
                );
                Response::success(serde_json::json!({
                    "deployment_id": deployment_id,
                    "status": "archived"
                }))
            }
            Err(e) => Response::error("internal", &e.to_string()),
        }
    }
    // Governance
    pub fn list_governance_actions(&self, current: &User, page: i64, per_page: i64) -> Response {
        if let Err(e) = self.require_admin_or_owner(current) {
            return Response::error("unauthorized", &e.to_string());
        }
        let offset = (page - 1) * per_page;
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id,action_type,actor_id,target_resource_id,reason,submitted_at,status FROM governance_actions WHERE status='pending' LIMIT ?1 OFFSET ?2",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![per_page, offset], |row| {
                Ok(serde_json::json!({
                    "action_id": row.get::<_, i64>(0)?,
                    "action_type": row.get::<_, String>(1)?,
                    "actor": row.get::<_, i64>(2)?,
                    "target_resource_id": row.get::<_, i64>(3)?,
                    "reason": row.get::<_, String>(4)?,
                    "submitted_at": row.get::<_, String>(5)?,
                    "status": row.get::<_, String>(6)?
                }))
            })
            .unwrap();
        let mut list = Vec::new();
        for r in rows {
            list.push(r.unwrap());
        }
        Response::success(serde_json::json!(list))
    }
    pub fn decide_governance_action(
        &self,
        current: &User,
        action_id: i64,
        decide: &str,
        reason: Option<&str>,
    ) -> Response {
        if let Err(e) = verify_csrf() {
            return Response::error("csrf_error", &e.to_string());
        }
        if let Err(e) = self.require_owner(current) {
            return Response::error("owner_only", &e.to_string());
        }
        let mut stmt = self
            .conn
            .prepare("SELECT action_type,actor_id,target_resource_id,reason,submitted_at,status FROM governance_actions WHERE id=?1")
            .unwrap();
        let action = stmt
            .query_row(params![action_id], |row| {
                Ok(GovernanceAction {
                    id: action_id,
                    action_type: row.get(0)?,
                    actor_id: row.get(1)?,
                    target_resource_id: row.get(2)?,
                    reason: row.get(3)?,
                    submitted_at: DateTime::parse_from_rfc3339(&row.get::<_, String>(4)?)
                        .map(|dt| dt.with_timezone(&Utc))
                        .unwrap(),
                    status: row.get(5)?,
                    approved_by: None,
                    approved_at: None,
                    rejection_reason: None,
                })
            })
            .map_err(|_| AdminError::NotFound("action".to_string()))?;
        if action.status != "pending" {
            return Response::error("invalid_state", "Action not pending");
        }
        match decide {
            "approve" => {
                // Execute original action (mock)
                let _ = self.audit_log(
                    "action_approved",
                    current.id,
                    "governance_actions",
                    action_id,
                    None,
                    Some("approved"),
                    None,
                );
                let now = Utc::now().to_rfc3339();
                let res = self.conn.execute(
                    "UPDATE governance_actions SET status='approved', approved_by=?1, approved_at=?2 WHERE id=?3",
                    params![current.id, now, action_id],
                );
                match res {
                    Ok(_) => Response::success(serde_json::json!({
                        "action_id": action_id,
                        "status": "approved"
                    })),
                    Err(e) => Response::error("internal", &e.to_string()),
                }
            }
            "reject" => {
                let reason = reason.ok_or_else(|| AdminError::Validation("reason_required".to_string()))?;
                let _ = self.audit_log(
                    "action_rejected",
                    current.id,
                    "governance_actions",
                    action_id,
                    None,
                    Some("rejected"),
                    Some(reason),
                );
                let now = Utc::now().to_rfc3339();
                let res = self.conn.execute(
                    "UPDATE governance_actions SET status='rejected', rejection_reason=?1, approved_at=?2 WHERE id=?3",
                    params![reason, now, action_id],
                );
                match res {
                    Ok(_) => Response::success(serde_json::json!({
                        "action_id": action_id,
                        "status": "rejected"
                    })),
                    Err(e) => Response::error("internal", &e.to_string()),
                }
            }
            _ => Response::error("invalid_decide", "Unknown decide action"),
        }
    }
    // Audit log search
    pub fn search_audit_log(
        &self,
        current: &User,
        action_type: Option<&str>,
        resource_id: Option<i64>,
        date_range: Option<(DateTime<Utc>, DateTime<Utc>)>,
        limit: i64,
        offset: i64,
    ) -> Response {
        if let Err(e) = self.require_admin_or_owner(current) {
            return Response::error("unauthorized", &e.to_string());
        }
        let mut query = "SELECT timestamp,actor_id,action,resource_type,resource_id,old_value,new_value,reason FROM audit_logs".to_string();
        let mut conditions = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(at) = action_type {
            conditions.push("action=?".to_string());
            params_vec.push(Box::new(at));
        }
        if let Some(rid) = resource_id {
            conditions.push("resource_id=?".to_string());
            params_vec.push(Box::new(rid));
        }
        if let Some((start, end)) = date_range {
            conditions.push("timestamp BETWEEN ? AND ?".to_string());
            params_vec.push(Box::new(start.to_rfc3339()));
            params_vec.push(Box::new(end.to_rfc3339()));
        }
        if !conditions.is_empty() {
            query.push_str(" WHERE ");
            query.push_str(&conditions.join(" AND "));
        }
        query.push_str(" ORDER BY timestamp DESC LIMIT ? OFFSET ?");
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));
        let mut stmt = self.conn.prepare(&query).unwrap();
        let rows = stmt
            .query_map(params_vec.as_slice(), |row| {
                Ok(serde_json::json!({
                    "timestamp": row.get::<_, String>(0)?,
                    "actor_id": row.get::<_, i64>(1)?,
                    "action": row.get::<_, String>(2)?,
                    "resource_type": row.get::<_, String>(3)?,
                    "resource_id": row.get::<_, i64>(4)?,
                    "old_value": row.get::<_, Option<String>>(5)?,
                    "new_value": row.get::<_, Option<String>>(6)?,
                    "reason": row.get::<_, Option<String>>(7)?
                }))
            })
            .unwrap();
        let mut list = Vec::new();
        for r in rows {
            list.push(r.unwrap());
        }
        Response::success(serde_json::json!(list))
    }
}

// ---------- User role helper ----------
impl User {
    fn role(&self) -> Role {
        // Simplified: tier enterprise => owner, admin => admin, else user
        match self.tier {
            Tier::Enterprise => Role::Owner,
            Tier::Premium => Role::Admin,
            Tier::Basic => Role::User,
        }
    }
}