use super::*;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use mockall::predicate::*;
use mockall::*;

#[cfg(test)]
mod tests {
    use super::*;
    
    struct MockDbPool;
    
    impl MockDbPool {
        fn new() -> Self {
            MockDbPool
        }
    }
    
    #[test]
    fn test_signup_happy_path() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let signup_req = SignupRequest {
            email: "test@example.com".to_string(),
            password: "password123456".to_string(),
            name: "Test User".to_string(),
        };
        
        let result = auth_system.signup(signup_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "pending_verification");
    }
    
    #[test]
    fn test_signup_duplicate_email() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let signup_req = SignupRequest {
            email: "existing@example.com".to_string(),
            password: "password123456".to_string(),
            name: "Test User".to_string(),
        };
        
        let result = auth_system.signup(signup_req);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), AuthError::EmailAlreadyExists);
    }
    
    #[test]
    fn test_signup_weak_password() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let signup_req = SignupRequest {
            email: "test@example.com".to_string(),
            password: "short".to_string(),
            name: "Test User".to_string(),
        };
        
        let result = auth_system.signup(signup_req);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), AuthError::PasswordTooShort);
    }
    
    #[test]
    fn test_verify_email_happy_path() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let verify_req = VerifyEmailRequest {
            email: "test@example.com".to_string(),
            code_or_token: "123456".to_string(),
        };
        
        let result = auth_system.verify_email(verify_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "verified");
    }
    
    #[test]
    fn test_login_happy_path() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let login_req = LoginRequest {
            email: "test@example.com".to_string(),
            password: "password123456".to_string(),
            device_id: "device123".to_string(),
            ip: "127.0.0.1".to_string(),
        };
        
        let result = auth_system.login(login_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "authenticated");
    }
    
    #[test]
    fn test_login_with_mfa() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let login_req = LoginRequest {
            email: "test@example.com".to_string(),
            password: "password123456".to_string(),
            device_id: "device123".to_string(),
            ip: "127.0.0.1".to_string(),
        };
        
        let result = auth_system.login(login_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "mfa_required");
    }
    
    #[test]
    fn test_login_invalid_password() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let login_req = LoginRequest {
            email: "test@example.com".to_string(),
            password: "wrongpassword".to_string(),
            device_id: "device123".to_string(),
            ip: "127.0.0.1".to_string(),
        };
        
        let result = auth_system.login(login_req);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), AuthError::InvalidCredentials);
    }
    
    #[test]
    fn test_oauth_callback_new_user() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let oauth_req = OAuthCallbackRequest {
            provider: "google".to_string(),
            code: "code123".to_string(),
            state: "state123".to_string(),
        };
        
        let result = auth_system.oauth_callback(oauth_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "authenticated");
    }
    
    #[test]
    fn test_oauth_callback_existing_user() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let oauth_req = OAuthCallbackRequest {
            provider: "google".to_string(),
            code: "code123".to_string(),
            state: "state123".to_string(),
        };
        
        let result = auth_system.oauth_callback(oauth_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "authenticated");
    }
    
    #[test]
    fn test_mfa_challenge_happy_path() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let mfa_req = MFAChallengeRequest {
            challenge_id: "challenge123".to_string(),
            code: "123456".to_string(),
        };
        
        let result = auth_system.mfa_challenge(mfa_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "authenticated");
    }
    
    #[test]
    fn test_mfa_challenge_wrong_code() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let mfa_req = MFAChallengeRequest {
            challenge_id: "challenge123".to_string(),
            code: "wrongcode".to_string(),
        };
        
        let result = auth_system.mfa_challenge(mfa_req);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), AuthError::InvalidCode);
    }
    
    #[test]
    fn test_token_refresh_happy_path() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let refresh_req = TokenRefreshRequest {
            refresh_token: "refresh123".to_string(),
        };
        
        let result = auth_system.token_refresh(refresh_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "ok");
    }
    
    #[test]
    fn test_token_refresh_banned_user() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let refresh_req = TokenRefreshRequest {
            refresh_token: "refresh123".to_string(),
        };
        
        let result = auth_system.token_refresh(refresh_req);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), AuthError::UserBanned);
    }
    
    #[test]
    fn test_verify_access_token() {
        let mut auth_system = AuthSystem::new(MockDbPool::new(), "secret".to_string());
        
        let verify_req = VerifyAccessTokenRequest {
            token: "token123".to_string(),
        };
        
        let result = auth_system.verify_access_token(verify_req);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert!(response.success);
        assert_eq!(response.data.status(), "ok");
    }
}