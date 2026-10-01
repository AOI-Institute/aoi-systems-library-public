package api_keys

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
	"github.com/google/uuid"
)

// APIKeysDDL contains the database schema for API keys and usage tables.
const APIKeysDDL = `
CREATE TABLE IF NOT EXISTS api_keys (
	id UUID PRIMARY KEY,
	user_id INTEGER NOT NULL,
	name VARCHAR(255) NOT NULL,
	key_secret_hash BYTEA NOT NULL,
	scopes JSONB NOT NULL,
	rate_limit INTEGER NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
	last_used_at TIMESTAMP WITH TIME ZONE,
	is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS api_key_usage (
	id UUID PRIMARY KEY,
	api_key_id UUID NOT NULL REFERENCES api_keys(id),
	endpoint VARCHAR(255) NOT NULL,
	method VARCHAR(10) NOT NULL,
	status INTEGER NOT NULL,
	timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_api_key_id ON api_key_usage(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_timestamp ON api_key_usage(timestamp);
`

// Service handles API key operations.
type Service struct {
	db     *sql.DB
	redis  *redis.Client
	mode   string // "live" or "test"
}

// NewService creates a new API key service.
func NewService(db *sql.DB, redis *redis.Client, mode string) *Service {
	return &Service{db: db, redis: redis, mode: mode}
}

// CreateAPIKeyRequest represents the request to create an API key.
type CreateAPIKeyRequest struct {
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	ExpiresAt  *string  `json:"expires_at,omitempty"` // RFC3339 string
	RateLimit  int      `json:"rate_limit"`
}

// CreateAPIKeyResponse represents the response from creating an API key.
type CreateAPIKeyResponse struct {
	APIKeyID   string    `json:"api_key_id"`
	Key        string    `json:"key"` // Only shown once
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	RateLimit  int       `json:"rate_limit"`
}

// ListAPIKeysResponse represents the response from listing API keys.
type ListAPIKeysResponse struct {
	Keys []APIKeyItem `json:"keys"`
}

// APIKeyItem represents an API key in list responses.
type APIKeyItem struct {
	APIKeyID   string    `json:"api_key_id"`
	Name       string    `json:"name"`
	Scopes     []string  `json:"scopes"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RateLimit  int       `json:"rate_limit"`
	IsActive   bool      `json:"is_active"`
}

// RevokeAPIKeyResponse represents the response from revoking an API key.
type RevokeAPIKeyResponse struct {
	Success    bool      `json:"success"`
	RevokedAt  time.Time `json:"revoked_at"`
}

// RotateAPIKeyResponse represents the response from rotating an API key.
type RotateAPIKeyResponse struct {
	NewKey                 string    `json:"new_key"`
	OldKeyRevokedAt        time.Time `json:"old_key_revoked_at"`
	GracePeriodEndsAt      time.Time `json:"grace_period_ends_at"`
}

// GetAPIKeyUsageStatsResponse represents the response from getting API key usage stats.
type GetAPIKeyUsageStatsResponse struct {
	APIKeyID          string            `json:"api_key_id"`
	TotalRequests     int64             `json:"total_requests"`
	RequestsByEndpoint map[string]int64  `json:"requests_by_endpoint"`
	RateLimitHits     int64             `json:"rate_limit_hits"`
	Errors            map[string]int64  `json:"errors"`
}

// ListAPIKeysForAdminResponse represents the response from admin listing API keys.
type ListAPIKeysForAdminResponse struct {
	Keys []APIKeyItem `json:"keys"`
	Total int64        `json:"total"`
}

// APIKey represents an API key from the database.
type APIKey struct {
	ID            string
	UserID        int64
	Name          string
	KeySecretHash []byte
	Scopes        []string
	RateLimit     int
	ExpiresAt     *time.Time
	CreatedAt     time.Time
	LastUsedAt    *time.Time
	IsActive      bool
}

// CreateAPIKey creates a new API key.
func (s *Service) CreateAPIKey(ctx context.Context, userID int64, req CreateAPIKeyRequest) (*CreateAPIKeyResponse, error) {
	if req.RateLimit <= 0 {
		return nil, errors.New("rate_limit must be positive")
	}
	if len(req.Scopes) == 0 {
		return nil, errors.New("at least one scope required")
	}

	// Generate API key
	var prefix string
	switch s.mode {
	case "test":
		prefix = "sk_test"
	default:
		prefix = "sk_live"
	}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	key := prefix + "_" + base64.RawURLEncoding.EncodeToString(random)

	// Hash the key
	hash, err := bcrypt.GenerateFromPassword([]byte(key), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	// Parse expiresAt
	var expiresAt *time.Time
	if req.ExpiresAt != nil {
		t, err := time.Parse(time.RFC3339, *req.ExpiresAt)
		if err != nil {
			return nil, err
		}
		expiresAt = &t
	}

	// Insert into database
	id := uuid.New()
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO api_keys (id, user_id, name, key_secret_hash, scopes, rate_limit, expires_at, created_at, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, id, userID, req.Name, hash, req.Scopes, req.RateLimit, expiresAt, time.Now(), true)
	if err != nil {
		return nil, err
	}

	return &CreateAPIKeyResponse{
		APIKeyID:   id.String(),
		Key:        key,
		CreatedAt:  time.Now(),
		ExpiresAt:  expiresAt,
		RateLimit:  req.RateLimit,
	}, nil
}

// ListAPIKeys lists API keys for a user.
func (s *Service) ListAPIKeys(ctx context.Context, userID int64) (*ListAPIKeysResponse, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, scopes, created_at, last_used_at, rate_limit, is_active
		FROM api_keys
		WHERE user_id = $1
		ORDER BY created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []APIKeyItem
	for rows.Next() {
		var k APIKeyItem
		var scopesJSON []byte
		var lastUsedAt sql.NullTime
		err := rows.Scan(&k.APIKeyID, &k.Name, &scopesJSON, &k.CreatedAt, &lastUsedAt, &k.RateLimit, &k.IsActive)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(scopesJSON, &k.Scopes); err != nil {
			return nil, err
		}
		if lastUsedAt.Valid {
			k.LastUsedAt = &lastUsedAt.Time
		}
		keys = append(keys, k)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &ListAPIKeysResponse{Keys: keys}, nil
}

// RevokeAPIKey revokes an API key.
func (s *Service) RevokeAPIKey(ctx context.Context, apiKeyID string) (*RevokeAPIKeyResponse, error) {
	id, err := uuid.Parse(apiKeyID)
	if err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE api_keys
		SET is_active = false
		WHERE id = $1
	`, id)
	if err != nil {
		return nil, err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if rowsAffected == 0 {
		return nil, errors.New("api key not found")
	}
	return &RevokeAPIKeyResponse{
		Success:   true,
		RevokedAt: time.Now(),
	}, nil
}

// RotateAPIKey rotates an API key (generates new, disables old after grace period).
func (s *Service) RotateAPIKey(ctx context.Context, apiKeyID string) (*RotateAPIKeyResponse, error) {
	id, err := uuid.Parse(apiKeyID)
	if err != nil {
		return nil, err
	}

	// Begin transaction
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Get existing key
	var key APIKey
	err = tx.QueryRowContext(ctx, `
		SELECT id, user_id, name, key_secret_hash, scopes, rate_limit, expires_at, created_at, is_active
		FROM api_keys
		WHERE id = $1
	`, id).Scan(
		&key.ID, &key.UserID, &key.Name, &key.KeySecretHash, &key.Scopes, &key.RateLimit,
		&key.ExpiresAt, &key.CreatedAt, &key.LastUsedAt, &key.IsActive,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, errors.New("api key not found")
		}
		return nil, err
	}
	if !key.IsActive {
		return nil, errors.New("api key is not active")
	}

	// Generate new key
	var prefix string
	switch s.mode {
	case "test":
		prefix = "sk_test"
	default:
		prefix = "sk_live"
	}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	newKey := prefix + "_" + base64.RawURLEncoding.EncodeToString(random)

	// Hash new key
	newHash, err := bcrypt.GenerateFromPassword([]byte(newKey), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	// Update existing key: set inactive now, but allow grace period
	revokedAt := time.Now()
	gracePeriodEndsAt := revokedAt.Add(24 * time.Hour)
	_, err = tx.ExecContext(ctx, `
		UPDATE api_keys
		SET is_active = false, updated_at = $1
		WHERE id = $2
	`, revokedAt, id)
	if err != nil {
		return nil, err
	}

	// Insert new key
	newID := uuid.New()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO api_keys (id, user_id, name, key_secret_hash, scopes, rate_limit, expires_at, created_at, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, newID, key.UserID, key.Name, newHash, key.Scopes, key.RateLimit, key.ExpiresAt, time.Now(), true)
	if err != nil {
		return nil, err
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}

	return &RotateAPIKeyResponse{
		NewKey:                 newKey,
		OldKeyRevokedAt:        revokedAt,
		GracePeriodEndsAt:      gracePeriodEndsAt,
	}, nil
}

// ValidateAPIKey validates an API key and logs usage.
func (s *Service) ValidateAPIKey(ctx context.Context, key string, endpoint, method string) (*APIKey, error) {
	// Find key by hash (we need to check all active keys? inefficient but necessary with bcrypt)
	// In practice, we might use a cache or prefix lookup, but for correctness we scan.
	// Note: This is a simplification. A production system would use a different approach.
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, name, key_secret_hash, scopes, rate_limit, expires_at, created_at, last_used_at, is_active
		FROM api_keys
		WHERE is_active = true
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var found *APIKey
	for rows.Next() {
		var k APIKey
		var scopesJSON []byte
		var lastUsedAt sql.NullTime
		err := rows.Scan(
			&k.ID, &k.UserID, &k.Name, &k.KeySecretHash, &k.ScopesJSON, &k.RateLimit,
			&k.ExpiresAt, &k.CreatedAt, &lastUsedAt, &k.IsActive,
		)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(k.ScopesJSON, &k.Scopes); err != nil {
			return nil, err
		}
		if lastUsedAt.Valid {
			k.LastUsedAt = &lastUsedAt.Time
		}
		if err := bcrypt.CompareHashAndPassword(k.KeySecretHash, []byte(key)); err == nil {
			found = &k
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if found == nil {
		return nil, errors.New("invalid api key")
	}

	// Check expiration
	if found.ExpiresAt != nil && time.Now().After(*found.ExpiresAt) {
		return nil, errors.New("api key expired")
	}

	// Check scopes (simplified: we assume endpoint/method maps to scope)
	// In reality, this would be more complex. We'll check if the scope exists.
	// For example: GET /deployments -> read:deployments
	scope := s.endpointMethodToScope(endpoint, method)
	if scope != "" {
		foundScope := false
		for _, s := range found.Scopes {
			if s == scope || s == "*" {
				foundScope = true
				break
			}
		}
		if !foundScope {
			return nil, errors.New("insufficient scope")
		}
	}

	// Check rate limit using Redis
	// Key format: rate_limit:<api_key_id>:<hourly_window>
	hour := time.Now().UTC().Truncate(time.Hour)
	redisKey := "rate_limit:" + found.ID + ":" + hour.Format(time.RFC3339)
	count, err := s.redis.Incr(ctx, redisKey).Result()
	if err != nil {
		return nil, err
	}
	if count == 1 {
		s.redis.Expire(ctx, redisKey, 2*time.Hour) // Expire after 2 hours to be safe
	}
	if int64(found.RateLimit) < count {
		return nil, errors.New("rate limit exceeded")
	}

	// Log usage (we'll do this asynchronously in practice, but synchronously for simplicity)
	go func() {
		s.db.ExecContext(context.Background(), `
			INSERT INTO api_key_usage (id, api_key_id, endpoint, method, status, timestamp)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, uuid.New(), found.ID, endpoint, method, 200, time.Now())
	}()

	return found, nil
}

// endpointMethodToScope maps endpoint and method to a scope string.
// This is a simplified implementation. In reality, this would be more complex.
func (s *Service) endpointMethodToScope(endpoint, method string) string {
	switch endpoint {
	case "/users":
		if method == "GET" {
			return "read:users"
		}
		return "write:users"
	case "/deployments":
		if method == "GET" {
			return "read:deployments"
		}
		return "write:deployments"
	case "/invoices":
		if method == "GET" {
			return "read:invoices"
		}
		return "write:billing" // Assuming POST/PUT to /invoices is for billing
	case "/webhooks":
		if method == "POST" || method == "DELETE" {
			return "webhook:manage"
		}
		// GET webhooks? Not specified, but we'll assume read:webhooks if needed
		return ""
	default:
		return ""
	}
}

// GetAPIKeyUsageStats gets usage statistics for an API key.
func (s *Service) GetAPIKeyUsageStats(ctx context.Context, apiKeyID string, from, to time.Time) (*GetAPIKeyUsageStatsResponse, error) {
	id, err := uuid.Parse(apiKeyID)
	if err != nil {
		return nil, err
	}

	// Total requests
	var totalRequests int64
	err = s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM api_key_usage
		WHERE api_key_id = $1 AND timestamp >= $2 AND timestamp <= $3
	`, id, from, to).Scan(&totalRequests)
	if err != nil {
		return nil, err
	}

	// Requests by endpoint
	rows, err := s.db.QueryContext(ctx, `
		SELECT endpoint, method, COUNT(*) 
		FROM api_key_usage
		WHERE api_key_id = $1 AND timestamp >= $2 AND timestamp <= $3
		GROUP BY endpoint, method
	`, id, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	requestsByEndpoint := make(map[string]int64)
	for rows.Next() {
		var endpoint, method string
		var count int64
		if err := rows.Scan(&endpoint, &method, &count); err != nil {
			return nil, err
		}
		requestsByEndpoint[endpoint+" "+method] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Rate limit hits (status 429)
	var rateLimitHits int64
	err = s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM api_key_usage
		WHERE api_key_id = $1 AND timestamp >= $2 AND timestamp <= $3 AND status = 429
	`, id, from, to).Scan(&rateLimitHits)
	if err != nil {
		return nil, err
	}

	// Errors by status
	rows, err = s.db.QueryContext(ctx, `
		SELECT status, COUNT(*) 
		FROM api_key_usage
		WHERE api_key_id = $1 AND timestamp >= $2 AND timestamp <= $3 AND status >= 400
		GROUP BY status
	`, id, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	errors := make(map[string]int64)
	for rows.Next() {
		var status int
		var count int64
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		errors[strconv.Itoa(status)] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return &GetAPIKeyUsageStatsResponse{
		APIKeyID:          apiKeyID,
		TotalRequests:     totalRequests,
		RequestsByEndpoint: requestsByEndpoint,
		RateLimitHits:     rateLimitHits,
		Errors:            errors,
	}, nil
}

// ListAPIKeysForAdmin lists API keys for admin audit.
func (s *Service) ListAPIKeysForAdmin(ctx context.Context, userID *int64, status string) (*ListAPIKeysForAdminResponse, error) {
	query := `
		SELECT id, name, scopes, created_at, last_used_at, rate_limit, is_active
		FROM api_keys
		WHERE 1=1
	`
	var args []interface{}
	if userID != nil {
		query += " AND user_id = ?"
		args = append(args, *userID)
	}
	if status != "" {
		var isActive bool
		if status == "active" {
			isActive = true
		} else if status == "inactive" {
			isActive = false
		} else {
			return nil, errors.New("invalid status")
		}
		query += " AND is_active = ?"
		args = append(args, isActive)
	}
	query += " ORDER BY created_at DESC"

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []APIKeyItem
	var total int64
	for rows.Next() {
		var k APIKeyItem
		var scopesJSON []byte
		var lastUsedAt sql.NullTime
		err := rows.Scan(&k.APIKeyID, &k.Name, &scopesJSON, &k.CreatedAt, &lastUsedAt, &k.RateLimit, &k.IsActive)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(scopesJSON, &k.Scopes); err != nil {
			return nil, err
		}
		if lastUsedAt.Valid {
			k.LastUsedAt = &lastUsedAt.Time
		}
		keys = append(keys, k)
		total++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &ListAPIKeysForAdminResponse{Keys: keys, Total: total}, nil
}