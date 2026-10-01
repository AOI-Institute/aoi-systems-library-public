package quotasratelimit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"
)

type Tier string

const (
	TierSolo       Tier = "solo"
	TierTeam       Tier = "team"
	TierEnterprise Tier = "enterprise"
)

type QuotaError struct {
	Code    string
	Message string
	Details map[string]interface{}
}

func (e *QuotaError) Error() string {
	return e.Message
}

var (
	ErrQuotaExceeded      = errors.New("quota_exceeded")
	ErrStorageQuotaExceeded = errors.New("storage_quota_exceeded")
	ErrRateLimitExceeded  = errors.New("rate_limit_exceeded")
	ErrIPRateLimitExceeded = errors.New("ip_rate_limit_exceeded")
	ErrFeatureNotAvailable = errors.New("feature_not_available")
)

type Config struct {
	DB *sql.DB
}

type Limiter struct {
	db *sql.DB
	mu sync.RWMutex

	userRateLimits map[string]*rateWindow
	ipRateLimits   map[string]*rateWindow
}

type rateWindow struct {
	requests []time.Time
	mu       sync.Mutex
}

var apiCallLimits = map[Tier]int64{
	TierSolo:       1000,
	TierTeam:       10000,
	TierEnterprise: -1,
}

var storageLimits = map[Tier]int64{
	TierSolo:       1_000_000_000,
	TierTeam:       100_000_000_000,
	TierEnterprise: -1,
}

var featureGates = map[string][]Tier{
	"feature_a": {TierTeam, TierEnterprise},
	"feature_b": {TierEnterprise},
	"feature_c": {TierSolo, TierTeam, TierEnterprise},
}

const (
	rateLimitPerUserWindow = time.Minute
	rateLimitPerUserMax    = 100
	rateLimitPerIPWindow   = time.Second
	rateLimitPerIPMax      = 10
)

func NewLimiter(cfg Config) (*Limiter, error) {
	if cfg.DB == nil {
		return nil, errors.New("database connection required")
	}
	l := &Limiter{
		db:             cfg.DB,
		userRateLimits: make(map[string]*rateWindow),
		ipRateLimits:   make(map[string]*rateWindow),
	}
	if err := l.initSchema(context.Background()); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *Limiter) initSchema(ctx context.Context) error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS usage_metrics (
			user_id TEXT NOT NULL,
			month TEXT NOT NULL,
			call_count INTEGER NOT NULL DEFAULT 0,
			storage_bytes INTEGER NOT NULL DEFAULT 0,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (user_id, month)
		)`,
		`CREATE TABLE IF NOT EXISTS api_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			ip TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			status_code INTEGER NOT NULL,
			response_time_ms INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_calls_user_time ON api_calls(user_id, timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_api_calls_ip_time ON api_calls(ip, timestamp)`,
	}
	for _, q := range queries {
		if _, err := l.db.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("schema init failed: %w", err)
		}
	}
	return nil
}

func currentMonth() string {
	return time.Now().UTC().Format("2006-01")
}

func (l *Limiter) CheckAPIQuota(ctx context.Context, userID string, tier Tier) (bool, *QuotaError, error) {
	limit, ok := apiCallLimits[tier]
	if !ok {
		return false, nil, fmt.Errorf("unknown tier: %s", tier)
	}
	if limit == -1 {
		return true, nil, nil
	}

	month := currentMonth()
	var currentUsage int64
	err := l.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(call_count), 0) FROM usage_metrics WHERE user_id = ? AND month = ?`,
		userID, month).Scan(&currentUsage)
	if err != nil && err != sql.ErrNoRows {
		return false, nil, fmt.Errorf("query usage: %w", err)
	}

	if currentUsage+1 > limit {
		resetDate := time.Now().UTC().AddDate(0, 1, 0).Format("2006-01-02")
		return false, &QuotaError{
			Code:    "quota_exceeded",
			Message: "API call quota exceeded",
			Details: map[string]interface{}{
				"usage":      currentUsage,
				"limit":      limit,
				"reset_date": resetDate,
			},
		}, nil
	}
	return true, nil, nil
}

func (l *Limiter) IncrementAPIUsage(ctx context.Context, userID string) error {
	month := currentMonth()
	_, err := l.db.ExecContext(ctx, `
		INSERT INTO usage_metrics (user_id, month, call_count, storage_bytes, updated_at)
		VALUES (?, ?, 1, 0, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, month) DO UPDATE SET
			call_count = call_count + 1,
			updated_at = CURRENT_TIMESTAMP
	`, userID, month)
	return err
}

func (l *Limiter) CheckStorageQuota(ctx context.Context, userID string, tier Tier, incomingFileSize int64) (bool, *QuotaError, error) {
	limit, ok := storageLimits[tier]
	if !ok {
		return false, nil, fmt.Errorf("unknown tier: %s", tier)
	}
	if limit == -1 {
		return true, nil, nil
	}

	var currentUsage int64
	err := l.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(storage_bytes), 0) FROM usage_metrics WHERE user_id = ?`,
		userID).Scan(&currentUsage)
	if err != nil && err != sql.ErrNoRows {
		return false, nil, fmt.Errorf("query storage: %w", err)
	}

	if currentUsage+incomingFileSize > limit {
		return false, &QuotaError{
			Code:    "storage_quota_exceeded",
			Message: "Storage quota exceeded",
			Details: map[string]interface{}{
				"usage": currentUsage,
				"limit": limit,
			},
		}, nil
	}
	return true, nil, nil
}

func (l *Limiter) IncrementStorageUsage(ctx context.Context, userID string, bytes int64) error {
	month := currentMonth()
	_, err := l.db.ExecContext(ctx, `
		INSERT INTO usage_metrics (user_id, month, call_count, storage_bytes, updated_at)
		VALUES (?, ?, 0, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, month) DO UPDATE SET
			storage_bytes = storage_bytes + ?,
			updated_at = CURRENT_TIMESTAMP
	`, userID, month, bytes, bytes)
	return err
}

func (l *Limiter) getUserWindow(userID string) *rateWindow {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.userRateLimits[userID]
	if !ok {
		w = &rateWindow{requests: make([]time.Time, 0, rateLimitPerUserMax+1)}
		l.userRateLimits[userID] = w
	}
	return w
}

func (l *Limiter) getIPWindow(ip string) *rateWindow {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.ipRateLimits[ip]
	if !ok {
		w = &rateWindow{requests: make([]time.Time, 0, rateLimitPerIPMax+1)}
		l.ipRateLimits[ip] = w
	}
	return w
}

func (w *rateWindow) checkAndRecord(limit int, window time.Duration) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-window)
	valid := w.requests[:0]
	for _, t := range w.requests {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	w.requests = valid
	if len(w.requests) >= limit {
		return false
	}
	w.requests = append(w.requests, now)
	return true
}

func (l *Limiter) CheckRateLimitPerUser(userID string) (bool, *QuotaError) {
	w := l.getUserWindow(userID)
	ok := w.checkAndRecord(rateLimitPerUserMax, rateLimitPerUserWindow)
	if !ok {
		return false, &QuotaError{
			Code:    "rate_limit_exceeded",
			Message: "Rate limit exceeded (100 requests per minute)",
			Details: map[string]interface{}{
				"reset_seconds": 60,
			},
		}
	}
	return true, nil
}

func (l *Limiter) CheckRateLimitPerIP(ip string) (bool, *QuotaError) {
	w := l.getIPWindow(ip)
	ok := w.checkAndRecord(rateLimitPerIPMax, rateLimitPerIPWindow)
	if !ok {
		return false, &QuotaError{
			Code:    "ip_rate_limit_exceeded",
			Message: "IP rate limit exceeded (10 requests per second)",
			Details: map[string]interface{}{
				"reset_seconds": 1,
			},
		}
	}
	return true, nil
}

func (l *Limiter) CheckFeatureGate(ctx context.Context, userID string, tier Tier, feature string) (bool, *QuotaError, error) {
	allowedTiers, ok := featureGates[feature]
	if !ok {
		return false, nil, fmt.Errorf("unknown feature: %s", feature)
	}

	allowed := false
	for _, t := range allowedTiers {
		if t == tier {
			allowed = true
			break
		}
	}

	if !allowed {
		minTier := "team"
		if feature == "feature_b" {
			minTier = "enterprise"
		}
		return false, &QuotaError{
			Code:    "feature_not_available",
			Message: "Feature not available in current tier",
			Details: map[string]interface{}{
				"tier":          string(tier),
				"minimum_tier":  minTier,
				"upgrade_url":   "/upgrade",
			},
		}, nil
	}
	return true, nil, nil
}

func (l *Limiter) LogAPICall(ctx context.Context, userID, ip, endpoint string, statusCode, responseTimeMs int) error {
	_, err := l.db.ExecContext(ctx, `
		INSERT INTO api_calls (user_id, ip, endpoint, timestamp, status_code, response_time_ms)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
	`, userID, ip, endpoint, statusCode, responseTimeMs)
	return err
}

func (l *Limiter) HandleMonthRollover(ctx context.Context) error {
	newMonth := currentMonth()
	_, err := l.db.ExecContext(ctx, `
		DELETE FROM usage_metrics WHERE month != ?
	`, newMonth)
	return err
}

func (l *Limiter) HandleTierUpgrade(ctx context.Context, userID string, newTier Tier) error {
	if _, ok := apiCallLimits[newTier]; !ok {
		return fmt.Errorf("unknown tier: %s", newTier)
	}
	return nil
}

func (l *Limiter) GetCurrentUsage(ctx context.Context, userID string) (callCount, storageBytes int64, err error) {
	month := currentMonth()
	err = l.db.QueryRowContext(ctx,
		`SELECT COALESCE(call_count, 0), COALESCE(storage_bytes, 0) FROM usage_metrics WHERE user_id = ? AND month = ?`,
		userID, month).Scan(&callCount, &storageBytes)
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	return
}