package compliance

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

// ---------- Types ----------

// ExportRequest represents a request to export a user's data.
type ExportRequest struct {
	ID            string
	UserID        int
	RequestedAt   time.Time
	Status        string // "pending", "completed", "failed"
	Format        string // "json" or "csv"
	FileURL       string
	CompletedAt   *time.Time
	ExpiresAt     *time.Time
	DataCategories []string // categories that would be included
	EmailSent     bool
}

// DeletionRequest represents a request to delete a user's account.
type DeletionRequest struct {
	ID          string
	UserID      int
	RequestedAt time.Time
	Status      string // "pending", "approved", "completed", "cancelled"
	Reason      string
	DeletedAt   *time.Time // when the cascade delete will actually happen
}

// AuditLog records an action performed in the system.
type AuditLog struct {
	Action    string
	UserID    int
	Timestamp time.Time
	Details   string
}

// ---------- Service ----------

// ComplianceService provides methods to handle export and deletion requests.
type ComplianceService struct {
	mu               sync.Mutex
	exports          map[string]*ExportRequest
	deletions        map[string]*DeletionRequest
	auditLogs        []AuditLog
	nowFunc          func() time.Time
	// Simulated user data stores (to be cleared on cascade delete)
	sessions         map[int][]string
	files            map[int][]string
	preferences      map[int]bool
	transactions     map[int][]string
	auditTrail       map[int][]string
}

// NewComplianceService creates a new ComplianceService with empty stores.
func NewComplianceService() *ComplianceService {
	return &ComplianceService{
		exports:      make(map[string]*ExportRequest),
		deletions:    make(map[string]*DeletionRequest),
		nowFunc:      time.Now,
		sessions:     make(map[int][]string),
		files:        make(map[int][]string),
		preferences:  make(map[int]bool),
		transactions: make(map[int][]string),
		auditTrail:   make(map[int][]string),
	}
}

// ---------- Helper functions ----------

func (s *ComplianceService) now() time.Time {
	if s.nowFunc != nil {
		return s.nowFunc()
	}
	return time.Now()
}

func generateID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---------- Public API ----------

// RequestExport creates a new export request for the given user and format.
// It immediately simulates the background job, marks the request as completed,
// generates a signed URL (dummy), and logs the action.
func (s *ComplianceService) RequestExport(userID int, format string) (*ExportRequest, error) {
	if format != "json" && format != "csv" {
		return nil, errors.New("unsupported format")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	id := generateID()
	now := s.now()
	exp := now.Add(7 * 24 * time.Hour)

	req := &ExportRequest{
		ID:            id,
		UserID:        userID,
		RequestedAt:   now,
		Status:        "pending",
		Format:        format,
		ExpiresAt:     &exp,
		DataCategories: []string{
			"profile", "sessions", "activity", "files",
			"preferences", "transactions", "audit_trail",
		},
	}
	// Simulate async job completing instantly.
	fileURL := fmt.Sprintf("https://s3.example.com/exports/%s?expires=%d", id, exp.Unix())
	req.FileURL = fileURL
	req.Status = "completed"
	completed := now
	req.CompletedAt = &completed
	req.EmailSent = true // simulate email sent

	s.exports[id] = req
	s.auditLogs = append(s.auditLogs, AuditLog{
		Action:    "data_export_requested",
		UserID:    userID,
		Timestamp: now,
		Details:   fmt.Sprintf("format=%s", format),
	})
	return req, nil
}

// GetExportStatus returns the ExportRequest identified by exportID.
func (s *ComplianceService) GetExportStatus(exportID string) (*ExportRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req, ok := s.exports[exportID]; ok {
		return req, nil
	}
	return nil, errors.New("export request not found")
}

// RequestDeletion creates a new deletion request for the given user and reason.
// The actual deletion is scheduled 30 days later.
func (s *ComplianceService) RequestDeletion(userID int, reason string) (*DeletionRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := generateID()
	now := s.now()
	delAt := now.Add(30 * 24 * time.Hour)

	req := &DeletionRequest{
		ID:          id,
		UserID:      userID,
		RequestedAt: now,
		Status:      "pending",
		Reason:      reason,
		DeletedAt:   &delAt,
	}
	s.deletions[id] = req
	s.auditLogs = append(s.auditLogs, AuditLog{
		Action:    "deletion_requested",
		UserID:    userID,
		Timestamp: now,
		Details:   fmt.Sprintf("reason=%s", reason),
	})
	return req, nil
}

// ConfirmDeletion simulates the user clicking the confirmation link in the email.
// Any non‑empty token is accepted.
func (s *ComplianceService) ConfirmDeletion(deletionID string, token string) (*DeletionRequest, error) {
	if token == "" {
		return nil, errors.New("invalid token")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.deletions[deletionID]
	if !ok {
		return nil, errors.New("deletion request not found")
	}
	if req.Status != "pending" {
		return nil, errors.New("deletion request not pending")
	}
	req.Status = "approved"
	s.auditLogs = append(s.auditLogs, AuditLog{
		Action:    "deletion_confirmed",
		UserID:    req.UserID,
		Timestamp: s.now(),
		Details:   fmt.Sprintf("token=%s", token),
	})
	return req, nil
}

// CancelDeletion cancels a pending deletion request within the grace period.
func (s *ComplianceService) CancelDeletion(deletionID string) (*DeletionRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.deletions[deletionID]
	if !ok {
		return nil, errors.New("deletion request not found")
	}
	if req.Status != "pending" && req.Status != "approved" {
		return nil, errors.New("cannot cancel non‑pending request")
	}
	if s.now().After(*req.DeletedAt) {
		return nil, errors.New("grace period elapsed")
	}
	req.Status = "cancelled"
	s.auditLogs = append(s.auditLogs, AuditLog{
		Action:    "deletion_cancelled",
		UserID:    req.UserID,
		Timestamp: s.now(),
		Details:   "",
	})
	return req, nil
}

// PerformDeletionNow forces the cascade delete for a deletion request whose
// DeletedAt time has passed and whose status is approved. This is a helper for tests.
func (s *ComplianceService) PerformDeletionNow(deletionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.deletions[deletionID]
	if !ok {
		return errors.New("deletion request not found")
	}
	if req.Status != "approved" {
		return errors.New("deletion not approved")
	}
	if s.now().Before(*req.DeletedAt) {
		return errors.New("deletion time not reached")
	}
	uid := req.UserID
	// Cascade delete user data (but keep audit logs)
	delete(s.sessions, uid)
	delete(s.files, uid)
	delete(s.preferences, uid)
	delete(s.transactions, uid)
	delete(s.auditTrail, uid)

	req.Status = "completed"
	s.auditLogs = append(s.auditLogs, AuditLog{
		Action:    "deletion_completed",
		UserID:    uid,
		Timestamp: s.now(),
		Details:   "",
	})
	return nil
}

// ListExports returns export requests optionally filtered by userID and/or status.
func (s *ComplianceService) ListExports(userID *int, status *string) []*ExportRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*ExportRequest
	for _, r := range s.exports {
		if userID != nil && r.UserID != *userID {
			continue
		}
		if status != nil && r.Status != *status {
			continue
		}
		out = append(out, r)
	}
	return out
}

// ListDeletions returns deletion requests optionally filtered by userID and/or status.
func (s *ComplianceService) ListDeletions(userID *int, status *string) []*DeletionRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*DeletionRequest
	for _, r := range s.deletions {
		if userID != nil && r.UserID != *userID {
			continue
		}
		if status != nil && r.Status != *status {
			continue
		}
		out = append(out, r)
	}
	return out
}

// GetAuditLogs returns a copy of all audit logs.
func (s *ComplianceService) GetAuditLogs() []AuditLog {
	s.mu.Lock()
	defer s.mu.Unlock()
	cpy := make([]AuditLog, len(s.auditLogs))
	copy(cpy, s.auditLogs)
	return cpy
}

// ---------- Simulated user data helpers (used by tests) ----------

// AddSession records a session for a user.
func (s *ComplianceService) AddSession(userID int, sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[userID] = append(s.sessions[userID], sessionID)
}

// AddFile records a file for a user.
func (s *ComplianceService) AddFile(userID int, fileName string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[userID] = append(s.files[userID], fileName)
}

// SetPreference sets a boolean preference for a user.
func (s *ComplianceService) SetPreference(userID int, value bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.preferences[userID] = value
}

// AddTransaction records a transaction for a user.
func (s *ComplianceService) AddTransaction(userID int, txnID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.transactions[userID] = append(s.transactions[userID], txnID)
}

// AddAuditTrailEntry records an audit trail entry for a user.
func (s *ComplianceService) AddAuditTrailEntry(userID int, entry string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.auditTrail[userID] = append(s.auditTrail[userID], entry)
}

// ---------- End of file ----------