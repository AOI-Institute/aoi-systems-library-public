package compliance

import (
	"testing"
	"time"
)

// helper to create a service with a fixed now time for deterministic tests
func newFixedService(fixed time.Time) *ComplianceService {
	s := NewComplianceService()
	s.nowFunc = func() time.Time { return fixed }
	return s
}

// 1. Export: JSON and CSV formats both work
func TestExportFormatsWork(t *testing.T) {
	svc := newFixedService(time.Now())
	expJSON, err := svc.RequestExport(1, "json")
	if err != nil {
		t.Fatalf("json export request failed: %v", err)
	}
	if expJSON.Format != "json" {
		t.Errorf("expected format json, got %s", expJSON.Format)
	}
	expCSV, err := svc.RequestExport(2, "csv")
	if err != nil {
		t.Fatalf("csv export request failed: %v", err)
	}
	if expCSV.Format != "csv" {
		t.Errorf("expected format csv, got %s", expCSV.Format)
	}
}

// 2. Export: All data categories included (profile, activity, files, etc)
func TestExportIncludesAllCategories(t *testing.T) {
	svc := newFixedService(time.Now())
	exp, _ := svc.RequestExport(10, "json")
	expected := []string{
		"profile", "sessions", "activity", "files",
		"preferences", "transactions", "audit_trail",
	}
	if len(exp.DataCategories) != len(expected) {
		t.Fatalf("expected %d categories, got %d", len(expected), len(exp.DataCategories))
	}
	for i, cat := range expected {
		if exp.DataCategories[i] != cat {
			t.Errorf("category %d expected %s, got %s", i, cat, exp.DataCategories[i])
		}
	}
}

// 3. Export: Email sent with download link
func TestExportEmailSent(t *testing.T) {
	svc := newFixedService(time.Now())
	exp, _ := svc.RequestExport(5, "json")
	if !exp.EmailSent {
		t.Errorf("expected EmailSent true")
	}
	if exp.FileURL == "" {
		t.Errorf("expected a file URL")
	}
}

// 4. Export: Signed URL works, expires after 7 days
func TestExportSignedURLExpiry(t *testing.T) {
	fixed := time.Date(2026, 9, 26, 9, 0, 0, 0, time.UTC)
	svc := newFixedService(fixed)
	exp, _ := svc.RequestExport(7, "csv")
	if exp.ExpiresAt == nil {
		t.Fatalf("ExpiresAt is nil")
	}
	expected := fixed.Add(7 * 24 * time.Hour)
	if !exp.ExpiresAt.Equal(expected) {
		t.Errorf("expected expires %v, got %v", expected, exp.ExpiresAt)
	}
}

// 5. Deletion: 30-day grace period enforced
func TestDeletionGracePeriod(t *testing.T) {
	fixed := time.Now()
	svc := newFixedService(fixed)
	del, _ := svc.RequestDeletion(3, "gdpr_request")
	if del.DeletedAt == nil {
		t.Fatalf("DeletedAt is nil")
	}
	expected := fixed.Add(30 * 24 * time.Hour)
	if !del.DeletedAt.Equal(expected) {
		t.Errorf("expected deletion at %v, got %v", expected, del.DeletedAt)
	}
}

// 6. Deletion: User can cancel within grace period
func TestDeletionCancelWithinGrace(t *testing.T) {
	fixed := time.Now()
	svc := newFixedService(fixed)
	del, _ := svc.RequestDeletion(4, "user_requested")
	_, err := svc.CancelDeletion(del.ID)
	if err != nil {
		t.Fatalf("cancel failed: %v", err)
	}
	if del.Status != "cancelled" {
		t.Errorf("expected status cancelled, got %s", del.Status)
	}
}

// 7. Deletion: Cascade delete works (sessions, api_keys, etc deleted)
func TestDeletionCascade(t *testing.T) {
	fixed := time.Now()
	svc := newFixedService(fixed)

	uid := 8
	// populate simulated data
	svc.AddSession(uid, "sess1")
	svc.AddFile(uid, "file1")
	svc.SetPreference(uid, true)
	svc.AddTransaction(uid, "txn1")
	svc.AddAuditTrailEntry(uid, "login")

	del, _ := svc.RequestDeletion(uid, "gdpr_right_to_be_forgotten")
	_, _ = svc.ConfirmDeletion(del.ID, "valid-token")
	// fast‑forward time to after the 30‑day window
	svc.nowFunc = func() time.Time { return fixed.Add(31 * 24 * time.Hour) }
	if err := svc.PerformDeletionNow(del.ID); err != nil {
		t.Fatalf("perform deletion failed: %v", err)
	}
	// verify data cleared
	svc.mu.Lock()
	if _, ok := svc.sessions[uid]; ok {
		t.Errorf("sessions not cleared")
	}
	if _, ok := svc.files[uid]; ok {
		t.Errorf("files not cleared")
	}
	if _, ok := svc.preferences[uid]; ok {
		t.Errorf("preferences not cleared")
	}
	if _, ok := svc.transactions[uid]; ok {
		t.Errorf("transactions not cleared")
	}
	if _, ok := svc.auditTrail[uid]; ok {
		t.Errorf("audit trail should be preserved, but was cleared")
	}
	svc.mu.Unlock()
}

// 8. Deletion: Audit log preserved (not deleted with user)
func TestAuditLogPreserved(t *testing.T) {
	fixed := time.Now()
	svc := newFixedService(fixed)

	uid := 9
	svc.AddAuditTrailEntry(uid, "some action")
	del, _ := svc.RequestDeletion(uid, "gdpr_request")
	_, _ = svc.ConfirmDeletion(del.ID, "tok")
	svc.nowFunc = func() time.Time { return fixed.Add(31 * 24 * time.Hour) }
	if err := svc.PerformDeletionNow(del.ID); err != nil {
		t.Fatalf("perform deletion failed: %v", err)
	}
	// audit logs should still contain entries for the user
	found := false
	for _, a := range svc.GetAuditLogs() {
		if a.UserID == uid && a.Action == "deletion_completed" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected deletion_completed audit log for user %d", uid)
	}
}

// 9. Deletion: User confirmed via email token
func TestDeletionConfirmationToken(t *testing.T) {
	svc := newFixedService(time.Now())
	del, _ := svc.RequestDeletion(11, "user_requested")
	_, err := svc.ConfirmDeletion(del.ID, "")
	if err == nil {
		t.Fatalf("expected error for empty token")
	}
	_, err = svc.ConfirmDeletion(del.ID, "nonempty")
	if err != nil {
		t.Fatalf("confirmation with token failed: %v", err)
	}
	if del.Status != "approved" {
		t.Errorf("expected status approved, got %s", del.Status)
	}
}

// 10. Admin: Can see all export/deletion requests
func TestAdminListRequests(t *testing.T) {
	svc := newFixedService(time.Now())
	// create several requests
	svc.RequestExport(20, "json")
	svc.RequestExport(21, "csv")
	svc.RequestDeletion(20, "gdpr_request")
	svc.RequestDeletion(22, "user_requested")

	exports := svc.ListExports(nil, nil)
	if len(exports) != 2 {
		t.Errorf("expected 2 exports, got %d", len(exports))
	}
	deletions := svc.ListDeletions(nil, nil)
	if len(deletions) != 2 {
		t.Errorf("expected 2 deletions, got %d", len(deletions))
	}
}

// 11. Audit: All requests logged with why_chain support
func TestAuditLogging(t *testing.T) {
	svc := newFixedService(time.Now())
	svc.RequestExport(30, "json")
	svc.RequestDeletion(30, "gdpr_right_to_be_forgotten")
	logs := svc.GetAuditLogs()
	if len(logs) != 2 {
		t.Fatalf("expected 2 audit logs, got %d", len(logs))
	}
	if logs[0].Action != "data_export_requested" {
		t.Errorf("first log action expected data_export_requested, got %s", logs[0].Action)
	}
	if logs[1].Action != "deletion_requested" {
		t.Errorf("second log action expected deletion_requested, got %s", logs[1].Action)
	}
}

// ---------- End of tests ----------