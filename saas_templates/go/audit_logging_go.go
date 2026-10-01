package auditlogging

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrLogNotFound      = errors.New("audit log not found")
	ErrImmutableLog     = errors.New("audit log is immutable; updates not allowed")
	ErrInvalidActorType = errors.New("actor_type must be 'user', 'service', or 'api_key'")
)

type AuditLogger struct {
	db *sql.DB
}

type LogMutationRequest struct {
	ActorID      *string          `json:"actor_id"`
	ActorType    string           `json:"actor_type"`
	Action       string           `json:"action"`
	ResourceType string           `json:"resource_type"`
	ResourceID   string           `json:"resource_id"`
	OldValue     json.RawMessage  `json:"old_value"`
	NewValue     json.RawMessage  `json:"new_value"`
	WhyChainID   *string          `json:"why_chain_id,omitempty"`
	Metadata     json.RawMessage  `json:"metadata,omitempty"`
}

type LogEntry struct {
	ID           string          `json:"id"`
	Timestamp    string          `json:"timestamp"`
	ActorID      *string         `json:"actor_id"`
	ActorType    string          `json:"actor_type"`
	Action       string          `json:"action"`
	ResourceType string          `json:"resource_type"`
	ResourceID   string          `json:"resource_id"`
	OldValue     json.RawMessage `json:"old_value"`
	NewValue     json.RawMessage `json:"new_value"`
	WhyChainID   *string         `json:"why_chain_id,omitempty"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
}

type QueryLogsRequest struct {
	ActorID      *string
	Action       *string
	ResourceType *string
	ResourceID   *string
	DateFrom     *time.Time
	DateTo       *time.Time
	Limit        int
	Offset       int
}

type QueryLogsResponse struct {
	Logs     []LogEntry `json:"logs"`
	Total    int        `json:"total"`
	HasMore  bool       `json:"has_more"`
}

type ReplayResponse struct {
	LogID               string          `json:"log_id"`
	Timestamp           string          `json:"timestamp"`
	ResourceStateAtTime json.RawMessage `json:"resource_state_at_time"`
	HasDiverged         bool            `json:"has_diverged"`
}

type SearchRequest struct {
	Query        string
	ResourceType *string
	Limit        int
}

type SearchResponse struct {
	Results []LogEntry `json:"results"`
}

func NewAuditLogger(dbPath string) (*AuditLogger, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	if err := initSchema(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}

	return &AuditLogger{db: db}, nil
}

func initSchema(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS audit_log (
		id TEXT PRIMARY KEY,
		timestamp TEXT NOT NULL,
		actor_id TEXT,
		actor_type TEXT NOT NULL,
		action TEXT NOT NULL,
		resource_type TEXT NOT NULL,
		resource_id TEXT NOT NULL,
		old_value TEXT,
		new_value TEXT,
		why_chain_id TEXT,
		metadata TEXT
	);

	CREATE INDEX IF NOT EXISTS idx_audit_log_actor_action_resource_time 
	ON audit_log(actor_id, action, resource_type, timestamp);
	CREATE INDEX IF NOT EXISTS idx_audit_log_resource_time 
	ON audit_log(resource_type, resource_id, timestamp);
	CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp 
	ON audit_log(timestamp);
	CREATE INDEX IF NOT EXISTS idx_audit_log_action 
	ON audit_log(action);
	`
	_, err := db.Exec(schema)
	return err
}

func (a *AuditLogger) Close() error {
	return a.db.Close()
}

func (a *AuditLogger) LogMutation(ctx context.Context, req LogMutationRequest) (string, error) {
	if req.ActorType != "user" && req.ActorType != "service" && req.ActorType != "api_key" {
		return "", ErrInvalidActorType
	}

	id := generateID()
	timestamp := time.Now().UTC().Format(time.RFC3339Nano)

	oldVal := req.OldValue
	if oldVal == nil {
		oldVal = json.RawMessage("null")
	}
	newVal := req.NewValue
	if newVal == nil {
		newVal = json.RawMessage("null")
	}
	meta := req.Metadata
	if meta == nil {
		meta = json.RawMessage("null")
	}

	query := `
	INSERT INTO audit_log (id, timestamp, actor_id, actor_type, action, resource_type, resource_id, old_value, new_value, why_chain_id, metadata)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	_, err := a.db.ExecContext(ctx, query,
		id, timestamp, req.ActorID, req.ActorType, req.Action,
		req.ResourceType, req.ResourceID, oldVal, newVal, req.WhyChainID, meta,
	)
	if err != nil {
		return "", fmt.Errorf("insert log: %w", err)
	}

	return id, nil
}

func (a *AuditLogger) QueryLogs(ctx context.Context, req QueryLogsRequest) (QueryLogsResponse, error) {
	whereClauses := []string{}
	args := []any{}

	if req.ActorID != nil {
		whereClauses = append(whereClauses, "actor_id = ?")
		args = append(args, *req.ActorID)
	}
	if req.Action != nil {
		actionPattern := strings.ReplaceAll(*req.Action, "*", "%")
		whereClauses = append(whereClauses, "action LIKE ?")
		args = append(args, actionPattern)
	}
	if req.ResourceType != nil {
		whereClauses = append(whereClauses, "resource_type = ?")
		args = append(args, *req.ResourceType)
	}
	if req.ResourceID != nil {
		whereClauses = append(whereClauses, "resource_id = ?")
		args = append(args, *req.ResourceID)
	}
	if req.DateFrom != nil {
		whereClauses = append(whereClauses, "timestamp >= ?")
		args = append(args, req.DateFrom.UTC().Format(time.RFC3339Nano))
	}
	if req.DateTo != nil {
		whereClauses = append(whereClauses, "timestamp <= ?")
		args = append(args, req.DateTo.UTC().Format(time.RFC3339Nano))
	}

	whereSQL := ""
	if len(whereClauses) > 0 {
		whereSQL = "WHERE " + strings.Join(whereClauses, " AND ")
	}

	countQuery := "SELECT COUNT(*) FROM audit_log " + whereSQL
	var total int
	err := a.db.QueryRowContext(ctx, countQuery, args...).Scan(&total)
	if err != nil {
		return QueryLogsResponse{}, fmt.Errorf("count logs: %w", err)
	}

	limit := req.Limit
	if limit <= 0 {
		limit = 100
	}
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}

	selectQuery := fmt.Sprintf(`
		SELECT id, timestamp, actor_id, actor_type, action, resource_type, resource_id, old_value, new_value, why_chain_id, metadata
		FROM audit_log
		%s
		ORDER BY timestamp DESC
		LIMIT ? OFFSET ?
	`, whereSQL)

	args = append(args, limit, offset)
	rows, err := a.db.QueryContext(ctx, selectQuery, args...)
	if err != nil {
		return QueryLogsResponse{}, fmt.Errorf("query logs: %w", err)
	}
	defer rows.Close()

	logs := make([]LogEntry, 0, limit)
	for rows.Next() {
		var entry LogEntry
		var actorID, whyChainID sql.NullString
		var oldVal, newVal, meta []byte
		err := rows.Scan(
			&entry.ID, &entry.Timestamp, &actorID, &entry.ActorType,
			&entry.Action, &entry.ResourceType, &entry.ResourceID,
			&oldVal, &newVal, &whyChainID, &meta,
		)
		if err != nil {
			return QueryLogsResponse{}, fmt.Errorf("scan log: %w", err)
		}
		if actorID.Valid {
			entry.ActorID = &actorID.String
		}
		if whyChainID.Valid {
			entry.WhyChainID = &whyChainID.String
		}
		entry.OldValue = oldVal
		entry.NewValue = newVal
		entry.Metadata = meta
		logs = append(logs, entry)
	}

	hasMore := (offset + len(logs)) < total
	return QueryLogsResponse{Logs: logs, Total: total, HasMore: hasMore}, nil
}

func (a *AuditLogger) Replay(ctx context.Context, logID string) (ReplayResponse, error) {
	query := `
		SELECT id, timestamp, old_value, new_value, resource_type, resource_id
		FROM audit_log
		WHERE id = ?
	`
	var entry struct {
		ID           string
		Timestamp    string
		OldValue     []byte
		NewValue     []byte
		ResourceType string
		ResourceID   string
	}
	err := a.db.QueryRowContext(ctx, query, logID).Scan(
		&entry.ID, &entry.Timestamp, &entry.OldValue, &entry.NewValue,
		&entry.ResourceType, &entry.ResourceID,
	)
	if err == sql.ErrNoRows {
		return ReplayResponse{}, ErrLogNotFound
	}
	if err != nil {
		return ReplayResponse{}, fmt.Errorf("query log: %w", err)
	}

	divergedQuery := `
		SELECT COUNT(*) FROM audit_log
		WHERE resource_type = ? AND resource_id = ? AND timestamp > ?
	`
	var laterCount int
	err = a.db.QueryRowContext(ctx, divergedQuery, entry.ResourceType, entry.ResourceID, entry.Timestamp).Scan(&laterCount)
	if err != nil {
		return ReplayResponse{}, fmt.Errorf("check divergence: %w", err)
	}

	return ReplayResponse{
		LogID:               entry.ID,
		Timestamp:           entry.Timestamp,
		ResourceStateAtTime: entry.NewValue,
		HasDiverged:         laterCount > 0,
	}, nil
}

func (a *AuditLogger) Search(ctx context.Context, req SearchRequest) (SearchResponse, error) {
	if req.Query == "" {
		return SearchResponse{Results: []LogEntry{}}, nil
	}

	searchPattern := "%" + strings.ReplaceAll(req.Query, "*", "%") + "%"
	whereClauses := []string{
		"(action LIKE ? OR resource_type LIKE ? OR resource_id LIKE ? OR old_value LIKE ? OR new_value LIKE ?)",
	}
	args := []any{searchPattern, searchPattern, searchPattern, searchPattern, searchPattern}

	if req.ResourceType != nil {
		whereClauses = append(whereClauses, "resource_type = ?")
		args = append(args, *req.ResourceType)
	}

	whereSQL := "WHERE " + strings.Join(whereClauses, " AND ")

	limit := req.Limit
	if limit <= 0 {
		limit = 50
	}

	query := fmt.Sprintf(`
		SELECT id, timestamp, actor_id, actor_type, action, resource_type, resource_id, old_value, new_value, why_chain_id, metadata
		FROM audit_log
		%s
		ORDER BY timestamp DESC
		LIMIT ?
	`, whereSQL)

	args = append(args, limit)
	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return SearchResponse{}, fmt.Errorf("search logs: %w", err)
	}
	defer rows.Close()

	results := make([]LogEntry, 0, limit)
	for rows.Next() {
		var entry LogEntry
		var actorID, whyChainID sql.NullString
		var oldVal, newVal, meta []byte
		err := rows.Scan(
			&entry.ID, &entry.Timestamp, &actorID, &entry.ActorType,
			&entry.Action, &entry.ResourceType, &entry.ResourceID,
			&oldVal, &newVal, &whyChainID, &meta,
		)
		if err != nil {
			return SearchResponse{}, fmt.Errorf("scan log: %w", err)
		}
		if actorID.Valid {
			entry.ActorID = &actorID.String
		}
		if whyChainID.Valid {
			entry.WhyChainID = &whyChainID.String
		}
		entry.OldValue = oldVal
		entry.NewValue = newVal
		entry.Metadata = meta
		results = append(results, entry)
	}

	return SearchResponse{Results: results}, nil
}

func generateID() string {
	bytes := make([]byte, 16)
	_, _ = rand.Read(bytes)
	return "log_" + hex.EncodeToString(bytes)
}