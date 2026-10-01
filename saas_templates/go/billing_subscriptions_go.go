package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/invoice"
	"github.com/stripe/stripe-go/v76/subscription"
)

// PriceID maps a tier to its Stripe price ID.
var PriceID = map[string]string{
	"solo":       "price_1UIsolo",
	"team":       "price_1UIteam",
	"enterprise": "price_1UIent",
}

// BillingService handles subscriptions, invoices, refunds, and webhooks.
type BillingService struct {
	db     *sql.DB
	client *stripe.Client
}

// NewBillingService constructs a service from an env-configured Stripe key.
func NewBillingService(db *sql.DB) (*BillingService, error) {
	key := os.Getenv("STRIPE_SECRET_KEY")
	if key == "" {
		return nil, fmt.Errorf("STRIPE_SECRET_KEY not set")
	}
	stripe.Key = key
	return &BillingService{db: db, client: stripe.GetClient()}, nil
}

// NewBillingServiceWithClient injects a client (for tests).
func NewBillingServiceWithClient(db *sql.DB, client *stripe.Client) *BillingService {
	return &BillingService{db: db, client: client}
}

// Schema is the executable DDL for all billing tables.
const Schema = `
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  customer_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_invoice_id TEXT UNIQUE NOT NULL,
  customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  executed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  customer_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
`

// Migrate applies the schema.
func (s *BillingService) Migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, Schema)
	return err
}

func nowUTC() string { return time.Now().UTC().Format(time.RFC3339) }

func (s *BillingService) audit(ctx context.Context, action, customerID, detail string) {
	_, _ = s.db.ExecContext(ctx,
		"INSERT INTO audit_log (action, customer_id, detail, created_at) VALUES (?,?,?,?)",
		action, customerID, detail, nowUTC())
}

// CreateSubscription creates a Stripe subscription and persists it.
func (s *BillingService) CreateSubscription(ctx context.Context, customerID, tier string) (map[string]interface{}, error) {
	price, ok := PriceID[tier]
	if !ok {
		return nil, &APIError{Code: "invalid_tier", Message: "unknown tier: " + tier, Status: http.StatusBadRequest}
	}
	params := &stripe.SubscriptionParams{
		Customer: stripe.String(customerID),
		Items: []*stripe.SubscriptionItemParams{
			{Price: stripe.String(price)},
		},
	}
	sub, err := subscription.New(params)
	if err != nil {
		return nil, err
	}
	if err := s.client.SubscriptionCreate(ctx, sub); err != nil {
		return nil, err
	}
	created := nowUTC()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO subscriptions (stripe_subscription_id, customer_id, tier, status, created_at, updated_at)
		 VALUES (?,?,?,?,?,?)`,
		sub.ID, customerID, tier, "active", created, created)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, "subscription_created", customerID,
		fmt.Sprintf(`{"tier":%q,"stripe_sub_id":%q}`, tier, sub.ID))
	next := time.Now().UTC().AddDate(0, 1, 0).Format(time.RFC3339)
	return map[string]interface{}{
		"success":           true,
		"subscription_id":   sub.ID,
		"tier":              tier,
		"status":            "active",
		"next_billing_date": next,
	}, nil
}

// ChangePlan updates a subscription's tier and records proration.
func (s *BillingService) ChangePlan(ctx context.Context, subscriptionID, newTier string) (map[string]interface{}, error) {
	price, ok := PriceID[newTier]
	if !ok {
		return nil, &APIError{Code: "invalid_tier", Message: "unknown tier: " + newTier, Status: http.StatusBadRequest}
	}
	var oldTier, stripeSubID string
	err := s.db.QueryRowContext(ctx,
		"SELECT tier, stripe_subscription_id FROM subscriptions WHERE stripe_subscription_id=? OR id=?",
		subscriptionID, subscriptionID).Scan(&oldTier, &stripeSubID)
	if err == sql.ErrNoRows {
		return nil, &APIError{Code: "not_found", Message: "subscription not found", Status: http.StatusNotFound}
	}
	if err != nil {
		return nil, err
	}
	params := &stripe.SubscriptionParams{
		Items: []*stripe.SubscriptionItemParams{{Price: stripe.String(price)}},
	}
	sub, err := s.client.SubscriptionUpdate(ctx, stripeSubID, params)
	if err != nil {
		return nil, err
	}
	credit := int64(0)
	if sub.Prorations != nil {
		for _, p := range sub.Prorations {
			credit += p.Amount
		}
	}
	updated := nowUTC()
	_, err = s.db.ExecContext(ctx,
		"UPDATE subscriptions SET tier=?, updated_at=? WHERE stripe_subscription_id=?",
		newTier, updated, stripeSubID)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, "plan_changed", "",
		fmt.Sprintf(`{"subscription_id":%q,"old_tier":%q,"new_tier":%q,"proration_credits":%d}`,
			subscriptionID, oldTier, newTier, credit))
	return map[string]interface{}{
		"success":          true,
		"subscription_id":  subscriptionID,
		"old_tier":         oldTier,
		"new_tier":         newTier,
		"effective_date":   updated,
		"proration_credit": credit,
	}, nil
}

// QueueRefund validates an invoice and enqueues a refund.
func (s *BillingService) QueueRefund(ctx context.Context, invoiceID string, amount int64, reason, createdBy string) (map[string]interface{}, error) {
	var status string
	var invAmount int64
	err := s.db.QueryRowContext(ctx,
		"SELECT status, amount FROM invoices WHERE stripe_invoice_id=?", invoiceID).Scan(&status, &invAmount)
	if err == sql.ErrNoRows {
		return nil, &APIError{Code: "not_found", Message: "invoice not found", Status: http.StatusNotFound}
	}
	if err != nil {
		return nil, err
	}
	if status != "succeeded" {
		return nil, &APIError{Code: "invalid_invoice_status", Message: "invoice not succeeded", Status: http.StatusBadRequest}
	}
	if amount > invAmount {
		return nil, &APIError{Code: "refund_exceeds_invoice", Message: "refund exceeds invoice amount", Status: http.StatusBadRequest}
	}
	created := nowUTC()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO refunds (invoice_id, amount, status, reason, created_by, created_at)
		 VALUES (?,?,?,?,?,?)`,
		invoiceID, amount, "queued", reason, createdBy, created)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	s.audit(ctx, "refund_queued", "",
		fmt.Sprintf(`{"invoice_id":%q,"amount":%d,"reason":%q}`, invoiceID, amount, reason))
	return map[string]interface{}{
		"success":    true,
		"refund_id":  id,
		"status":     "queued",
		"amount":     amount,
		"reason":     reason,
	}, nil
}

// HandleStripeWebhook verifies the signature and processes the event idempotently.
func (s *BillingService) HandleStripeWebhook(ctx context.Context, payload []byte, sigHeader string) (map[string]interface{}, error) {
	secret := os.Getenv("STRIPE_WEBHOOK_SECRET")
	if secret != "" {
		if !verifySignature(payload, sigHeader, secret) {
			return nil, &APIError{Code: "invalid_signature", Message: "invalid webhook signature", Status: http.StatusForbidden}
		}
	}
	var event stripe.Event
	if err := json.Unmarshal(payload, &event); err != nil {
		return nil, &APIError{Code: "invalid_payload", Message: "bad payload", Status: http.StatusBadRequest}
	}
	if event.ID != "" {
		var count int
		_ = s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM events WHERE stripe_event_id=?", event.ID).Scan(&count)
		if count > 0 {
			return map[string]interface{}{"received": true}, nil
		}
	}
	switch event.Type {
	case "invoice.payment_succeeded":
		s.handlePaymentSucceeded(ctx, &event)
	case "invoice.payment_failed":
		s.handlePaymentFailed(ctx, &event)
	case "customer.subscription.updated":
		s.handleSubscriptionUpdated(ctx, &event)
	case "customer.subscription.deleted":
		s.handleSubscriptionDeleted(ctx, &event)
	}
	if event.ID != "" {
		_, _ = s.db.ExecContext(ctx,
			"INSERT OR IGNORE INTO events (stripe_event_id, event_type, processed_at) VALUES (?,?,?)",
			event.ID, string(event.Type), nowUTC())
	}
	return map[string]interface{}{"received": true}, nil
}

func (s *BillingService) handlePaymentSucceeded(ctx context.Context, event *stripe.Event) {
	var inv invoice.Invoice
	if err := json.Unmarshal(event.Data.Raw, &inv); err != nil {
		return
	}
	customer := ""
	if inv.Customer != nil {
		customer = inv.Customer.ID
	}
	_, _ = s.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO invoices (stripe_invoice_id, customer_id, amount, status, paid_at)
		 VALUES (?,?,?,?,?)`,
		inv.ID, customer, inv.AmountPaid, "succeeded", nowUTC())
	s.audit(ctx, "payment_succeeded", customer,
		fmt.Sprintf(`{"invoice_id":%q,"amount":%d}`, inv.ID, inv.AmountPaid))
}

func (s *BillingService) handlePaymentFailed(ctx context.Context, event *stripe.Event) {
	var inv invoice.Invoice
	if err := json.Unmarshal(event.Data.Raw, &inv); err != nil {
		return
	}
	customer := ""
	if inv.Customer != nil {
		customer = inv.Customer.ID
	}
	_, _ = s.db.ExecContext(ctx,
		"UPDATE subscriptions SET status='past_due', updated_at=? WHERE customer_id=? AND status!='cancelled'",
		nowUTC(), customer)
	s.audit(ctx, "payment_failed", customer,
		fmt.Sprintf(`{"invoice_id":%q,"reason":"payment_failed"}`, inv.ID))
}

func (s *BillingService) handleSubscriptionUpdated(ctx context.Context, event *stripe.Event) {
	var sub subscription.Subscription
	if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
		return
	}
	customer := ""
	if sub.Customer != nil {
		customer = sub.Customer.ID
	}
	tier := ""
	if len(sub.Items.Data) > 0 && sub.Items.Data[0].Price != nil {
		tier = sub.Items.Data[0].Price.LookupKey
	}
	var oldTier string
	_ = s.db.QueryRowContext(ctx, "SELECT tier FROM subscriptions WHERE stripe_subscription_id=?", sub.ID).Scan(&oldTier)
	_, _ = s.db.ExecContext(ctx,
		"UPDATE subscriptions SET tier=?, status=?, updated_at=? WHERE stripe_subscription_id=?",
		tier, sub.Status, nowUTC(), sub.ID)
	s.audit(ctx, "subscription_updated", customer,
		fmt.Sprintf(`{"old_tier":%q,"new_tier":%q}`, oldTier, tier))
}

func (s *BillingService) handleSubscriptionDeleted(ctx context.Context, event *stripe.Event) {
	var sub subscription.Subscription
	if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
		return
	}
	customer := ""
	if sub.Customer != nil {
		customer = sub.Customer.ID
	}
	_, _ = s.db.ExecContext(ctx,
		"UPDATE subscriptions SET status='cancelled', cancelled_at=?, updated_at=? WHERE stripe_subscription_id=?",
		nowUTC(), nowUTC(), sub.ID)
	s.audit(ctx, "subscription_cancelled", customer, "")
}

// verifySignature validates a Stripe webhook signature header.
func verifySignature(payload []byte, sigHeader, secret string) bool {
	parts := strings.Split(sigHeader, ",")
	var timestamp, sig string
	for _, p := range parts {
		kv := strings.SplitN(strings.TrimSpace(p), "=", 2)
		if len(kv) == 2 {
			if kv[0] == "t" {
				timestamp = kv[1]
			} else if kv[0] == "v1" {
				sig = kv[1]
			}
		}
	}
	if timestamp == "" || sig == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(payload)
	expected := fmt.Sprintf("%x", mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(sig))
}

// APIError is a structured error with a JSON code and HTTP status.
type APIError struct {
	Code    string
	Message string
	Status  int
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

// WriteJSON writes a response body as JSON.
func WriteJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ErrorJSON renders an APIError in the spec's {error, message} shape.
func ErrorJSON(e *APIError) map[string]interface{} {
	return map[string]interface{}{"error": e.Code, "message": e.Message}
}

// AmountFromCents parses a string amount into int64 cents.
func AmountFromCents(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}