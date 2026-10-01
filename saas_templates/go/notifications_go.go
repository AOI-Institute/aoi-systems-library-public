package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Channel string

const (
	ChannelEmail  Channel = "email"
	ChannelSMS    Channel = "sms"
	ChannelInApp  Channel = "in_app"
)

type Status string

const (
	StatusSent     Status = "sent"
	StatusQueued   Status = "queued"
	StatusFailed   Status = "failed"
	StatusBounced  Status = "bounced"
	StatusOpened   Status = "opened"
	StatusClicked  Status = "clicked"
	StatusSkipped  Status = "skipped"
)

type Template struct {
	Key             string
	Subject         string
	BodyText        string
	BodyHTML        string
	ChannelsDefault []Channel
	Variables       []string
}

type NotificationLog struct {
	ID          int64
	UserID      int64
	TemplateKey string
	Channel     Channel
	VarsUsed    string
	SentAt      *time.Time
	OpenedAt    *time.Time
	ClickedAt   *time.Time
	Bounced     bool
	Error       string
	Status      Status
}

type UserPreferences struct {
	UserID           int64
	DoNotDisturb     bool
	QuietHoursStart  string
	QuietHoursEnd    string
	ChannelsEnabled  map[string]bool
}

type SendRequest struct {
	UserID      int64
	TemplateKey string
	Channel     *Channel
	Vars        map[string]interface{}
	ScheduledAt *time.Time
}

type SendResponse struct {
	Success   bool   `json:"success"`
	MessageID string `json:"message_id"`
	Status    Status `json:"status"`
}

type BatchSendResponse struct {
	Success    bool     `json:"success"`
	Sent       int      `json:"sent"`
	Failed     int      `json:"failed"`
	MessageIDs []string `json:"message_ids"`
}

type TrackResponse struct {
	MessageID   string     `json:"message_id"`
	UserID      int64      `json:"user_id"`
	TemplateKey string     `json:"template_key"`
	Channel     Channel    `json:"channel"`
	Status      Status     `json:"status"`
	SentAt      *time.Time `json:"sent_at"`
	OpenedAt    *time.Time `json:"opened_at"`
	ClickedAt   *time.Time `json:"clicked_at"`
}

type PreferencesResponse struct {
	UserID          int64            `json:"user_id"`
	DoNotDisturb    bool             `json:"do_not_disturb"`
	QuietHoursStart string           `json:"quiet_hours_start"`
	QuietHoursEnd   string           `json:"quiet_hours_end"`
	ChannelsEnabled map[string]bool  `json:"channels_enabled"`
}

type UpdatePreferencesRequest struct {
	DoNotDisturb    *bool             `json:"do_not_disturb"`
	QuietHoursStart *string           `json:"quiet_hours_start"`
	QuietHoursEnd   *string           `json:"quiet_hours_end"`
	ChannelsEnabled map[string]bool   `json:"channels_enabled"`
}

// ---------------------------------------------------------------------------
// Email / SMS providers (interface for testability)
// ---------------------------------------------------------------------------

type EmailProvider interface {
	Send(ctx context.Context, to, subject, bodyText, bodyHTML string) error
}

type SMSProvider interface {
	Send(ctx context.Context, to, body string) error
}

type NullEmailProvider struct{}

func (NullEmailProvider) Send(ctx context.Context, to, subject, bodyText, bodyHTML string) error {
	return nil
}

type NullSMSProvider struct{}

func (NullSMSProvider) Send(ctx context.Context, to, body string) error {
	return nil
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type Service struct {
	db          *sql.DB
	templates   map[string]Template
	email       EmailProvider
	sms         SMSProvider
	mu          sync.Mutex
	unsubscribed map[int64]bool
}

func NewService(db *sql.DB, email EmailProvider, sms SMSProvider) *Service {
	if email == nil {
		email = NullEmailProvider{}
	}
	if sms == nil {
		sms = NullSMSProvider{}
	}
	s := &Service{
		db:           db,
		templates:    make(map[string]Template),
		email:        email,
		sms:          sms,
		unsubscribed: make(map[int64]bool),
	}
	s.seedTemplates()
	return s
}

func (s *Service) seedTemplates() {
	defaults := []Template{
		{Key: "welcome_email", Subject: "Welcome to {app_name}!", BodyText: "Welcome to {app_name}! Here's your first step.", BodyHTML: "<p>Welcome to {app_name}! Here's your first step.</p>", ChannelsDefault: []Channel{ChannelEmail}, Variables: []string{"app_name"}},
		{Key: "trial_starting", Subject: "Your free trial is starting", BodyText: "Your free trial is starting. You have {trial_days} days.", BodyHTML: "<p>Your free trial is starting. You have {trial_days} days.</p>", ChannelsDefault: []Channel{ChannelEmail}, Variables: []string{"trial_days"}},
		{Key: "trial_ending_soon", Subject: "Your trial ends in {days_left} days", BodyText: "Your trial ends in {days_left} days. Add payment method to continue.", BodyHTML: "<p>Your trial ends in {days_left} days. Add payment method to continue.</p>", ChannelsDefault: []Channel{ChannelEmail, ChannelSMS}, Variables: []string{"days_left"}},
		{Key: "subscription_changed", Subject: "Your plan changed", BodyText: "Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.", BodyHTML: "<p>Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.</p>", ChannelsDefault: []Channel{ChannelEmail}, Variables: []string{"old_tier", "new_tier", "effective_date"}},
		{Key: "payment_failed", Subject: "Payment failed", BodyText: "Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.", BodyHTML: "<p>Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.</p>", ChannelsDefault: []Channel{ChannelEmail, ChannelSMS}, Variables: []string{"invoice_id", "retry_date"}},
		{Key: "deployment_live", Subject: "Deployment live", BodyText: "Your deployment {deployment_name} is now live at {url}.", BodyHTML: "<p>Your deployment {deployment_name} is now live at {url}.</p>", ChannelsDefault: []Channel{ChannelEmail, ChannelInApp}, Variables: []string{"deployment_name", "url"}},
		{Key: "user_invited", Subject: "You've been invited", BodyText: "You've been invited to {workspace}. Click here to join.", BodyHTML: "<p>You've been invited to {workspace}. <a href=\"#\">Click here to join</a>.</p>", ChannelsDefault: []Channel{ChannelEmail}, Variables: []string{"workspace"}},
		{Key: "invoice_ready", Subject: "Your invoice is ready", BodyText: "Your invoice for {month} is ready. Download here.", BodyHTML: "<p>Your invoice for {month} is ready. <a href=\"#\">Download here</a>.</p>", ChannelsDefault: []Channel{ChannelEmail}, Variables: []string{"month"}},
		{Key: "admin_alert", Subject: "Admin alert", BodyText: "{actor} performed {action} on {resource}.", BodyHTML: "<p>{actor} performed {action} on {resource}.</p>", ChannelsDefault: []Channel{ChannelInApp}, Variables: []string{"actor", "action", "resource"}},
	}
	for _, t := range defaults {
		s.templates[t.Key] = t
	}
}

// ---------------------------------------------------------------------------
// Database schema
// ---------------------------------------------------------------------------

const schemaSQL = `
CREATE TABLE IF NOT EXISTS notification_templates (
	key TEXT PRIMARY KEY,
	subject TEXT,
	body_text TEXT,
	body_html TEXT,
	channels_default TEXT,
	variables TEXT
);
CREATE TABLE IF NOT EXISTS notification_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	template_key TEXT NOT NULL,
	channel TEXT NOT NULL,
	vars_used TEXT,
	sent_at DATETIME,
	opened_at DATETIME,
	clicked_at DATETIME,
	bounced INTEGER DEFAULT 0,
	error TEXT,
	status TEXT DEFAULT 'sent'
);
CREATE TABLE IF NOT EXISTS user_notification_preferences (
	user_id INTEGER PRIMARY KEY,
	do_not_disturb INTEGER DEFAULT 0,
	quiet_hours_start TEXT DEFAULT '22:00',
	quiet_hours_end TEXT DEFAULT '08:00',
	channels_enabled TEXT DEFAULT '{"email":true,"sms":false,"in_app":true}'
);
`

func (s *Service) InitDB(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, schemaSQL)
	return err
}

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

var varRe = regexp.MustCompile(`\{(\w+)\}`)

func renderTemplate(text string, vars map[string]interface{}) string {
	return varRe.ReplaceAllStringFunc(text, func(m string) string {
		key := m[1 : len(m)-1]
		if v, ok := vars[key]; ok {
			return fmt.Sprintf("%v", v)
		}
		return m
	})
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

func (s *Service) GetPreferences(ctx context.Context, userID int64) (*PreferencesResponse, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT do_not_disturb, quiet_hours_start, quiet_hours_end, channels_enabled FROM user_notification_preferences WHERE user_id = ?",
		userID)
	var dnd int
	var qStart, qEnd, chJSON string
	if err := row.Scan(&dnd, &qStart, &qEnd, &chJSON); err != nil {
		if err == sql.ErrNoRows {
			return &PreferencesResponse{
				UserID:          userID,
				DoNotDisturb:    false,
				QuietHoursStart: "22:00",
				QuietHoursEnd:   "08:00",
				ChannelsEnabled: map[string]bool{"email": true, "sms": false, "in_app": true},
			}, nil
		}
		return nil, err
	}
	channels := map[string]bool{}
	_ = json.Unmarshal([]byte(chJSON), &channels)
	return &PreferencesResponse{
		UserID:          userID,
		DoNotDisturb:    dnd != 0,
		QuietHoursStart: qStart,
		QuietHoursEnd:   qEnd,
		ChannelsEnabled: channels,
	}, nil
}

func (s *Service) UpdatePreferences(ctx context.Context, userID int64, req *UpdatePreferencesRequest) error {
	dnd := 0
	if req.DoNotDisturb != nil && *req.DoNotDisturb {
		dnd = 1
	}
	qStart := "22:00"
	if req.QuietHoursStart != nil {
		qStart = *req.QuietHoursStart
	}
	qEnd := "08:00"
	if req.QuietHoursEnd != nil {
		qEnd = *req.QuietHoursEnd
	}
	chJSON, _ := json.Marshal(req.ChannelsEnabled)
	if chJSON == nil {
		chJSON = []byte(`{"email":true,"sms":false,"in_app":true}`)
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_notification_preferences (user_id, do_not_disturb, quiet_hours_start, quiet_hours_end, channels_enabled)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
			do_not_disturb = excluded.do_not_disturb,
			quiet_hours_start = excluded.quiet_hours_start,
			quiet_hours_end = excluded.quiet_hours_end,
			channels_enabled = excluded.channels_enabled`,
		userID, dnd, qStart, qEnd, string(chJSON))
	return err
}

// ---------------------------------------------------------------------------
// Quiet hours check
// ---------------------------------------------------------------------------

func inQuietHours(now time.Time, start, end string) bool {
	nowHM := now.Format("15:04")
	if start <= end {
		return nowHM >= start && nowHM < end
	}
	return nowHM >= start || nowHM < end
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

func (s *Service) Send(ctx context.Context, req *SendRequest) (*SendResponse, error) {
	tmpl, ok := s.templates[req.TemplateKey]
	if !ok {
		return &SendResponse{Success: false, Status: StatusFailed}, fmt.Errorf("template %q not found", req.TemplateKey)
	}

	prefs, err := s.GetPreferences(ctx, req.UserID)
	if err != nil {
		return &SendResponse{Success: false, Status: StatusFailed}, err
	}

	// Do-not-disturb
	if prefs.DoNotDisturb {
		s.logSkipped(ctx, req.UserID, req.TemplateKey, ChannelInApp, req.Vars)
		return &SendResponse{Success: true, MessageID: fmt.Sprintf("skipped-%d", time.Now().UnixNano()), Status: StatusSkipped}, nil
	}

	// Determine channel
	channel := ChannelInApp
	if req.Channel != nil {
		channel = *req.Channel
	} else {
		for _, ch := range tmpl.ChannelsDefault {
			if prefs.ChannelsEnabled[string(ch)] {
				channel = ch
				break
			}
		}
	}

	// Check channel enabled
	if !prefs.ChannelsEnabled[string(channel)] {
		s.logSkipped(ctx, req.UserID, req.TemplateKey, channel, req.Vars)
		return &SendResponse{Success: true, MessageID: fmt.Sprintf("skipped-%d", time.Now().UnixNano()), Status: StatusSkipped}, nil
	}

	// Quiet hours
	now := time.Now()
	if inQuietHours(now, prefs.QuietHoursStart, prefs.QuietHoursEnd) {
		s.logSkipped(ctx, req.UserID, req.TemplateKey, channel, req.Vars)
		return &SendResponse{Success: true, MessageID: fmt.Sprintf("queued-%d", time.Now().UnixNano()), Status: StatusQueued}, nil
	}

	// Unsubscribe check for email
	if channel == ChannelEmail && s.unsubscribed[req.UserID] {
		s.logSkipped(ctx, req.UserID, req.TemplateKey, channel, req.Vars)
		return &SendResponse{Success: true, MessageID: fmt.Sprintf("skipped-%d", time.Now().UnixNano()), Status: StatusSkipped}, nil
	}

	// Render
	subject := renderTemplate(tmpl.Subject, req.Vars)
	bodyText := renderTemplate(tmpl.BodyText, req.Vars)
	bodyHTML := renderTemplate(tmpl.BodyHTML, req.Vars)

	// Add unsubscribe link to email
	if channel == ChannelEmail {
		unsubURL := fmt.Sprintf("/unsubscribe/%d", req.UserID)
		bodyHTML += fmt.Sprintf("<p><a href=\"%s\">Unsubscribe</a></p>", unsubURL)
	}

	varsJSON, _ := json.Marshal(req.Vars)

	// Send with retry
	var sendErr error
	switch channel {
	case ChannelEmail:
		sendErr = s.sendWithRetry(ctx, func() error {
			return s.email.Send(ctx, fmt.Sprintf("user%d@example.com", req.UserID), subject, bodyText, bodyHTML)
		})
	case ChannelSMS:
		sendErr = s.sendWithRetry(ctx, func() error {
			return s.sms.Send(ctx, fmt.Sprintf("+15550000%d", req.UserID%10000), bodyText)
		})
	case ChannelInApp:
		sendErr = nil
	}

	status := StatusSent
	if sendErr != nil {
		status = StatusFailed
	}

	// Log
	var id int64
	err = s.db.QueryRowContext(ctx,
		`INSERT INTO notification_logs (user_id, template_key, channel, vars_used, sent_at, status, error)
		 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		req.UserID, req.TemplateKey, string(channel), string(varsJSON), now, string(status), sendErr.Error()).Scan(&id)
	if err != nil {
		// Fallback for SQLite without RETURNING
		res, e2 := s.db.ExecContext(ctx,
			`INSERT INTO notification_logs (user_id, template_key, channel, vars_used, sent_at, status, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			req.UserID, req.TemplateKey, string(channel), string(varsJSON), now, string(status), sendErr.Error())
		if e2 != nil {
			return &SendResponse{Success: false, Status: StatusFailed}, e2
		}
		id, _ = res.LastInsertId()
	}

	return &SendResponse{Success: true, MessageID: strconv.FormatInt(id, 10), Status: status}, nil
}

func (s *Service) sendWithRetry(ctx context.Context, fn func() error) error {
	var lastErr error
	for i := 0; i < 3; i++ {
		lastErr = fn()
		if lastErr == nil {
			return nil
		}
		if i < 2 {
			backoff := time.Duration(1<<uint(i)) * 100 * time.Millisecond
			time.Sleep(backoff)
		}
	}
	return lastErr
}

func (s *Service) logSkipped(ctx context.Context, userID int64, templateKey string, channel Channel, vars map[string]interface{}) {
	varsJSON, _ := json.Marshal(vars)
	_, _ = s.db.ExecContext(ctx,
		`INSERT INTO notification_logs (user_id, template_key, channel, vars_used, status)
		 VALUES (?, ?, ?, ?, ?)`,
		userID, templateKey, string(channel), string(varsJSON), string(StatusSkipped))
}

// ---------------------------------------------------------------------------
// Batch send
// ---------------------------------------------------------------------------

func (s *Service) SendBatch(ctx context.Context, reqs []SendRequest) (*BatchSendResponse, error) {
	resp := &BatchSendResponse{Success: true, MessageIDs: make([]string, 0, len(reqs))}
	var wg sync.WaitGroup
	var mu sync.Mutex
	sem := make(chan struct{}, 50)

	for i := range reqs {
		wg.Add(1)
		sem <- struct{}{}
		go func(req SendRequest) {
			defer wg.Done()
			defer func() { <-sem }()
			r, err := s.Send(ctx, &req)
			mu.Lock()
			defer mu.Unlock()
			if err != nil || r.Status == StatusFailed {
				resp.Failed++
			} else {
				resp.Sent++
				resp.MessageIDs = append(resp.MessageIDs, r.MessageID)
			}
		}(reqs[i])
	}
	wg.Wait()
	return resp, nil
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

func (s *Service) Track(ctx context.Context, messageID string) (*TrackResponse, error) {
	id, err := strconv.ParseInt(messageID, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid message_id: %s", messageID)
	}
	row := s.db.QueryRowContext(ctx,
		`SELECT user_id, template_key, channel, sent_at, opened_at, clicked_at, bounced, status
		 FROM notification_logs WHERE id = ?`, id)
	var userID int64
	var templateKey, channel string
	var sentAt, openedAt, clickedAt sql.NullTime
	var bounced int
	var status string
	if err := row.Scan(&userID, &templateKey, &channel, &sentAt, &openedAt, &clickedAt, &bounced, &status); err != nil {
		return nil, err
	}
	tr := &TrackResponse{
		MessageID:   messageID,
		UserID:      userID,
		TemplateKey: templateKey,
		Channel:     Channel(channel),
		Status:      Status(status),
	}
	if sentAt.Valid {
		t := sentAt.Time
		tr.SentAt = &t
	}
	if openedAt.Valid {
		t := openedAt.Time
		tr.OpenedAt = &t
	}
	if clickedAt.Valid {
		t := clickedAt.Time
		tr.ClickedAt = &t
	}
	return tr, nil
}

func (s *Service) MarkOpened(ctx context.Context, messageID string) error {
	id, err := strconv.ParseInt(messageID, 10, 64)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE notification_logs SET opened_at = ?, status = 'opened' WHERE id = ? AND (opened_at IS NULL)`,
		time.Now(), id)
	return err
}

func (s *Service) MarkClicked(ctx context.Context, messageID string) error {
	id, err := strconv.ParseInt(messageID, 10, 64)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE notification_logs SET clicked_at = ?, status = 'clicked' WHERE id = ?`,
		time.Now(), id)
	return err
}

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

func (s *Service) Unsubscribe(ctx context.Context, userID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unsubscribed[userID] = true
	return nil
}

// ---------------------------------------------------------------------------
// In-app notifications fetch
// ---------------------------------------------------------------------------

func (s *Service) GetInAppNotifications(ctx context.Context, userID int64) ([]NotificationLog, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, template_key, channel, vars_used, sent_at, opened_at, clicked_at, bounced, error, status
		 FROM notification_logs WHERE user_id = ? AND channel = 'in_app' ORDER BY id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var logs []NotificationLog
	for rows.Next() {
		var l NotificationLog
		var sentAt, openedAt, clickedAt sql.NullTime
		var bounced int
		if err := rows.Scan(&l.ID, &l.UserID, &l.TemplateKey, &l.Channel, &l.VarsUsed, &sentAt, &openedAt, &clickedAt, &bounced, &l.Error, &l.Status); err != nil {
			return nil, err
		}
		l.Bounced = bounced != 0
		if sentAt.Valid {
			t := sentAt.Time
			l.SentAt = &t
		}
		if openedAt.Valid {
			t := openedAt.Time
			l.OpenedAt = &t
		}
		if clickedAt.Valid {
			t := clickedAt.Time
			l.ClickedAt = &t
		}
		logs = append(logs, l)
	}
	return logs, nil
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

func (s *Service) HandleSend(w http.ResponseWriter, r *http.Request) {
	var req SendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"success":false,"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	resp, err := s.Send(r.Context(), &req)
	if err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Service) HandleSendBatch(w http.ResponseWriter, r *http.Request) {
	var reqs []SendRequest
	if err := json.NewDecoder(r.Body).Decode(&reqs); err != nil {
		http.Error(w, `{"success":false,"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	resp, err := s.SendBatch(r.Context(), reqs)
	if err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Service) HandleTrack(w http.ResponseWriter, r *http.Request) {
	messageID := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	resp, err := s.Track(r.Context(), messageID)
	if err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Service) HandleGetPreferences(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		http.Error(w, `{"success":false,"error":"bad user_id"}`, http.StatusBadRequest)
		return
	}
	resp, err := s.GetPreferences(r.Context(), userID)
	if err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Service) HandleUpdatePreferences(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		http.Error(w, `{"success":false,"error":"bad user_id"}`, http.StatusBadRequest)
		return
	}
	var req UpdatePreferencesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"success":false,"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if err := s.UpdatePreferences(r.Context(), userID, &req); err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (s *Service) HandleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		http.Error(w, `{"success":false,"error":"bad user_id"}`, http.StatusBadRequest)
		return
	}
	if err := s.Unsubscribe(r.Context(), userID); err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (s *Service) HandleMarkOpened(w http.ResponseWriter, r *http.Request) {
	messageID := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	if err := s.MarkOpened(r.Context(), messageID); err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

func (s *Service) HandleMarkClicked(w http.ResponseWriter, r *http.Request) {
	messageID := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	if err := s.MarkClicked(r.Context(), messageID); err != nil {
		http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"success": true})
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/notifications/send", s.HandleSend)
	mux.HandleFunc("/notifications/send-batch", s.HandleSendBatch)
	mux.HandleFunc("/notifications/track/", s.HandleTrack)
	mux.HandleFunc("/users/", s.handleUsers)
	mux.HandleFunc("/unsubscribe/", s.HandleUnsubscribe)
	mux.HandleFunc("/notifications/opened/", s.HandleMarkOpened)
	mux.HandleFunc("/notifications/clicked/", s.HandleMarkClicked)
}

func (s *Service) handleUsers(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if idx := strings.Index(path, "/notification-preferences"); idx != -1 {
		userIDStr := path[strings.LastIndex(path, "/")+1 : idx]
		userID, err := strconv.ParseInt(userIDStr, 10, 64)
		if err != nil {
			http.Error(w, `{"success":false,"error":"bad user_id"}`, http.StatusBadRequest)
			return
		}
		switch r.Method {
		case http.MethodGet:
			resp, err := s.GetPreferences(r.Context(), userID)
			if err != nil {
				http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
		case http.MethodPut:
			var req UpdatePreferencesRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, `{"success":false,"error":"bad request"}`, http.StatusBadRequest)
				return
			}
			if err := s.UpdatePreferences(r.Context(), userID, &req); err != nil {
				http.Error(w, `{"success":false,"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]bool{"success": true})
		default:
			http.Error(w, `{"success":false,"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		}
		return
	}
	http.Error(w, `{"success":false,"error":"not found"}`, http.StatusNotFound)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func NewInMemoryDB() (*sql.DB, error) {
	return sql.Open("sqlite3", ":memory:")
}

func NewServiceWithDB(db *sql.DB) (*Service, error) {
	s := NewService(db, nil, nil)
	if err := s.InitDB(context.Background()); err != nil {
		return nil, err
	}
	return s, nil
}

var _ = rand.Int // keep import