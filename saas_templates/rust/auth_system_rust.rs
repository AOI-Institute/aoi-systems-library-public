use bcrypt::{hash, verify, DEFAULT_COST};
use chrono::{DateTime, Duration, Utc};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Validation};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use totp_rs::{Algorithm, TOTP};

type DbPool = Pool<ConnectionManager<MysqlConnection>>;

#[derive(Debug, Serialize, Deserialize, Queryable, Insertable)]
#[diesel(table_name = users)]
struct User {
    id: i64,
    email: String,
    password_hash: String,
    tier: String,
    status: String,
    email_verified_at: Option<DateTime<Utc>>,
    mfa_secret: Option<String>,
    mfa_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Queryable, Insertable)]
#[diesel(table_name = sessions)]
struct Session {
    id: i64,
    user_id: i64,
    refresh_token: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    ip: String,
    device_id: String,
}

#[derive(Debug, Serialize, Deserialize, Queryable, Insertable)]
#[diesel(table_name = audit_log)]
struct AuditLog {
    timestamp: DateTime<Utc>,
    actor_id: Option<i64>,
    action: String,
    resource_type: String,
    resource_id: Option<i64>,
    old_value: Option<String>,
    new_value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Queryable, Insertable)]
#[diesel(table_name = verification_codes)]
struct VerificationCode {
    id: i64,
    user_id: i64,
    code: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    code_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AuthResponse {
    success: bool,
    #[serde(flatten)]
    data: AuthResponseData,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum AuthResponseData {
    Success {
        status: String,
        email: Option<String>,
        message: Option<String>,
        user_id: Option<i64>,
        session_id: Option<i64>,
        token: Option<String>,
        expires_in: Option<i64>,
        user: Option<UserData>,
        challenge_id: Option<String>,
    },
    Error {
        error: String,
        message: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct UserData {
    id: i64,
    email: String,
    tier: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
    device_id: String,
    ip: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SignupRequest {
    email: String,
    password: String,
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct VerifyEmailRequest {
    email: String,
    code_or_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OAuthCallbackRequest {
    provider: String,
    code: String,
    state: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MFAChallengeRequest {
    challenge_id: String,
    code: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenRefreshRequest {
    refresh_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct VerifyAccessTokenRequest {
    token: String,
}

#[derive(Debug)]
struct AuthSystem {
    db_pool: DbPool,
    jwt_secret: String,
    common_passwords: Vec<String>,
}

impl AuthSystem {
    fn new(db_pool: DbPool, jwt_secret: String) -> Self {
        let common_passwords = vec![
            "password".to_string(),
            "123456".to_string(),
            "12345678".to_string(),
            "qwerty".to_string(),
            "abc123".to_string(),
            "password123".to_string(),
            "admin".to_string(),
            "letmein".to_string(),
            "welcome".to_string(),
            "monkey".to_string(),
        ];
        
        AuthSystem {
            db_pool,
            jwt_secret,
            common_passwords,
        }
    }

    fn hash_password(&self, password: &str) -> Result<String, AuthError> {
        hash(password, DEFAULT_COST).map_err(AuthError::from)
    }

    fn verify_password(&self, password: &str, hash: &str) -> Result<bool, AuthError> {
        verify(password, hash).map_err(AuthError::from)
    }

    fn is_password_strong(&self, password: &str) -> Result<(), AuthError> {
        if password.len() < 15 {
            return Err(AuthError::PasswordTooShort);
        }
        
        if password.len() > 64 {
            return Err(AuthError::PasswordTooLong);
        }
        
        if self.common_passwords.contains(&password.to_lowercase()) {
            return Err(AuthError::PasswordBlocklisted);
        }
        
        let email = ""; // Would need to be passed in
        if password.to_lowercase() == email.to_lowercase() {
            return Err(AuthError::PasswordBlocklisted);
        }
        
        let name = ""; // Would need to be passed in
        if password.to_lowercase() == name.to_lowercase() {
            return Err(AuthError::PasswordBlocklisted);
        }
        
        Ok(())
    }

    fn generate_verification_code(&self) -> String {
        let mut rng = rand::thread_rng();
        (0..6).map(|_| rng.gen_range(0..10)).collect()
    }

    fn generate_refresh_token(&self) -> String {
        let mut rng = rand::thread_rng();
        (0..32).map(|_| {
            let idx = rng.gen_range(0..62);
            let c = if idx < 10 {
                (b'0' + idx as u8) as char
            } else if idx < 36 {
                (b'a' + idx as u8 - 10) as char
            } else {
                (b'A' + idx as u8 - 36) as char
            };
            c
        }).collect()
    }

    fn generate_jwt(&self, user: &User) -> Result<String, AuthError> {
        let expiration = Utc::now() + Duration::hours(1);
        let claims = Claims {
            sub: user.id.to_string(),
            email: user.email.clone(),
            tier: user.tier.clone(),
            exp: expiration.timestamp() as usize,
            iat: Utc::now().timestamp() as usize,
        };
        
        encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(self.jwt_secret.as_ref()),
        ).map_err(AuthError::from)
    }

    fn verify_jwt(&self, token: &str) -> Result<Claims, AuthError> {
        let token_data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(self.jwt_secret.as_ref()),
            &Validation::new(jsonwebtoken::Algorithm::HS256),
        ).map_err(AuthError::from)?;
        
        Ok(token_data.claims)
    }

    fn create_totp_secret(&self) -> String {
        let mut rng = rand::thread_rng();
        (0..32).map(|_| {
            let idx = rng.gen_range(0..62);
            let c = if idx < 10 {
                (b'0' + idx as u8) as char
            } else if idx < 36 {
                (b'a' + idx as u8 - 10) as char
            } else {
                (b'A' + idx as u8 - 36) as char
            };
            c
        }).collect()
    }

    fn generate_totp(&self, secret: &str) -> Result<TOTP, AuthError> {
        TOTP::new(
            Algorithm::SHA1,
            6,
            1,
            30000,
            secret.to_string(),
        ).map_err(AuthError::from)
    }

    fn verify_totp(&self, totp: &TOTP, code: &str) -> Result<bool, AuthError> {
        totp.check_current(code).map_err(AuthError::from)
    }

    fn log_why_chain(&self, flow: &str, decision_points: Vec<&str>) {
        // Implementation would log to audit_log table
    }

    fn log_audit(&self, action: &str, actor_id: Option<i64>, resource_type: &str, resource_id: Option<i64>, old_value: Option<String>, new_value: Option<String>) {
        // Implementation would log to audit_log table
    }

    fn signup(&self, req: SignupRequest) -> Result<AuthResponse, AuthError> {
        let mut conn = self.db_pool.get()?;
        
        self.log_why_chain("signup", vec!["email_unique", "password_strength", "rate_limit_ip_24h"]);
        
        let email_exists = users::table.filter(users::email.eq(&req.email)).first::<User>(&mut conn).optional()?;
        if email_exists.is_some() {
            return Err(AuthError::EmailAlreadyExists);
        }
        
        self.is_password_strong(&req.password)?;
        let password_hash = self.hash_password(&req.password)?;
        
        let user = User {
            id: 0,
            email: req.email.clone(),
            password_hash,
            tier: "free".to_string(),
            status: "unverified".to_string(),
            email_verified_at: None,
            mfa_secret: None,
            mfa_enabled: false,
        };
        
        let user_id = diesel::insert_into(users::table)
            .values(&user)
            .returning(users::id)
            .get_result::<i64>(&mut conn)?;
        
        let verification_code = self.generate_verification_code();
        let expires_at = Utc::now() + Duration::hours(24);
        
        diesel::insert_into(verification_codes::table)
            .values(VerificationCode {
                id: 0,
                user_id,
                code: verification_code.clone(),
                created_at: Utc::now(),
                expires_at,
                code_type: "email".to_string(),
            })
            .execute(&mut conn)?;
        
        self.log_audit("user_created", Some(user_id), "user", Some(user_id), None, None);
        
        // Send verification email (implementation would send email)
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "pending_verification".to_string(),
                email: Some(req.email),
                message: Some("check email".to_string()),
                user_id: Some(user_id),
                session_id: None,
                token: None,
                expires_in: None,
                user: None,
                challenge_id: None,
            },
        })
    }

    fn verify_email(&self, req: VerifyEmailRequest) -> Result<AuthResponse, AuthError> {
        let mut conn = self.db_pool.get()?;
        
        self.log_why_chain("verify_email", vec!["code_valid", "user_unverified"]);
        
        let verification_code = verification_codes::table
            .filter(verification_codes::code.eq(&req.code_or_token))
            .filter(verification_codes::code_type.eq("email"))
            .first::<VerificationCode>(&mut conn)?;
        
        if verification_code.expires_at < Utc::now() {
            return Err(AuthError::CodeExpired);
        }
        
        let user_id = verification_code.user_id;
        let user = users::table.find(user_id).first::<User>(&mut conn)?;
        
        if user.email_verified_at.is_some() {
            return Err(AuthError::EmailAlreadyVerified);
        }
        
        diesel::update(users::table.find(user_id))
            .set(users::email_verified_at.eq(Utc::now()))
            .execute(&mut conn)?;
        
        diesel::delete(verification_codes::table.find(verification_code.id))
            .execute(&mut conn)?;
        
        self.log_audit("email_verified", Some(user_id), "user", Some(user_id), None, None);
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "verified".to_string(),
                user_id: Some(user_id),
                message: Some("ready to login".to_string()),
                email: None,
                session_id: None,
                token: None,
                expires_in: None,
                user: None,
                challenge_id: None,
            },
        })
    }

    fn login(&self, req: LoginRequest) -> Result<AuthResponse, AuthError> {
        let mut conn = self.db_pool.get()?;
        
        self.log_why_chain("login", vec!["user_exists", "password_correct", "mfa_gate", "rate_limit"]);
        
        let user = users::table
            .filter(users::email.eq(&req.email))
            .first::<User>(&mut conn)?;
        
        if user.status != "verified" {
            return Err(AuthError::InvalidCredentials);
        }
        
        if !self.verify_password(&req.password, &user.password_hash)? {
            return Err(AuthError::InvalidCredentials);
        }
        
        if user.mfa_enabled {
            let challenge_id = self.generate_refresh_token();
            let expires_at = Utc::now() + Duration::minutes(5);
            
            diesel::insert_into(verification_codes::table)
                .values(VerificationCode {
                    id: 0,
                    user_id: user.id,
                    code: challenge_id.clone(),
                    created_at: Utc::now(),
                    expires_at,
                    code_type: "mfa".to_string(),
                })
                .execute(&mut conn)?;
            
            return Ok(AuthResponse {
                success: true,
                data: AuthResponseData::Success {
                    status: "mfa_required".to_string(),
                    challenge_id: Some(challenge_id),
                    email: None,
                    message: None,
                    user_id: None,
                    session_id: None,
                    token: None,
                    expires_in: None,
                    user: None,
                },
            });
        }
        
        let session_id = self.create_session(&mut conn, user.id, &req.ip, &req.device_id)?;
        let token = self.generate_jwt(&user)?;
        let expires_in = 3600; // 1 hour
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "authenticated".to_string(),
                session_id: Some(session_id),
                token: Some(token),
                expires_in: Some(expires_in),
                user: Some(UserData {
                    id: user.id,
                    email: user.email,
                    tier: user.tier,
                }),
                email: None,
                message: None,
                challenge_id: None,
            },
        })
    }

    fn create_session(&self, conn: &mut MysqlConnection, user_id: i64, ip: &str, device_id: &str) -> Result<i64, AuthError> {
        let refresh_token = self.generate_refresh_token();
        let created_at = Utc::now();
        let expires_at = created_at + Duration::days(30);
        
        let session = Session {
            id: 0,
            user_id,
            refresh_token,
            created_at,
            expires_at,
            ip: ip.to_string(),
            device_id: device_id.to_string(),
        };
        
        let session_id = diesel::insert_into(sessions::table)
            .values(&session)
            .returning(sessions::id)
            .get_result::<i64>(conn)?;
        
        Ok(session_id)
    }

    fn oauth_callback(&self, req: OAuthCallbackRequest) -> Result<AuthResponse, AuthError> {
        let mut conn = self.db_pool.get()?;
        
        self.log_why_chain("oauth_callback", vec!["state_valid", "email_verified"]);
        
        let provider_email = ""; // Would need to get from OAuth provider
        
        let user = users::table
            .filter(users::email.eq(provider_email))
            .first::<User>(&mut conn)
            .optional()?;
        
        let user_id = if let Some(user) = user {
            user.id
        } else {
            let new_user = User {
                id: 0,
                email: provider_email.to_string(),
                password_hash: "".to_string(), // OAuth users don't need password
                tier: "free".to_string(),
                status: "verified".to_string(),
                email_verified_at: Some(Utc::now()),
                mfa_secret: None,
                mfa_enabled: false,
            };
            
            let user_id = diesel::insert_into(users::table)
                .values(&new_user)
                .returning(users::id)
                .get_result::<i64>(&mut conn)?;
            
            user_id
        };
        
        let session_id = self.create_session(&mut conn, user_id, "", "")?;
        
        self.log_audit("oauth_login", Some(user_id), "user", Some(user_id), None, None);
        
        let user = users::table.find(user_id).first::<User>(&mut conn)?;
        let token = self.generate_jwt(&user)?;
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "authenticated".to_string(),
                session_id: Some(session_id),
                token: Some(token),
                expires_in: Some(3600),
                user: Some(UserData {
                    id: user.id,
                    email: user.email,
                    tier: user.tier,
                }),
                email: None,
                message: None,
                challenge_id: None,
            },
        })
    }

    fn mfa_challenge(&self, req: MFAChallengeRequest) -> Result<AuthResponse, AuthError> {
        let mut conn = self.db_pool.get()?;
        
        self.log_why_chain("mfa_challenge", vec!["challenge_valid", "code_correct"]);
        
        let verification_code = verification_codes::table
            .filter(verification_codes::code.eq(&req.challenge_id))
            .filter(verification_codes::code_type.eq("mfa"))
            .first::<VerificationCode>(&mut conn)?;
        
        if verification_code.expires_at < Utc::now() {
            return Err(AuthError::CodeExpired);
        }
        
        let user = users::table.find(verification_code.user_id).first::<User>(&mut conn)?;
        
        let totp = self.generate_totp(&user.mfa_secret.unwrap())?;
        if !self.verify_totp(&totp, &req.code)? {
            return Err(AuthError::InvalidCode);
        }
        
        diesel::delete(verification_codes::table.find(verification_code.id))
            .execute(&mut conn)?;
        
        let session_id = self.create_session(&mut conn, user.id, "", "")?;
        let token = self.generate_jwt(&user)?;
        
        self.log_audit("mfa_verified", Some(user.id), "user", Some(user.id), None, None);
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "authenticated".to_string(),
                session_id: Some(session_id),
                token: Some(token),
                expires_in: Some(3600),
                user: Some(UserData {
                    id: user.id,
                    email: user.email,
                    tier: user.tier,
                }),
                email: None,
                message: None,
                challenge_id: None,
            },
        })
    }

    fn token_refresh(&self, req: TokenRefreshRequest) -> Result<AuthResponse, AuthError> {
        let mut conn = self.db_pool.get()?;
        
        self.log_why_chain("token_refresh", vec!["token_valid", "user_active"]);
        
        let session = sessions::table
            .filter(sessions::refresh_token.eq(&req.refresh_token))
            .first::<Session>(&mut conn)?;
        
        if session.expires_at < Utc::now() {
            return Err(AuthError::InvalidToken);
        }
        
        let user = users::table.find(session.user_id).first::<User>(&mut conn)?;
        
        if user.status == "suspended" || user.status == "banned" {
            return Err(AuthError::UserBanned);
        }
        
        let new_session_id = self.create_session(&mut conn, user.id, &session.ip, &session.device_id)?;
        
        diesel::delete(sessions::table.find(session.id))
            .execute(&mut conn)?;
        
        let token = self.generate_jwt(&user)?;
        
        self.log_audit("token_refreshed", Some(user.id), "user", Some(user.id), None, None);
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "ok".to_string(),
                token: Some(token),
                expires_in: Some(3600),
                session_id: Some(new_session_id),
                email: None,
                message: None,
                user: None,
                challenge_id: None,
            },
        })
    }

    fn verify_access_token(&self, req: VerifyAccessTokenRequest) -> Result<AuthResponse, AuthError> {
        let claims = self.verify_jwt(&req.token)?;
        
        let mut conn = self.db_pool.get()?;
        let user = users::table.find(claims.sub.parse::<i64>()?).first::<User>(&mut conn)?;
        
        if user.status == "suspended" || user.status == "banned" {
            return Err(AuthError::UserBanned);
        }
        
        self.log_why_chain("verify_access_token", vec!["signature_valid", "not_expired", "user_active"]);
        
        Ok(AuthResponse {
            success: true,
            data: AuthResponseData::Success {
                status: "ok".to_string(),
                user: Some(UserData {
                    id: user.id,
                    email: user.email,
                    tier: user.tier,
                }),
                token: None,
                expires_in: None,
                session_id: None,
                email: None,
                message: None,
                challenge_id: None,
            },
        })
    }
}

#[derive(Debug)]
enum AuthError {
    PasswordTooShort,
    PasswordTooLong,
    PasswordBlocklisted,
    EmailAlreadyExists,
    CodeExpired,
    EmailAlreadyVerified,
    InvalidCredentials,
    InvalidCode,
    InvalidToken,
    UserBanned,
    BcryptError(bcrypt::BcryptError),
    JwtError(jsonwebtoken::errors::Error),
    TOTPError(totp_rs::TOTPError),
}

impl From<bcrypt::BcryptError> for AuthError {
    fn from(e: bcrypt::BcryptError) -> Self {
        AuthError::BcryptError(e)
    }
}

impl From<jsonwebtoken::errors::Error> for AuthError {
    fn from(e: jsonwebtoken::errors::Error) -> Self {
        AuthError::JwtError(e)
    }
}

impl From<totp_rs::TOTPError> for AuthError {
    fn from(e: totp_rs::TOTPError) -> Self {
        AuthError::TOTPError(e)
    }
}

#[macro_use]
extern crate diesel;
extern crate bcrypt;
extern crate jsonwebtoken;
extern crate totp_rs;
extern crate rand;

table! {
    users {
        id -> BigInt,
        email -> Text,
        password_hash -> Text,
        tier -> Text,
        status -> Text,
        email_verified_at -> Nullable<Timestamp>,
        mfa_secret -> Nullable<Text>,
        mfa_enabled -> Bool,
    }
}

table! {
    sessions {
        id -> BigInt,
        user_id -> BigInt,
        refresh_token -> Text,
        created_at -> Timestamp,
        expires_at -> Timestamp,
        ip -> Text,
        device_id -> Text,
    }
}

table! {
    audit_log {
        timestamp -> Timestamp,
        actor_id -> Nullable<BigInt>,
        action -> Text,
        resource_type -> Text,
        resource_id -> Nullable<BigInt>,
        old_value -> Nullable<Text>,
        new_value -> Nullable<Text>,
    }
}

table! {
    verification_codes {
        id -> BigInt,
        user_id -> BigInt,
        code -> Text,
        created_at -> Timestamp,
        expires_at -> Timestamp,
        code_type -> Text,
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    email: String,
    tier: String,
    exp: usize,
    iat: usize,
}

fn main() {
    // Example usage
    let database_url = "mysql://user:password@localhost/dbname";
    let manager = ConnectionManager::<MysqlConnection>::new(database_url);
    let pool = Pool::new(manager).expect("Failed to create pool");
    
    let auth_system = AuthSystem::new(pool, "secret".to_string());
    
    let signup_req = SignupRequest {
        email: "test@example.com".to_string(),
        password: "password123456".to_string(),
        name: "Test User".to_string(),
    };
    
    match auth_system.signup(signup_req) {
        Ok(response) => println!("Signup successful: {:?}", response),
        Err(e) => println!("Signup failed: {:?}", e),
    }
}