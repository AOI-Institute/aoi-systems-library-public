package webhooks

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"database/sql"
)

// Webhook holds a DB connection and provides the API.
type Webhook struct {
	db *sql.DB
}

// NewWebhook creates a Webhook instance with the given DB.
func NewWebhook(db *sql.DB) *Webhook {
	return &Webhook{db: db}
}

// InitSchema creates the required tables if they do not exist.
func InitSchema(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS webhook_endpoints (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			org_id INTEGER NOT NULL,
			url TEXT NOT NULL,
			secret TEXT NOT NULL,
			event_types TEXT NOT NULL,
			active BOOLEAN NOT NULL DEFAULT 1,
			failure_count INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS webhook_messages (
			id TEXT PRIMARY KEY,
			event_type TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS webhook_deliveries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id TEXT NOT NULL,
			endpoint_id INTEGER NOT NULL,
			attempt INTEGER NOT NULL,
			status_code INTEGER,
			success BOOLEAN,
			error TEXT,
			next_attempt_at TIMESTAMP,
			delivered_at TIMESTAMP,
			FOREIGN KEY (message_id) REFERENCES webhook_messages(id),
			FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id)
		);`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}
	return nil
}

// generateSecret creates a whsec_ prefixed base64-encoded 32‑byte secret.
func generateSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "whsec_" + base64.StdEncoding.EncodeToString(b), nil
}

// generateMessageID creates a msg_ prefixed URL‑safe base64 random ID.
func generateMessageID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(b), nil
}

// Sign returns a v1,base64(hmac-sha256) signature.
func Sign(secret string, msgID string, timestamp int64, body []byte) (string, error) {
	if len(secret) < 7 || !strings.HasPrefix(secret, "whsec_") {
		return "", errors.New("invalid secret format")
	}
	keyB64 := secret[6:]
	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	var buf bytes.Buffer
	buf.WriteString(msgID)
	buf.WriteByte('.')
	buf.WriteString(strconv.FormatInt(timestamp, 10))
	buf.WriteByte('.')
	buf.Write(body)
	if _, err := mac.Write(buf.Bytes()); err != nil {
		return "", err
	}
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return "v1," + sig, nil
}

// Verify checks the signature(s) in the header against the secret.
// Returns true if any signature matches and timestamp is within tolerance.
func Verify(secret string, header http.Header, rawBody []byte, toleranceSeconds int) (bool, error) {
	id := header.Get("webhook-id")
	ts := header.Get("webhook-timestamp")
	sigHeader := header.Get("webhook-signature")
	if id == "" || ts == "" || sigHeader == "" {
		return false, errors.New("missing required headers")
	}
	timestamp, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false, err
	}
	now := time.Now().Unix()
	if now-timestamp > int64(toleranceSeconds) || timestamp-now > int64(toleranceSeconds) {
		return false, errors.New("timestamp outside tolerance")
	}
	keyB64 := secret[6:]
	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return false, err
	}
	var buf bytes.Buffer
	buf.WriteString(id)
	buf.WriteByte('.')
	buf.WriteString(strconv.FormatInt(timestamp, 10))
	buf.WriteByte('.')
	buf.Write(rawBody)
	data := buf.Bytes()
	for _, s := range strings.Fields(sigHeader) {
		if !strings.HasPrefix(s, "v1,") {
			continue
		}
		sigB64 := s[3:]
		sig, err := base64.StdEncoding.DecodeString(sigB64)
		if err != nil {
			continue
		}
		mac := hmac.New(sha256.New, key)
		mac.Write(data)
		expected := mac.Sum(nil)
		if hmac.Equal(sig, expected) {
			return true, nil
		}
	}
	return false, nil
}

// CreateEndpoint registers a new webhook endpoint.
func (w *Webhook) CreateEndpoint(orgID int64, url string, eventTypes []string) (int64, string, error) {
	if !strings.HasPrefix(url, "https://") && url != "http://localhost" {
		return 0, "", errors.New("URL must be https:// or http://localhost for dev")
	}
	secret, err := generateSecret()
	if err != nil {
		return 0, "", err
	}
	eventTypesJSON, err := json.Marshal(eventTypes)
	if err != nil {
		return 0, "", err
	}
	res, err := w.db.Exec(
		`INSERT INTO webhook_endpoints (org_id, url, secret, event_types, active, failure_count) VALUES (?, ?, ?, ?, 1, 0)`,
		orgID, url, secret, string(eventTypesJSON),
	)
	if err != nil {
		return 0, "", err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, "", err
	}
	return id, secret, nil
}

// SendEvent creates a message and a pending delivery for each active endpoint subscribed to eventType.
func (w *Webhook) SendEvent(eventType string, payload interface{}) (string, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	msgID, err := generateMessageID()
	if err != nil {
		return "", err
	}
	res, err := w.db.Exec(
		`INSERT INTO webhook_messages (id, event_type, payload) VALUES (?, ?, ?)`,
		msgID, eventType, string(payloadBytes),
	)
	if err != nil {
		return "", err
	}
	if _, err = res.LastInsertId(); err != nil {
		return "", err
	}
	// Find active endpoints that subscribe to eventType
	rows, err := w.db.Query(`SELECT id, org_id, url, secret, event_types, active, failure_count FROM webhook_endpoints WHERE active = 1`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var endpointIDs []int64
	for rows.Next() {
		var ep struct {
			ID int64
			// OrgID int64
			URL       string
			Secret    string
			EventTypesJSON string
			// Active bool
			// FailureCount int
		}
		if err := rows.Scan(&ep.ID, nil, &ep.URL, &ep.Secret, &ep.EventTypesJSON, nil, nil); err != nil {
			continue
		}
		var et []string
		if err := json.Unmarshal([]byte(ep.EventTypesJSON), &et); err != nil {
			continue
		}
		for _, t := range et {
			if t == eventType {
				endpointIDs = append(endpointIDs, ep.ID)
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	// Insert pending deliveries
	for _, eid := range endpointIDs {
		_, err = w.db.Exec(
			`INSERT INTO webhook_deliveries (message_id, endpoint_id, attempt, status_code, success, error, next_attempt_at, delivered_at) VALUES (?, ?, 1, NULL, NULL, NULL, NULL, NULL)`,
			msgID, eid,
		)
		if err != nil {
			return "", err
		}
	}
	return msgID, nil
}

// RotateSecret replaces the secret for an endpoint.
func (w *Webhook) RotateSecret(endpointID int64) (string, error) {
	secret, err := generateSecret()
	if err != nil {
		return "", err
	}
	_, err = w.db.Exec(`UPDATE webhook_endpoints SET secret = ? WHERE id = ?`, secret, endpointID)
	if err != nil {
		return "", err
	}
	return secret, nil
}

// Deliver attempts a single delivery for the given delivery record.
// Returns true on success, false on failure (with retry scheduled).
func (w *Webhook) Deliver(deliveryID int64) (bool, error) {
	tx, err := w.db.Begin()
	if err != nil {
		return false, err
	}
	var d struct {
		ID          int64
		MessageID   string
		EndpointID  int64
		Attempt     int
	}
	var messageID string
	var endpointID int64
	err = tx.QueryRow(
		`SELECT id, message_id, endpoint_id, attempt FROM webhook_deliveries WHERE id = ?`,
		deliveryID,
	).Scan(&d.ID, &messageID, &endpointID, &d.Attempt)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	var ep struct {
		ID        int64
		URL       string
		Secret    string
		Active    bool
		FailureCount int
	}
	var eventTypesJSON string
	err = tx.QueryRow(
		`SELECT id, url, secret, event_types, active, failure_count FROM webhook_endpoints WHERE id = ?`,
		endpointID,
	).Scan(&ep.ID, &ep.URL, &ep.Secret, &eventTypesJSON, &ep.Active, &ep.FailureCount)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	if !ep.Active {
		tx.Rollback()
		return false, errors.New("endpoint inactive")
	}
	var msg struct {
		ID     string
		Payload []byte
	}
	var payloadJSON string
	err = tx.QueryRow(
		`SELECT id, payload FROM webhook_messages WHERE id = ?`,
		messageID,
	).Scan(&msg.ID, &payloadJSON)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	msg.Payload = []byte(payloadJSON)
	timestamp := time.Now().Unix()
	signature, err := Sign(ep.Secret, msg.ID, timestamp, msg.Payload)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	req, err := http.NewRequest("POST", ep.URL, bytes.NewReader(msg.Payload))
	if err != nil {
		tx.Rollback()
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("webhook-id", msg.ID)
	req.Header.Set("webhook-timestamp", strconv.FormatInt(timestamp, 10))
	req.Header.Set("webhook-signature", signature)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	var statusCode int
	var errMsg string
	if err != nil {
		statusCode = 0
		errMsg = err.Error()
	} else {
		statusCode = resp.StatusCode
		resp.Body.Close()
	}
	success := statusCode >= 200 && statusCode <= 299
	now := time.Now()
	_, err = tx.Exec(
		`UPDATE webhook_deliveries SET status_code = ?, success = ?, error = ?, delivered_at = ? WHERE id = ?`,
		statusCode, success, errMsg, now, deliveryID,
	)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	if success {
		_, err = tx.Exec(`UPDATE webhook_endpoints SET failure_count = 0 WHERE id = ?`, endpointID)
		if err != nil {
			tx.Rollback()
			return false, err
		}
		tx.Commit()
		return true, nil
	}
	newFailureCount := ep.FailureCount + 1
	newActive := ep.Active
	if newFailureCount >= 5 {
		newActive = false
	}
	_, err = tx.Exec(
		`UPDATE webhook_endpoints SET failure_count = ?, active = ? WHERE id = ?`,
		newFailureCount, newActive, endpointID,
	)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	backoff := []time.Duration{
		5 * time.Second,
		5 * time.Minute,
		30 * time.Minute,
		2 * time.Hour,
		5 * time.Hour,
		10 * time.Hour,
		10 * time.Hour,
	}
	var nextAttemptAt time.Time
	idx := d.Attempt // attempt number already made (starting at 1)
	if idx < len(backoff) {
		nextAttemptAt = now.Add(backoff[idx])
	}
	var nextAttemptAtNull sql.NullTime
	if !nextAttemptAt.IsZero() {
		nextAttemptAtNull = sql.NullTime{Time: nextAttemptAt, Valid: true}
	}
	_, err = tx.Exec(
		`UPDATE webhook_deliveries SET next_attempt_at = ?, attempt = ? WHERE id = ?`,
		nextAttemptAtNull, d.Attempt+1, deliveryID,
	)
	if err != nil {
		tx.Rollback()
		return false, err
	}
	tx.Commit()
	return false, nil
}