package idempotencykeys

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

type IdempotencyError struct {
	Code    string
	Status  int
	Message string
}

func (e *IdempotencyError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

type HttpResponse struct {
	Status      int
	ContentType string
	Body        string
}

type OperationResult struct {
	Status int
	Body   string
}

type IdempotencyRecord struct {
	Scope              string
	IdemKey            string
	RequestFingerprint string
	Status             string
	ResponseStatus     *int
	ResponseBody       *string
	CreatedAt          int64
	ExpiresAt          int64
}

type Store interface {
	TryClaim(rec IdempotencyRecord, now int64) (bool, error)
	Get(scope, idemKey string) (*IdempotencyRecord, error)
	Complete(scope, idemKey string, createdAt int64, responseStatus int, responseBody string) error
	Delete(scope, idemKey string, createdAt int64) error
	PurgeExpired(now int64) (int64, error)
}

type IdempotencyOptions struct {
	Clock           func() int64
	TtlSeconds      int64
	RequiredMethods []string
}

type IdempotencyService struct {
	store Store
	opts  IdempotencyOptions
}

func NewIdempotencyService(store Store, opts IdempotencyOptions) (*IdempotencyService, error) {
	if opts.TtlSeconds < 0 {
		return nil, &IdempotencyError{Code: "INVALID_OPTIONS", Status: 500, Message: "ttl_seconds must be >= 0"}
	}
	if opts.Clock == nil {
		opts.Clock = func() int64 { return time.Now().Unix() }
	}
	if opts.TtlSeconds == 0 {
		opts.TtlSeconds = 86400
	}
	if opts.RequiredMethods == nil {
		opts.RequiredMethods = []string{"POST", "PATCH"}
	}
	for i, m := range opts.RequiredMethods {
		opts.RequiredMethods[i] = asciiUpper(m)
	}
	return &IdempotencyService{store: store, opts: opts}, nil
}

func (s *IdempotencyService) Handle(scope, idempotencyKey, method, path, body string, operation func() (OperationResult, error)) (HttpResponse, error) {
	m := asciiUpper(method)
	if !s.IsRequired(m, path) {
		r, err := operation()
		if err != nil {
			return HttpResponse{}, err
		}
		if !checkResult(r) {
			return HttpResponse{}, &IdempotencyError{Code: "INVALID_OPERATION_RESULT", Status: 500, Message: "invalid operation result"}
		}
		return HttpResponse{Status: r.Status, ContentType: "application/json", Body: r.Body}, nil
	}
	if scope == "" {
		return HttpResponse{}, &IdempotencyError{Code: "SCOPE_REQUIRED", Status: 500, Message: "scope is required"}
	}
	if idempotencyKey == "" {
		return problemResponse(400, "IDEMPOTENCY_KEY_MISSING"), nil
	}
	if !validKey(idempotencyKey) {
		return problemResponse(400, "IDEMPOTENCY_KEY_INVALID"), nil
	}
	fp := computeFingerprint(m, path, body)
	now := s.opts.Clock()
	rec := IdempotencyRecord{
		Scope:              scope,
		IdemKey:            idempotencyKey,
		RequestFingerprint: fp,
		Status:             "in_progress",
		CreatedAt:          now,
		ExpiresAt:          now + s.opts.TtlSeconds,
	}
	for i := 0; i < 2; i++ {
		claimed, err := s.store.TryClaim(rec, now)
		if err != nil {
			return HttpResponse{}, err
		}
		if claimed {
			return s.runClaimed(rec, operation)
		}
		ex, err := s.store.Get(scope, idempotencyKey)
		if err != nil {
			return HttpResponse{}, err
		}
		if ex == nil || ex.ExpiresAt <= now {
			continue
		}
		if ex.RequestFingerprint != fp {
			return problemResponse(422, "IDEMPOTENCY_KEY_REUSED"), nil
		}
		if ex.Status == "in_progress" {
			return problemResponse(409, "REQUEST_IN_PROGRESS"), nil
		}
		return HttpResponse{Status: *ex.ResponseStatus, ContentType: "application/json", Body: *ex.ResponseBody}, nil
	}
	return problemResponse(409, "REQUEST_IN_PROGRESS"), nil
}

func (s *IdempotencyService) runClaimed(rec IdempotencyRecord, operation func() (OperationResult, error)) (HttpResponse, error) {
	defer func() {
		if r := recover(); r != nil {
			_ = s.store.Delete(rec.Scope, rec.IdemKey, rec.CreatedAt)
			panic(r)
		}
	}()
	r, err := operation()
	if err != nil {
		_ = s.store.Delete(rec.Scope, rec.IdemKey, rec.CreatedAt)
		return HttpResponse{}, err
	}
	if !checkResult(r) {
		return HttpResponse{}, &IdempotencyError{Code: "INVALID_OPERATION_RESULT", Status: 500, Message: "invalid operation result"}
	}
	err = s.store.Complete(rec.Scope, rec.IdemKey, rec.CreatedAt, r.Status, r.Body)
	if err != nil {
		return HttpResponse{}, err
	}
	return HttpResponse{Status: r.Status, ContentType: "application/json", Body: r.Body}, nil
}

func (s *IdempotencyService) IsRequired(method, path string) bool {
	m := asciiUpper(method)
	for _, rm := range s.opts.RequiredMethods {
		if rm == m {
			return true
		}
	}
	return false
}

func (s *IdempotencyService) PurgeExpired() (int64, error) {
	return s.store.PurgeExpired(s.opts.Clock())
}

func ComputeFingerprint(method, path, body string) string {
	return computeFingerprint(method, path, body)
}

func computeFingerprint(m, p, b string) string {
	data := asciiUpper(m) + " " + p + "\n" + b
	h := sha256.Sum256([]byte(data))
	return hex.EncodeToString(h[:])
}

func asciiUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

func validKey(k string) bool {
	if len(k) < 1 || len(k) > 255 {
		return false
	}
	for _, c := range []byte(k) {
		if c < 0x20 || c > 0x7E {
			return false
		}
	}
	return true
}

func checkResult(r OperationResult) bool {
	if r.Status < 100 || r.Status > 599 {
		return false
	}
	return r.Body != ""
}

func problemResponse(status int, code string) HttpResponse {
	var body string
	switch code {
	case "IDEMPOTENCY_KEY_MISSING":
		body = `{"type":"https://developer.example.com/problems/idempotency-key-missing","title":"Idempotency-Key is missing","detail":"This operation requires an Idempotency-Key request header."}`
	case "IDEMPOTENCY_KEY_INVALID":
		body = `{"type":"https://developer.example.com/problems/idempotency-key-invalid","title":"Idempotency-Key is invalid","detail":"An Idempotency-Key must be 1 to 255 printable ASCII characters."}`
	case "IDEMPOTENCY_KEY_REUSED":
		body = `{"type":"https://developer.example.com/problems/idempotency-key-reused","title":"Idempotency-Key is already used","detail":"This Idempotency-Key was already used with a different request payload."}`
	case "REQUEST_IN_PROGRESS":
		body = `{"type":"https://developer.example.com/problems/idempotency-request-outstanding","title":"A request is outstanding for this Idempotency-Key","detail":"A request with the same Idempotency-Key is still being processed. Retry later."}`
	}
	return HttpResponse{Status: status, ContentType: "application/problem+json", Body: body}
}

type InMemoryStore struct {
	mu   sync.Mutex
	rows map[string]*IdempotencyRecord
}

func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		rows: make(map[string]*IdempotencyRecord),
	}
}

func (s *InMemoryStore) key(scope, idemKey string) string {
	return scope + "\x00" + idemKey
}

func (s *InMemoryStore) TryClaim(rec IdempotencyRecord, now int64) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := s.key(rec.Scope, rec.IdemKey)
	ex, ok := s.rows[k]
	if ok && ex.ExpiresAt > now {
		return false, nil
	}
	s.rows[k] = &rec
	return true, nil
}

func (s *InMemoryStore) Get(scope, idemKey string) (*IdempotencyRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := s.key(scope, idemKey)
	if rec, ok := s.rows[k]; ok {
		return rec, nil
	}
	return nil, nil
}

func (s *InMemoryStore) Complete(scope, idemKey string, createdAt int64, responseStatus int, responseBody string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := s.key(scope, idemKey)
	ex, ok := s.rows[k]
	if !ok || ex.CreatedAt != createdAt || ex.Status != "in_progress" {
		return nil
	}
	ex.Status = "completed"
	ex.ResponseStatus = &responseStatus
	ex.ResponseBody = &responseBody
	return nil
}

func (s *InMemoryStore) Delete(scope, idemKey string, createdAt int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	k := s.key(scope, idemKey)
	ex, ok := s.rows[k]
	if !ok || ex.CreatedAt != createdAt || ex.Status != "in_progress" {
		return nil
	}
	delete(s.rows, k)
	return nil
}

func (s *InMemoryStore) PurgeExpired(now int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int64
	for k, rec := range s.rows {
		if rec.ExpiresAt <= now {
			delete(s.rows, k)
			count++
		}
	}
	return count, nil
}

type SqlStore struct {
	db *sql.DB
}

func NewSqlStore(db *sql.DB) *SqlStore {
	return &SqlStore{db: db}
}

func (s *SqlStore) Migrate() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS idempotency_records (scope TEXT NOT NULL, idem_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')), response_status INTEGER NULL, response_body TEXT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, PRIMARY KEY (scope, idem_key))`)
	if err != nil {
		return &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	_, err = s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records (expires_at)`)
	if err != nil {
		return &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	return nil
}

func (s *SqlStore) TryClaim(rec IdempotencyRecord, now int64) (bool, error) {
	res, err := s.db.Exec(`INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?) ON CONFLICT (scope, idem_key) DO UPDATE SET request_fingerprint = excluded.request_fingerprint, status = 'in_progress', response_status = NULL, response_body = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at WHERE idempotency_records.expires_at <= ?`,
		rec.Scope, rec.IdemKey, rec.RequestFingerprint, rec.CreatedAt, rec.ExpiresAt, now)
	if err != nil {
		return false, &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return false, &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	return affected == 1, nil
}

func (s *SqlStore) Get(scope, idemKey string) (*IdempotencyRecord, error) {
	row := s.db.QueryRow(`SELECT scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at FROM idempotency_records WHERE scope = ? AND idem_key = ?`, scope, idemKey)
	var rec IdempotencyRecord
	var responseStatus sql.NullInt64
	var responseBody sql.NullString
	err := row.Scan(&rec.Scope, &rec.IdemKey, &rec.RequestFingerprint, &rec.Status, &responseStatus, &responseBody, &rec.CreatedAt, &rec.ExpiresAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	if responseStatus.Valid {
		rs := int(responseStatus.Int64)
		rec.ResponseStatus = &rs
	}
	if responseBody.Valid {
		rb := responseBody.String
		rec.ResponseBody = &rb
	}
	return &rec, nil
}

func (s *SqlStore) Complete(scope, idemKey string, createdAt int64, responseStatus int, responseBody string) error {
	_, err := s.db.Exec(`UPDATE idempotency_records SET status = 'completed', response_status = ?, response_body = ? WHERE scope = ? AND idem_key = ? AND created_at = ? AND status = 'in_progress'`,
		responseStatus, responseBody, scope, idemKey, createdAt)
	if err != nil {
		return &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	return nil
}

func (s *SqlStore) Delete(scope, idemKey string, createdAt int64) error {
	_, err := s.db.Exec(`DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ? AND created_at = ? AND status = 'in_progress'`,
		scope, idemKey, createdAt)
	if err != nil {
		return &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	return nil
}

func (s *SqlStore) PurgeExpired(now int64) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM idempotency_records WHERE expires_at <= ?`, now)
	if err != nil {
		return 0, &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, &IdempotencyError{Code: "STORE_ERROR", Status: 500, Message: err.Error()}
	}
	return affected, nil
}