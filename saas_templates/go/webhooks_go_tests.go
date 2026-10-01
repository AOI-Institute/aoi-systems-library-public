package webhooks

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func TestWebhook_SignVerifyRoundtrip(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	// create endpoint to get a valid secret
	_, secret, err := w.CreateEndpoint(1, "https://example.com", []string{"test"})
	if err != nil {
		t.Fatal(err)
	}
	msgID := "msg_123"
	timestamp := int64(1700000000)
	body := []byte(`{"foo":1}`)
	sig, err := Sign(secret, msgID, timestamp, body)
	if err != nil {
		t.Fatal(err)
	}
	header := http.Header{}
	header.Set("webhook-id", msgID)
	header.Set("webhook-timestamp", strconv.FormatInt(timestamp, 10))
	header.Set("webhook-signature", sig)
	ok, err := Verify(secret, header, body, 300)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected verify to succeed")
	}
}

func TestWebhook_VerifyFailsOnChangedBody(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	_, secret, err := w.CreateEndpoint(1, "https://example.com", []string{"test"})
	if err != nil {
		t.Fatal(err)
	}
	msgID := "msg_456"
	timestamp := int64(1700000000)
	body := []byte(`{"foo":1}`)
	sig, _ := Sign(secret, msgID, timestamp, body)
	// tamper body
	tampered := []byte(`{"foo":2}`)
	header := http.Header{}
	header.Set("webhook-id", msgID)
	header.Set("webhook-timestamp", strconv.FormatInt(timestamp, 10))
	header.Set("webhook-signature", sig)
	ok, err := Verify(secret, header, tampered, 300)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("expected verify to fail on changed body")
	}
}

func TestWebhook_VerifyFailsOnChangedTimestamp(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	_, secret, err := w.CreateEndpoint(1, "https://example.com", []string{"test"})
	if err != nil {
		t.Fatal(err)
	}
	msgID := "msg_789"
	timestamp := int64(1700000000)
	body := []byte(`{"foo":1}`)
	sig, _ := Sign(secret, msgID, timestamp, body)
	header := http.Header{}
	header.Set("webhook-id", msgID)
	header.Set("webhook-timestamp", strconv.FormatInt(timestamp+1, 10)) // changed
	header.Set("webhook-signature", sig)
	ok, err := Verify(secret, header, body, 300)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("expected verify to fail on changed timestamp")
	}
}

func TestWebhook_VerifyRejectsOldTimestamp(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	_, secret, err := w.CreateEndpoint(1, "https://example.com", []string{"test"})
	if err != nil {
		t.Fatal(err)
	}
	msgID := "msg_old"
	now := time.Now().Unix()
	old := now - 400 // older than tolerance 300
	body := []byte(`{}`)
	sig, _ := Sign(secret, msgID, old, body)
	header := http.Header{}
	header.Set("webhook-id", msgID)
	header.Set("webhook-timestamp", strconv.FormatInt(old, 10))
	header.Set("webhook-signature", sig)
	ok, err := Verify(secret, header, body, 300)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("expected verify to reject old timestamp")
	}
}

func TestWebhook_VerifyAcceptsOneOfMultipleSignatures(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	_, secret1, err := w.CreateEndpoint(1, "https://example.com", []string{"test"})
	if err != nil {
		t.Fatal(err)
	}
	_, secret2, err := w.CreateEndpoint(2, "https://example.com", []string{"test"})
	if err != nil {
		t.Fatal(err)
	}
	msgID := "msg_multi"
	timestamp := int64(1700000000)
	body := []byte(`{}`)
	sig1, _ := Sign(secret1, msgID, timestamp, body)
	sig2, _ := Sign(secret2, msgID, timestamp, body)
	header := http.Header{}
	header.Set("webhook-id", msgID)
	header.Set("webhook-timestamp", strconv.FormatInt(timestamp, 10))
	header.Set("webhook-signature", sig1+" "+sig2) // space-separated
	// verify with secret1 should succeed
	ok, err := Verify(secret1, header, body, 300)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected verify to succeed with first signature")
	}
	// verify with secret2 should also succeed
	ok, err = Verify(secret2, header, body, 300)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected verify to succeed with second signature")
	}
}

func TestWebhook_DeliverSuccessAndRetry(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	// endpoint that will return 200
	ts := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()
	// endpoint that will return 500
	tf := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.WriteHeader(http.StatusInternalServerError)
	}))
	defer tf.Close()
	// success case
	epID, _, err := w.CreateEndpoint(1, ts.URL, []string{"ev1"})
	if err != nil {
		t.Fatal(err)
	}
	msgID, err := w.SendEvent("ev1", map[string]string{"hello": "world"})
	if err != nil {
		t.Fatal(err)
	}
	// get delivery ID
	var deliveryID int64
	err = db.QueryRow(`SELECT id FROM webhook_deliveries WHERE message_id = ? AND endpoint_id = ?`, msgID, epID).Scan(&deliveryID)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := w.Deliver(deliveryID)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("expected delivery to succeed")
	}
	// check that failure_count reset and no next attempt
	var failureCount int64
	var nextAttempt sql.NullTime
	err = db.QueryRow(`SELECT failure_count, next_attempt_at FROM webhook_endpoints WHERE id = ?`, epID).Scan(&failureCount, &nextAttempt)
	if err != nil {
		t.Fatal(err)
	}
	if failureCount != 0 {
		t.Error("expected failure_count to be 0 after success")
	}
	if nextAttempt.Valid {
		t.Error("expected no next attempt after success")
	}
	// failure case
	epID2, _, err := w.CreateEndpoint(2, tf.URL, []string{"ev1"})
	if err != nil {
		t.Fatal(err)
	}
	msgID2, err := w.SendEvent("ev1", map[string]string{"hello": "world"})
	if err != nil {
		t.Fatal(err)
	}
	var deliveryID2 int64
	err = db.QueryRow(`SELECT id FROM webhook_deliveries WHERE message_id = ? AND endpoint_id = ?`, msgID2, epID2).Scan(&deliveryID2)
	if err != nil {
		t.Fatal(err)
	}
	ok, err = w.Deliver(deliveryID2)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("expected delivery to fail")
	}
	// check failure count incremented and next attempt set
	var fc int64
	var na sql.NullTime
	err = db.QueryRow(`SELECT failure_count, next_attempt_at FROM webhook_endpoints WHERE id = ?`, epID2).Scan(&fc, &na)
	if err != nil {
		t.Fatal(err)
	}
	if fc != 1 {
		t.Error("expected failure_count to be 1 after first failure")
	}
	if !na.Valid {
		t.Error("expected next attempt to be scheduled")
	}
	// ensure webhook-id same across retries (we'll test via mock server capturing header)
}

func TestWebhook_DeliverWebhookIDConsistent(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	// mock server to capture header
	var capturedID string
	var mu bytes.Buffer
	ts := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		capturedID = r.Header.Get("webhook-id")
		// first call fail, second succeed
		if len(capturedID) == 0 {
			rw.WriteHeader(http.StatusInternalServerError)
		} else {
			rw.WriteHeader(http.StatusOK)
		}
	}))
	defer ts.Close()
	epID, _, err := w.CreateEndpoint(1, ts.URL, []string{"ev2"})
	if err != nil {
		t.Fatal(err)
	}
	msgID, err := w.SendEvent("ev2", map[string]int{"n": 5})
	if err != nil {
		t.Fatal(err)
	}
	var deliveryID int64
	err = db.QueryRow(`SELECT id FROM webhook_deliveries WHERE message_id = ? AND endpoint_id = ?`, msgID, epID).Scan(&deliveryID)
	if err != nil {
		t.Fatal(err)
	}
	// first attempt (should fail)
	_, err = w.Deliver(deliveryID)
	if err != nil {
		t.Fatal(err)
	}
	firstID := capturedID
	// reset capturedID for second call
	capturedID = ""
	// second attempt (should succeed)
	_, err = w.Deliver(deliveryID)
	if err != nil {
		t.Fatal(err)
	}
	secondID := capturedID
	if firstID == "" || secondID == "" {
		t.Error("failed to capture webhook-id")
	}
	if firstID != secondID {
		t.Error("webhook-id differed between retries")
	}
	if firstID != msgID {
		t.Error("webhook-id does not match message id")
	}
}

func TestWebhook_SecretGeneration(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	_, secret, err := w.CreateEndpoint(999, "https://example.com", []string{"any"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(secret, "whsec_") {
		t.Error("secret does not start with whsec_")
	}
	b64 := secret[6:]
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Error("secret base64 decode failed")
	}
	if len(decoded) < 24 || len(decoded) > 64 {
		t.Error("secret decoded length out of range 24-64")
	}
}

func TestWebhook_RotateSecret(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := InitSchema(db); err != nil {
		t.Fatal(err)
	}
	w := NewWebhook(db)
	epID, oldSecret, err := w.CreateEndpoint(1, "https://example.com", []string{"evx"})
	if err != nil {
		t.Fatal(err)
	}
	newSecret, err := w.RotateSecret(epID)
	if err != nil {
		t.Fatal(err)
	}
	if newSecret == oldSecret {
		t.Error("rotate_secret did not change secret")
	}
	var cur string
	err = db.QueryRow(`SELECT secret FROM webhook_endpoints WHERE id = ?`, epID).Scan(&cur)
	if err != nil {
		t.Fatal(err)
	}
	if cur != newSecret {
		t.Error("secret not persisted after rotation")
	}
}