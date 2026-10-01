package featureflags

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"sync"
	"time"
)

// Store defines the storage interface for feature flags.
type Store interface {
	GetFlag(ctx context.Context, key string) (*Flag, error)
	SetFlag(ctx context.Context, flag *Flag) error
	GetAuditLog(ctx context.Context, flagKey string) ([]AuditEntry, error)
	AddAuditEntry(ctx context.Context, entry AuditEntry) error
	Close() error
}

// Flag represents a feature flag.
type Flag struct {
	Key          string          `json:"key"`
	Type         string          `json:"type"`
	DefaultValue json.RawMessage `json:"default_value"`
	Enabled      bool            `json:"enabled"`
	Rules        json.RawMessage `json:"rules"`
	UpdatedAt    time.Time       `json:"updated_at"`
	UpdatedBy    string          `json:"updated_by"`
}

// AuditEntry represents an audit log entry.
type AuditEntry struct {
	ID        int64           `json:"id"`
	FlagKey   string          `json:"flag_key"`
	Action    string          `json:"action"`
	OldValue  json.RawMessage `json:"old_value"`
	NewValue  json.RawMessage `json:"new_value"`
	ActorID   string          `json:"actor_id"`
	At        time.Time       `json:"at"`
}

// EvaluationContext holds the context for flag evaluation.
type EvaluationContext struct {
	TargetingKey string                 `json:"targeting_key"`
	UserID       string                 `json:"user_id,omitempty"`
	OrgID        string                 `json:"org_id,omitempty"`
	Tier         string                 `json:"tier,omitempty"`
	Email        string                 `json:"email,omitempty"`
	Attributes   map[string]interface{} `json:"attributes,omitempty"`
}

// EvaluationDetail holds the result of a flag evaluation.
type EvaluationDetail struct {
	FlagKey      string      `json:"flag_key"`
	Value        interface{} `json:"value"`
	Variant      string      `json:"variant,omitempty"`
	Reason       string      `json:"reason"`
	ErrorCode    string      `json:"error_code,omitempty"`
	ErrorMessage string      `json:"error_message,omitempty"`
}

// Reason constants.
const (
	ReasonStatic         = "STATIC"
	ReasonDefault        = "DEFAULT"
	ReasonTargetingMatch = "TARGETING_MATCH"
	ReasonSplit          = "SPLIT"
	ReasonDisabled       = "DISABLED"
	ReasonError          = "ERROR"
)

// ErrorCode constants.
const (
	ErrorCodeFlagNotFound   = "FLAG_NOT_FOUND"
	ErrorCodeTypeMismatch   = "TYPE_MISMATCH"
	ErrorCodeParseError     = "PARSE_ERROR"
	ErrorCodeGeneral        = "GENERAL"
)

// FlagType constants.
const (
	TypeBoolean = "boolean"
	TypeString  = "string"
	TypeNumber  = "number"
	TypeObject  = "object"
)

// Rule represents a single targeting rule.
type Rule struct {
	Conditions []Condition `json:"conditions"`
	Variant    string      `json:"variant"`
	Value      interface{} `json:"value"`
	Rollout    *Rollout    `json:"rollout,omitempty"`
}

// Condition represents a targeting condition.
type Condition struct {
	Attribute string      `json:"attribute"`
	Operator  string      `json:"operator"`
	Value     interface{} `json:"value"`
}

// Rollout represents a percentage rollout.
type Rollout struct {
	Percentage int `json:"percentage"`
}

// Client is the feature flag evaluation client.
type Client struct {
	store Store
}

// NewClient creates a new feature flag client.
func NewClient(store Store) *Client {
	return &Client{store: store}
}

// GetBooleanValue evaluates a boolean flag.
func (c *Client) GetBooleanValue(ctx context.Context, flagKey string, defaultValue bool, evalCtx EvaluationContext) bool {
	detail := c.getBooleanDetails(ctx, flagKey, defaultValue, evalCtx)
	return detail.Value.(bool)
}

// GetStringValue evaluates a string flag.
func (c *Client) GetStringValue(ctx context.Context, flagKey string, defaultValue string, evalCtx EvaluationContext) string {
	detail := c.getStringDetails(ctx, flagKey, defaultValue, evalCtx)
	return detail.Value.(string)
}

// GetNumberValue evaluates a number flag.
func (c *Client) GetNumberValue(ctx context.Context, flagKey string, defaultValue float64, evalCtx EvaluationContext) float64 {
	detail := c.getNumberDetails(ctx, flagKey, defaultValue, evalCtx)
	return detail.Value.(float64)
}

// GetObjectValue evaluates an object flag.
func (c *Client) GetObjectValue(ctx context.Context, flagKey string, defaultValue map[string]interface{}, evalCtx EvaluationContext) map[string]interface{} {
	detail := c.getObjectDetails(ctx, flagKey, defaultValue, evalCtx)
	return detail.Value.(map[string]interface{})
}

// GetBooleanDetails evaluates a boolean flag with details.
func (c *Client) GetBooleanDetails(ctx context.Context, flagKey string, defaultValue bool, evalCtx EvaluationContext) EvaluationDetail {
	return c.getBooleanDetails(ctx, flagKey, defaultValue, evalCtx)
}

// GetStringDetails evaluates a string flag with details.
func (c *Client) GetStringDetails(ctx context.Context, flagKey string, defaultValue string, evalCtx EvaluationContext) EvaluationDetail {
	return c.getStringDetails(ctx, flagKey, defaultValue, evalCtx)
}

// GetNumberDetails evaluates a number flag with details.
func (c *Client) GetNumberDetails(ctx context.Context, flagKey string, defaultValue float64, evalCtx EvaluationContext) EvaluationDetail {
	return c.getNumberDetails(ctx, flagKey, defaultValue, evalCtx)
}

// GetObjectDetails evaluates an object flag with details.
func (c *Client) GetObjectDetails(ctx context.Context, flagKey string, defaultValue map[string]interface{}, evalCtx EvaluationContext) EvaluationDetail {
	return c.getObjectDetails(ctx, flagKey, defaultValue, evalCtx)
}

// SetFlag creates or updates a feature flag with audit logging.
func (c *Client) SetFlag(ctx context.Context, actor string, key, flagType string, defaultValue interface{}, enabled bool, rules interface{}) error {
	now := time.Now().UTC()

	defaultJSON, err := json.Marshal(defaultValue)
	if err != nil {
		return err
	}

	rulesJSON, err := json.Marshal(rules)
	if err != nil {
		return err
	}

	oldFlag, _ := c.store.GetFlag(ctx, key)
	var oldValue json.RawMessage
	if oldFlag != nil {
		oldValueMap := map[string]interface{}{
			"type":          oldFlag.Type,
			"default_value": json.RawMessage(oldFlag.DefaultValue),
			"enabled":       oldFlag.Enabled,
			"rules":         json.RawMessage(oldFlag.Rules),
		}
		oldValue, _ = json.Marshal(oldValueMap)
	} else {
		oldValue = json.RawMessage("null")
	}

	flag := &Flag{
		Key:          key,
		Type:         flagType,
		DefaultValue: defaultJSON,
		Enabled:      enabled,
		Rules:        rulesJSON,
		UpdatedAt:    now,
		UpdatedBy:    actor,
	}

	if err := c.store.SetFlag(ctx, flag); err != nil {
		return err
	}

	newValue := map[string]interface{}{
		"type":          flagType,
		"default_value": defaultValue,
		"enabled":       enabled,
		"rules":         rules,
	}
	newJSON, _ := json.Marshal(newValue)

	audit := AuditEntry{
		FlagKey:  key,
		Action:   "set_flag",
		OldValue: oldValue,
		NewValue: newJSON,
		ActorID:  actor,
		At:       now,
	}

	return c.store.AddAuditEntry(ctx, audit)
}

func (c *Client) getBooleanDetails(ctx context.Context, flagKey string, defaultValue bool, evalCtx EvaluationContext) EvaluationDetail {
	return c.evaluate(ctx, flagKey, TypeBoolean, defaultValue, evalCtx)
}

func (c *Client) getStringDetails(ctx context.Context, flagKey string, defaultValue string, evalCtx EvaluationContext) EvaluationDetail {
	return c.evaluate(ctx, flagKey, TypeString, defaultValue, evalCtx)
}

func (c *Client) getNumberDetails(ctx context.Context, flagKey string, defaultValue float64, evalCtx EvaluationContext) EvaluationDetail {
	return c.evaluate(ctx, flagKey, TypeNumber, defaultValue, evalCtx)
}

func (c *Client) getObjectDetails(ctx context.Context, flagKey string, defaultValue map[string]interface{}, evalCtx EvaluationContext) EvaluationDetail {
	return c.evaluate(ctx, flagKey, TypeObject, defaultValue, evalCtx)
}

func (c *Client) evaluate(ctx context.Context, flagKey, expectedType string, defaultValue interface{}, evalCtx EvaluationContext) EvaluationDetail {
	defer func() {
		recover()
	}()

	flag, err := c.store.GetFlag(ctx, flagKey)
	if err != nil {
		return EvaluationDetail{
			FlagKey:      flagKey,
			Value:        defaultValue,
			Reason:       ReasonError,
			ErrorCode:    ErrorCodeFlagNotFound,
			ErrorMessage: "flag not found",
		}
	}

	if flag == nil {
		return EvaluationDetail{
			FlagKey:      flagKey,
			Value:        defaultValue,
			Reason:       ReasonError,
			ErrorCode:    ErrorCodeFlagNotFound,
			ErrorMessage: "flag not found",
		}
	}

	if flag.Type != expectedType {
		return EvaluationDetail{
			FlagKey:      flagKey,
			Value:        defaultValue,
			Reason:       ReasonError,
			ErrorCode:    ErrorCodeTypeMismatch,
			ErrorMessage: "flag type is " + flag.Type + ", expected " + expectedType,
		}
	}

	if !flag.Enabled {
		return EvaluationDetail{
			FlagKey: flagKey,
			Value:   defaultValue,
			Reason:  ReasonDisabled,
		}
	}

	var rules []Rule
	if len(flag.Rules) > 0 {
		if err := json.Unmarshal(flag.Rules, &rules); err != nil {
			return EvaluationDetail{
				FlagKey:      flagKey,
				Value:        defaultValue,
				Reason:       ReasonError,
				ErrorCode:    ErrorCodeParseError,
				ErrorMessage: "failed to parse rules: " + err.Error(),
			}
		}
	}

	for _, rule := range rules {
		if c.matchConditions(rule.Conditions, evalCtx) {
			if rule.Rollout != nil && rule.Rollout.Percentage > 0 {
				bucket := c.computeBucket(flagKey, evalCtx.TargetingKey)
				if bucket >= rule.Rollout.Percentage {
					continue
				}
				value, ok := c.coerceValue(rule.Value, expectedType)
				if !ok {
					return EvaluationDetail{
						FlagKey:      flagKey,
						Value:        defaultValue,
						Reason:       ReasonError,
						ErrorCode:    ErrorCodeTypeMismatch,
						ErrorMessage: "rule value type mismatch",
					}
				}
				return EvaluationDetail{
					FlagKey: flagKey,
					Value:   value,
					Variant: rule.Variant,
					Reason:  ReasonSplit,
				}
			}

			value, ok := c.coerceValue(rule.Value, expectedType)
			if !ok {
				return EvaluationDetail{
					FlagKey:      flagKey,
					Value:        defaultValue,
					Reason:       ReasonError,
					ErrorCode:    ErrorCodeTypeMismatch,
					ErrorMessage: "rule value type mismatch",
				}
			}
			return EvaluationDetail{
				FlagKey: flagKey,
				Value:   value,
				Variant: rule.Variant,
				Reason:  ReasonTargetingMatch,
			}
		}
	}

	defaultVal, ok := c.coerceValue(flag.DefaultValue, expectedType)
	if !ok {
		return EvaluationDetail{
			FlagKey: flagKey,
			Value:   defaultValue,
			Reason:  ReasonDefault,
		}
	}

	return EvaluationDetail{
		FlagKey: flagKey,
		Value:   defaultVal,
		Reason:  ReasonDefault,
	}
}

func (c *Client) matchConditions(conditions []Condition, evalCtx EvaluationContext) bool {
	for _, cond := range conditions {
		if !c.matchCondition(cond, evalCtx) {
			return false
		}
	}
	return true
}

func (c *Client) matchCondition(cond Condition, evalCtx EvaluationContext) bool {
	var attrValue interface{}
	switch cond.Attribute {
	case "targeting_key":
		attrValue = evalCtx.TargetingKey
	case "user_id":
		attrValue = evalCtx.UserID
	case "org_id":
		attrValue = evalCtx.OrgID
	case "tier":
		attrValue = evalCtx.Tier
	case "email":
		attrValue = evalCtx.Email
	default:
		if evalCtx.Attributes != nil {
			attrValue = evalCtx.Attributes[cond.Attribute]
		}
	}

	return c.evaluateCondition(cond.Operator, attrValue, cond.Value)
}

func (c *Client) evaluateCondition(operator string, attrValue, condValue interface{}) bool {
	switch operator {
	case "equals":
		return equals(attrValue, condValue)
	case "not_equals":
		return !equals(attrValue, condValue)
	case "in_list":
		list, ok := condValue.([]interface{})
		if !ok {
			return false
		}
		for _, v := range list {
			if equals(attrValue, v) {
				return true
			}
		}
		return false
	case "ends_with":
		str, ok1 := attrValue.(string)
		suffix, ok2 := condValue.(string)
		if !ok1 || !ok2 {
			return false
		}
		if len(str) < len(suffix) {
			return false
		}
		return str[len(str)-len(suffix):] == suffix
	default:
		return false
	}
}

func equals(a, b interface{}) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	switch av := a.(type) {
	case float64:
		if bv, ok := b.(float64); ok {
			return av == bv
		}
		if bv, ok := b.(int); ok {
			return av == float64(bv)
		}
	case int:
		if bv, ok := b.(int); ok {
			return av == bv
		}
		if bv, ok := b.(float64); ok {
			return float64(av) == bv
		}
	case string:
		if bv, ok := b.(string); ok {
			return av == bv
		}
	case bool:
		if bv, ok := b.(bool); ok {
			return av == bv
		}
	}
	return false
}

func (c *Client) coerceValue(value interface{}, expectedType string) (interface{}, bool) {
	if value == nil {
		return nil, false
	}

	// Handle json.RawMessage by unmarshaling first
	if raw, ok := value.(json.RawMessage); ok {
		var unmarshaled interface{}
		if err := json.Unmarshal(raw, &unmarshaled); err != nil {
			return nil, false
		}
		return c.coerceValue(unmarshaled, expectedType)
	}

	switch expectedType {
	case TypeBoolean:
		if b, ok := value.(bool); ok {
			return b, true
		}
	case TypeString:
		if s, ok := value.(string); ok {
			return s, true
		}
	case TypeNumber:
		if f, ok := value.(float64); ok {
			return f, true
		}
		if i, ok := value.(int); ok {
			return float64(i), true
		}
	case TypeObject:
		if m, ok := value.(map[string]interface{}); ok {
			return m, true
		}
	}
	return nil, false
}

func (c *Client) computeBucket(flagKey, targetingKey string) int {
	input := flagKey + ":" + targetingKey
	hash := sha256.Sum256([]byte(input))
	bucket := binary.BigEndian.Uint64(hash[:8])
	return int(bucket % 100)
}

// MemoryStore is an in-memory implementation of Store.
type MemoryStore struct {
	mu       sync.RWMutex
	flags    map[string]*Flag
	auditLog []AuditEntry
	auditID  int64
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		flags:    make(map[string]*Flag),
		auditLog: make([]AuditEntry, 0),
		auditID:  1,
	}
}

func (s *MemoryStore) GetFlag(ctx context.Context, key string) (*Flag, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	flag, ok := s.flags[key]
	if !ok {
		return nil, sql.ErrNoRows
	}
	flagCopy := *flag
	return &flagCopy, nil
}

func (s *MemoryStore) SetFlag(ctx context.Context, flag *Flag) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	flagCopy := *flag
	s.flags[flag.Key] = &flagCopy
	return nil
}

func (s *MemoryStore) GetAuditLog(ctx context.Context, flagKey string) ([]AuditEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []AuditEntry
	for _, entry := range s.auditLog {
		if entry.FlagKey == flagKey {
			result = append(result, entry)
		}
	}
	return result, nil
}

func (s *MemoryStore) AddAuditEntry(ctx context.Context, entry AuditEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.ID = s.auditID
	s.auditID++
	s.auditLog = append(s.auditLog, entry)
	return nil
}

func (s *MemoryStore) Close() error {
	return nil
}

// SQLStore is a SQL-backed implementation of Store.
type SQLStore struct {
	db *sql.DB
}

func NewSQLStore(db *sql.DB) *SQLStore {
	return &SQLStore{db: db}
}

const SchemaDDL = `
CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    default_value TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    rules TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flag_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_key TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flag_audit_flag_key ON flag_audit(flag_key);
`

func (s *SQLStore) InitSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, SchemaDDL)
	return err
}

func (s *SQLStore) GetFlag(ctx context.Context, key string) (*Flag, error) {
	query := `SELECT key, type, default_value, enabled, rules, updated_at, updated_by FROM feature_flags WHERE key = ?`
	row := s.db.QueryRowContext(ctx, query, key)

	var flag Flag
	var defaultValue, rules string
	var updatedAt time.Time
	err := row.Scan(&flag.Key, &flag.Type, &defaultValue, &flag.Enabled, &rules, &updatedAt, &flag.UpdatedBy)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, sql.ErrNoRows
		}
		return nil, err
	}
	flag.DefaultValue = json.RawMessage(defaultValue)
	flag.Rules = json.RawMessage(rules)
	flag.UpdatedAt = updatedAt
	return &flag, nil
}

func (s *SQLStore) SetFlag(ctx context.Context, flag *Flag) error {
	query := `
		INSERT INTO feature_flags (key, type, default_value, enabled, rules, updated_at, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET
			type = excluded.type,
			default_value = excluded.default_value,
			enabled = excluded.enabled,
			rules = excluded.rules,
			updated_at = excluded.updated_at,
			updated_by = excluded.updated_by
	`
	_, err := s.db.ExecContext(ctx, query,
		flag.Key, flag.Type, string(flag.DefaultValue), flag.Enabled,
		string(flag.Rules), flag.UpdatedAt, flag.UpdatedBy)
	return err
}

func (s *SQLStore) AddAuditEntry(ctx context.Context, entry AuditEntry) error {
	query := `INSERT INTO flag_audit (flag_key, action, old_value, new_value, actor_id, at) VALUES (?, ?, ?, ?, ?, ?)`
	_, err := s.db.ExecContext(ctx, query,
		entry.FlagKey, entry.Action, string(entry.OldValue), string(entry.NewValue),
		entry.ActorID, entry.At)
	return err
}

func (s *SQLStore) GetAuditLog(ctx context.Context, flagKey string) ([]AuditEntry, error) {
	query := `SELECT id, flag_key, action, old_value, new_value, actor_id, at FROM flag_audit WHERE flag_key = ? ORDER BY at`
	rows, err := s.db.QueryContext(ctx, query, flagKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []AuditEntry
	for rows.Next() {
		var entry AuditEntry
		var oldVal, newVal string
		if err := rows.Scan(&entry.ID, &entry.FlagKey, &entry.Action, &oldVal, &newVal, &entry.ActorID, &entry.At); err != nil {
			return nil, err
		}
		entry.OldValue = json.RawMessage(oldVal)
		entry.NewValue = json.RawMessage(newVal)
		result = append(result, entry)
	}
	return result, nil
}

func (s *SQLStore) Close() error {
	return s.db.Close()
}