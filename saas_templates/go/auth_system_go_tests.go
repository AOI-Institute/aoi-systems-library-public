package auth

import (
	"context"
	"net"
	"testing"
)

func TestSignupHappyPath(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.1"
	resp := as.Signup(ctx, "alice@example.com", "StrongPassword!12345", "Alice", ip)
	if !resp["success"].(bool) || resp["status"] != "pending_verification" {
		t.Fatalf("unexpected response: %v", resp)
	}
}

func TestSignupDuplicateEmail(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.2"
	_ = as.Signup(ctx, "bob@example.com", "AnotherStrongPass!67890", "Bob", ip)
	resp := as.Signup(ctx, "bob@example.com", "NewPass!1234567890", "Bob2", ip)
	if resp["error"] != "email_already_exists" {
		t.Fatalf("expected duplicate email error, got %v", resp)
	}
}

func TestSignupWeakPassword(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.3"
	resp := as.Signup(ctx, "carol@example.com", "short", "Carol", ip)
	if resp["error"] != "password_too_weak" {
		t.Fatalf("expected weak password error, got %v", resp)
	}
}

func TestSignupIPRateLimit(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.4"
	for i := 0; i < 5; i++ {
		_ = as.Signup(ctx, fmt.Sprintf("user%d@example.com", i), "StrongPassword!12345", "User", ip)
	}
	resp := as.Signup(ctx, "exceed@example.com", "StrongPassword!12345", "Exceed", ip)
	if resp["error"] != "too_many_signups_from_ip" {
		t.Fatalf("expected rate limit error, got %v", resp)
	}
}

func TestVerifyEmailHappyPath(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.5"
	as.Signup(ctx, "dave@example.com", "StrongPassword!12345", "Dave", ip)

	// fetch code directly from DB for test
	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)

	resp := as.VerifyEmail(ctx, "dave@example.com", code)
	if resp["status"] != "verified" {
		t.Fatalf("expected verified status, got %v", resp)
	}
}

func TestVerifyEmailExpiredCode(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.6"
	as.Signup(ctx, "eve@example.com", "StrongPassword!12345", "Eve", ip)

	// manually expire
	as.db.ExecContext(ctx, `UPDATE verification_codes SET expires_at = ? WHERE type='email'`,
		time.Now().Add(-time.Hour).UTC().Format(time.RFC3339))

	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)

	resp := as.VerifyEmail(ctx, "eve@example.com", code)
	if resp["error"] != "code_expired" {
		t.Fatalf("expected code_expired error, got %v", resp)
	}
}

func TestLoginHappyPathNoMFA(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.7"
	as.Signup(ctx, "frank@example.com", "StrongPassword!12345", "Frank", ip)

	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "frank@example.com", code)

	resp := as.Login(ctx, "frank@example.com", "StrongPassword!12345", "dev1", ip)
	if resp["status"] != "authenticated" {
		t.Fatalf("expected authenticated, got %v", resp)
	}
}

func TestLoginWithMFAEnabled(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.8"
	as.Signup(ctx, "grace@example.com", "StrongPassword!12345", "Grace", ip)

	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "grace@example.com", code)

	// enable MFA
	as.db.ExecContext(ctx, `UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE email = ?`,
		"BASE32SECRET", "grace@example.com")

	resp := as.Login(ctx, "grace@example.com", "StrongPassword!12345", "dev2", ip)
	if resp["status"] != "mfa_required" {
		t.Fatalf("expected mfa_required, got %v", resp)
	}
}

func TestLoginInvalidPassword(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.9"
	as.Signup(ctx, "henry@example.com", "StrongPassword!12345", "Henry", ip)

	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "henry@example.com", code)

	resp := as.Login(ctx, "henry@example.com", "WrongPassword!", "dev3", ip)
	if resp["error"] != "invalid_credentials" {
		t.Fatalf("expected invalid_credentials, got %v", resp)
	}
}

func TestOAuthCallbackNewUser(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	resp := as.OAuthCallback(ctx, "google", "newuser@example.com", "validstate")
	if resp["status"] != "authenticated" {
		t.Fatalf("expected authenticated, got %v", resp)
	}
}

func TestOAuthCallbackExistingUser(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.10"
	as.Signup(ctx, "ivy@example.com", "StrongPassword!12345", "Ivy", ip)
	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "ivy@example.com", code)

	resp := as.OAuthCallback(ctx, "github", "ivy@example.com", "validstate")
	if resp["status"] != "authenticated" {
		t.Fatalf("expected authenticated, got %v", resp)
	}
}

func TestMFAChallengeHappyPath(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.11"
	as.Signup(ctx, "jack@example.com", "StrongPassword!12345", "Jack", ip)
	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "jack@example.com", code)

	// enable MFA and trigger login to create challenge
	as.db.ExecContext(ctx, `UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE email = ?`,
		"BASE32SECRET", "jack@example.com")
	loginResp := as.Login(ctx, "jack@example.com", "StrongPassword!12345", "dev4", ip)
	challengeID := loginResp["challenge_id"].(string)

	// fetch generated MFA code
	var mfaCode string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='mfa' LIMIT 1`).Scan(&mfaCode)

	resp := as.MFAChallenge(ctx, challengeID, mfaCode)
	if resp["status"] != "authenticated" {
		t.Fatalf("expected authenticated, got %v", resp)
	}
}

func TestMFAChallengeWrongCode(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.12"
	as.Signup(ctx, "kate@example.com", "StrongPassword!12345", "Kate", ip)
	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "kate@example.com", code)

	as.db.ExecContext(ctx, `UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE email = ?`,
		"BASE32SECRET", "kate@example.com")
	loginResp := as.Login(ctx, "kate@example.com", "StrongPassword!12345", "dev5", ip)
	challengeID := loginResp["challenge_id"].(string)

	resp := as.MFAChallenge(ctx, challengeID, "000000")
	if resp["error"] != "invalid_code" {
		t.Fatalf("expected invalid_code, got %v", resp)
	}
}

func TestTokenRefreshHappyPath(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.13"
	as.Signup(ctx, "leo@example.com", "StrongPassword!12345", "Leo", ip)
	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "leo@example.com", code)

	loginResp := as.Login(ctx, "leo@example.com", "StrongPassword!12345", "dev6", ip)
	refreshToken := as.db.QueryRowContext(ctx,
		`SELECT refresh_token FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)`,
		"leo@example.com").Scan(new(string))
	// fetch token directly
	var rt string
	as.db.QueryRowContext(ctx,
		`SELECT refresh_token FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)`,
		"leo@example.com").Scan(&rt)

	resp := as.TokenRefresh(ctx, rt)
	if resp["status"] != "ok" {
		t.Fatalf("expected ok, got %v", resp)
	}
}

func TestTokenRefreshBannedUser(t *testing.T) {
	as, _ := NewAuthSystem()
	ctx := context.Background()
	ip := "192.0.2.14"
	as.Signup(ctx, "mia@example.com", "StrongPassword!12345", "Mia", ip)
	var code string
	as.db.QueryRowContext(ctx,
		`SELECT code FROM verification_codes WHERE type='email' LIMIT 1`).Scan(&code)
	_ = as.VerifyEmail(ctx, "mia@example.com", code)

	// create session manually
	userID := int64(1)
	sessionID, _ := generateRandomString(24)
	rt, _ := generateRandomString(32)
	now := time.Now().UTC()
	as.db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, refresh_token, created_at, expires_at, ip, device_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sessionID, userID, rt,
		now.Format(time.RFC3339),
		now.Add(refreshTokenTTL).Format(time.RFC3339),
		ip, "dev7")
	// ban user
	as.db.ExecContext(ctx, `UPDATE users SET status = 'banned' WHERE id = ?`, userID)

	resp := as.TokenRefresh(ctx, rt)
	if resp["error"] != "user_banned" {
		t.Fatalf("expected user_banned, got %v", resp)
	}
}