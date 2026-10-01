use chrono::{DateTime, Local, NaiveTime, TimeZone, Utc};
use rusqlite::{params, Connection, Result as SqlResult, NO_PARAMS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

/// Database schema migration
pub fn init_db(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS notification_templates (
            key TEXT PRIMARY KEY,
            subject TEXT,
            body_text TEXT,
            body_html TEXT,
            channels_default TEXT,
            variables TEXT
        );

        CREATE TABLE IF NOT EXISTS notification_logs (
            id TEXT PRIMARY KEY,
            user_id INTEGER,
            template_key TEXT,
            channel TEXT,
            vars_used TEXT,
            sent_at TEXT,
            opened_at TEXT,
            clicked_at TEXT,
            bounced INTEGER,
            error TEXT
        );

        CREATE TABLE IF NOT EXISTS user_notification_preferences (
            user_id INTEGER PRIMARY KEY,
            do_not_disturb INTEGER,
            quiet_hours_start TEXT,
            quiet_hours_end TEXT,
            channels_enabled TEXT
        );
        ",
    )?;
    Ok(())
}

/// Load default templates into the database
pub fn load_default_templates(conn: &Connection) -> SqlResult<()> {
    let templates = vec![
        (
            "welcome_email",
            "Welcome to {app_name}!",
            "Welcome to {app_name}! Here's your first step.",
            "",
            r#"["email"]"#,
            r#"["app_name"]"#,
        ),
        (
            "trial_starting",
            "",
            "Your free trial is starting. You have {trial_days} days.",
            "",
            r#"["email","sms"]"#,
            r#"["trial_days"]"#,
        ),
        (
            "trial_ending_soon",
            "",
            "Your trial ends in {days_left} days. Add payment method to continue.",
            "",
            r#"["email","sms"]"#,
            r#"["days_left"]"#,
        ),
        (
            "subscription_changed",
            "",
            "Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.",
            "",
            r#"["email"]"#,
            r#"["old_tier","new_tier","effective_date"]"#,
        ),
        (
            "payment_failed",
            "",
            "Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.",
            "",
            r#"["email","sms"]"#,
            r#"["invoice_id","retry_date"]"#,
        ),
        (
            "deployment_live",
            "",
            "Your deployment {deployment_name} is now live at {url}.",
            "",
            r#"["email","sms"]"#,
            r#"["deployment_name","url"]"#,
        ),
        (
            "user_invited",
            "",
            "You've been invited to {workspace}. Click here to join.",
            "",
            r#"["email","sms"]"#,
            r#"["workspace"]"#,
        ),
        (
            "invoice_ready",
            "",
            "Your invoice for {month} is ready. Download here.",
            "",
            r#"["email"]"#,
            r#"["month"]"#,
        ),
        (
            "admin_alert",
            "",
            "{actor} performed {action} on {resource}.",
            "",
            r#"["email"]"#,
            r#"["actor","action","resource"]"#,
        ),
    ];

    for (key, subject, body_text, body_html, channels_default, variables) in templates {
        conn.execute(
            "INSERT OR REPLACE INTO notification_templates (key, subject, body_text, body_html, channels_default, variables)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![key, subject, body_text, body_html, channels_default, variables],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationTemplate {
    pub key: String,
    pub subject: Option<String>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub channels_default: Vec<String>,
    pub variables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationLog {
    pub id: String,
    pub user_id: i64,
    pub template_key: String,
    pub channel: String,
    pub vars_used: HashMap<String, String>,
    pub sent_at: Option<DateTime<Utc>>,
    pub opened_at: Option<DateTime<Utc>>,
    pub clicked_at: Option<DateTime<Utc>>,
    pub bounced: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserNotificationPreferences {
    pub user_id: i64,
    pub do_not_disturb: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
    pub channels_enabled: HashMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserNotificationPreferencesUpdate {
    pub do_not_disturb: Option<bool>,
    pub quiet_hours_start: Option<String>,
    pub quiet_hours_end: Option<String>,
    pub channels_enabled: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendResponse {
    pub success: bool,
    pub message_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSendResponse {
    pub success: bool,
    pub sent: usize,
    pub failed: usize,
    pub message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackResponse {
    pub message_id: String,
    pub user_id: i64,
    pub template_key: String,
    pub channel: String,
    pub status: String,
    pub sent_at: Option<DateTime<Utc>>,
    pub opened_at: Option<DateTime<Utc>>,
    pub clicked_at: Option<DateTime<Utc>>,
}

pub struct NotificationService {
    conn: Connection,
}

impl NotificationService {
    pub fn new_in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        init_db(&conn)?;
        load_default_templates(&conn)?;
        Ok(Self { conn })
    }

    fn load_template(&self, key: &str) -> SqlResult<NotificationTemplate> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, subject, body_text, body_html, channels_default, variables FROM notification_templates WHERE key = ?1")?;
        let template = stmt.query_row(params![key], |row| {
            let channels_default: String = row.get(4)?;
            let variables: String = row.get(5)?;
            Ok(NotificationTemplate {
                key: row.get(0)?,
                subject: row.get(1)?,
                body_text: row.get(2)?,
                body_html: row.get(3)?,
                channels_default: serde_json::from_str(&channels_default).unwrap_or_default(),
                variables: serde_json::from_str(&variables).unwrap_or_default(),
            })
        })?;
        Ok(template)
    }

    fn load_user_preferences(&self, user_id: i64) -> SqlResult<UserNotificationPreferences> {
        let mut stmt = self.conn.prepare(
            "SELECT user_id, do_not_disturb, quiet_hours_start, quiet_hours_end, channels_enabled FROM user_notification_preferences WHERE user_id = ?1",
        )?;
        let prefs = stmt.query_row(params![user_id], |row| {
            let channels_enabled: String = row.get(4)?;
            Ok(UserNotificationPreferences {
                user_id: row.get(0)?,
                do_not_disturb: row.get::<_, i64>(1)? != 0,
                quiet_hours_start: row.get(2)?,
                quiet_hours_end: row.get(3)?,
                channels_enabled: serde_json::from_str(&channels_enabled).unwrap_or_default(),
            })
        })?;
        Ok(prefs)
    }

    fn update_user_preferences(&self, user_id: i64, update: &UserNotificationPreferencesUpdate) -> SqlResult<()> {
        let prefs = self.load_user_preferences(user_id).unwrap_or(UserNotificationPreferences {
            user_id,
            do_not_disturb: false,
            quiet_hours_start: "00:00".to_string(),
            quiet_hours_end: "00:00".to_string(),
            channels_enabled: HashMap::new(),
        });

        let do_not_disturb = update.do_not_disturb.unwrap_or(prefs.do_not_disturb);
        let quiet_hours_start = update.quiet_hours_start.clone().unwrap_or(prefs.quiet_hours_start);
        let quiet_hours_end = update.quiet_hours_end.clone().unwrap_or(prefs.quiet_hours_end);
        let channels_enabled = update
            .channels_enabled
            .clone()
            .unwrap_or(prefs.channels_enabled);

        self.conn.execute(
            "INSERT OR REPLACE INTO user_notification_preferences (user_id, do_not_disturb, quiet_hours_start, quiet_hours_end, channels_enabled)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                user_id,
                if do_not_disturb { 1 } else { 0 },
                quiet_hours_start,
                quiet_hours_end,
                serde_json::to_string(&channels_enabled).unwrap()
            ],
        )?;
        Ok(())
    }

    fn is_in_quiet_hours(&self, prefs: &UserNotificationPreferences) -> bool {
        let start = NaiveTime::parse_from_str(&prefs.quiet_hours_start, "%H:%M").ok()?;
        let end = NaiveTime::parse_from_str(&prefs.quiet_hours_end, "%H:%M").ok()?;
        let now = Local::now().time();
        if start <= end {
            now >= start && now <= end
        } else {
            now >= start || now <= end
        }
    }

    fn render_template(template: &NotificationTemplate, vars: &HashMap<String, String>) -> (String, String, String) {
        let mut subject = template.subject.clone().unwrap_or_default();
        let mut body_text = template.body_text.clone().unwrap_or_default();
        let mut body_html = template.body_html.clone().unwrap_or_default();

        for (k, v) in vars {
            let placeholder = format!("{{{}}}", k);
            subject = subject.replace(&placeholder, v);
            body_text = body_text.replace(&placeholder, v);
            body_html = body_html.replace(&placeholder, v);
        }
        (subject, body_text, body_html)
    }

    fn send_email(&self, to: &str, subject: &str, body_text: &str, body_html: &str, simulate_fail: bool) -> Result<(), String> {
        if simulate_fail {
            Err("Simulated email failure".to_string())
        } else {
            // In real implementation, send via SMTP or third-party
            Ok(())
        }
    }

    fn send_sms(&self, to: &str, body: &str, simulate_fail: bool) -> Result<(), String> {
        if simulate_fail {
            Err("Simulated SMS failure".to_string())
        } else {
            // In real implementation, send via Twilio or AWS SNS
            Ok(())
        }
    }

    fn log_notification(
        &self,
        id: &str,
        user_id: i64,
        template_key: &str,
        channel: &str,
        vars_used: &HashMap<String, String>,
        sent_at: Option<DateTime<Utc>>,
        status: &str,
        error: Option<String>,
    ) -> SqlResult<()> {
        self.conn.execute(
            "INSERT INTO notification_logs (id, user_id, template_key, channel, vars_used, sent_at, opened_at, clicked_at, bounced, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 0, ?7)",
            params![
                id,
                user_id,
                template_key,
                channel,
                serde_json::to_string(vars_used).unwrap(),
                sent_at.map(|dt| dt.to_rfc3339()),
                error
            ],
        )?;
        Ok(())
    }

    pub fn send_single_notification(
        &self,
        user_id: i64,
        template_key: &str,
        channel: Option<&str>,
        vars: &HashMap<String, String>,
        scheduled_at: Option<DateTime<Utc>>,
    ) -> SqlResult<SendResponse> {
        let template = self.load_template(template_key)?;
        let prefs = self.load_user_preferences(user_id).unwrap_or(UserNotificationPreferences {
            user_id,
            do_not_disturb: false,
            quiet_hours_start: "00:00".to_string(),
            quiet_hours_end: "00:00".to_string(),
            channels_enabled: HashMap::new(),
        });

        if prefs.do_not_disturb {
            let message_id = Uuid::new_v4().to_string();
            self.log_notification(
                &message_id,
                user_id,
                template_key,
                "none",
                vars,
                None,
                "skipped",
                Some("do_not_disturb".to_string()),
            )?;
            return Ok(SendResponse {
                success: false,
                message_id,
                status: "skipped".to_string(),
            });
        }

        if self.is_in_quiet_hours(&prefs) {
            let message_id = Uuid::new_v4().to_string();
            self.log_notification(
                &message_id,
                user_id,
                template_key,
                "none",
                vars,
                None,
                "skipped",
                Some("quiet_hours".to_string()),
            )?;
            return Ok(SendResponse {
                success: false,
                message_id,
                status: "skipped".to_string(),
            });
        }

        let chosen_channel = if let Some(ch) = channel {
            ch.to_string()
        } else {
            template
                .channels_default
                .iter()
                .find(|ch| prefs.channels_enabled.get(*ch).cloned().unwrap_or(false))
                .cloned()
                .unwrap_or_else(|| "none".to_string())
        };

        if chosen_channel == "none" {
            let message_id = Uuid::new_v4().to_string();
            self.log_notification(
                &message_id,
                user_id,
                template_key,
                "none",
                vars,
                None,
                "skipped",
                Some("no_channel".to_string()),
            )?;
            return Ok(SendResponse {
                success: false,
                message_id,
                status: "skipped".to_string(),
            });
        }

        let (subject, body_text, body_html) = Self::render_template(&template, vars);
        let simulate_fail = vars.get("simulate_fail").map_or(false, |v| v == "true");
        let message_id = Uuid::new_v4().to_string();

        if scheduled_at.is_some() {
            self.log_notification(
                &message_id,
                user_id,
                template_key,
                &chosen_channel,
                vars,
                None,
                "queued",
                None,
            )?;
            return Ok(SendResponse {
                success: true,
                message_id,
                status: "queued".to_string(),
            });
        }

        let mut attempt = 0;
        let max_attempts = 3;
        let mut last_err = None;
        while attempt < max_attempts {
            attempt += 1;
            let result = match chosen_channel.as_str() {
                "email" => self.send_email("user@example.com", &subject, &body_text, &body_html, simulate_fail),
                "sms" => self.send_sms("1234567890", &body_text, simulate_fail),
                "in_app" => Ok(()),
                _ => Err("unknown_channel".to_string()),
            };
            match result {
                Ok(_) => {
                    let now = Utc::now();
                    self.log_notification(
                        &message_id,
                        user_id,
                        template_key,
                        &chosen_channel,
                        vars,
                        Some(now),
                        "sent",
                        None,
                    )?;
                    return Ok(SendResponse {
                        success: true,
                        message_id,
                        status: "sent".to_string(),
                    });
                }
                Err(e) => {
                    last_err = Some(e);
                    // Exponential backoff simulation: skip actual sleep
                }
            }
        }

        // After retries failed
        self.log_notification(
            &message_id,
            user_id,
            template_key,
            &chosen_channel,
            vars,
            None,
            "failed",
            last_err,
        )?;
        Ok(SendResponse {
            success: false,
            message_id,
            status: "failed".to_string(),
        })
    }

    pub fn send_batch_notifications(
        &self,
        requests: Vec<BatchRequest>,
    ) -> SqlResult<BatchSendResponse> {
        let mut sent = 0;
        let mut failed = 0;
        let mut message_ids = Vec::new();

        for req in requests {
            let resp = self.send_single_notification(
                req.user_id,
                &req.template_key,
                req.channel.as_deref(),
                &req.vars,
                req.scheduled_at,
            )?;
            if resp.status == "sent" || resp.status == "queued" {
                sent += 1;
            } else {
                failed += 1;
            }
            message_ids.push(resp.message_id);
        }

        Ok(BatchSendResponse {
            success: failed == 0,
            sent,
            failed,
            message_ids,
        })
    }

    pub fn track_message_status(&self, message_id: &str) -> SqlResult<TrackResponse> {
        let mut stmt = self.conn.prepare(
            "SELECT id, user_id, template_key, channel, sent_at, opened_at, clicked_at FROM notification_logs WHERE id = ?1",
        )?;
        let track = stmt.query_row(params![message_id], |row| {
            let sent_at: Option<String> = row.get(4)?;
            let opened_at: Option<String> = row.get(5)?;
            let clicked_at: Option<String> = row.get(6)?;
            Ok(TrackResponse {
                message_id: row.get(0)?,
                user_id: row.get(1)?,
                template_key: row.get(2)?,
                channel: row.get(3)?,
                status: if row.get::<_, Option<String>>(4)?.is_some() {
                    "sent".to_string()
                } else {
                    "queued".to_string()
                },
                sent_at: sent_at.map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
                opened_at: opened_at.map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
                clicked_at: clicked_at.map(|s| DateTime::parse_from_rfc3339(&s).unwrap().with_timezone(&Utc)),
            })
        })?;
        Ok(track)
    }

    pub fn mark_opened(&self, message_id: &str) -> SqlResult<()> {
        let now = Utc::now();
        self.conn.execute(
            "UPDATE notification_logs SET opened_at = ?1 WHERE id = ?2",
            params![now.to_rfc3339(), message_id],
        )?;
        Ok(())
    }

    pub fn mark_clicked(&self, message_id: &str) -> SqlResult<()> {
        let now = Utc::now();
        self.conn.execute(
            "UPDATE notification_logs SET clicked_at = ?1 WHERE id = ?2",
            params![now.to_rfc3339(), message_id],
        )?;
        Ok(())
    }

    pub fn get_user_preferences(&self, user_id: i64) -> SqlResult<UserNotificationPreferences> {
        self.load_user_preferences(user_id)
    }

    pub fn update_user_preferences(
        &self,
        user_id: i64,
        update: &UserNotificationPreferencesUpdate,
    ) -> SqlResult<()> {
        self.update_user_preferences(user_id, update)
    }

    pub fn unsubscribe_user(&self, user_id: i64) -> SqlResult<()> {
        self.update_user_preferences(
            user_id,
            &UserNotificationPreferencesUpdate {
                do_not_disturb: Some(true),
                quiet_hours_start: None,
                quiet_hours_end: None,
                channels_enabled: None,
            },
        )
    }
}

#[derive(Debug, Clone)]
pub struct BatchRequest {
    pub user_id: i64,
    pub template_key: String,
    pub channel: Option<String>,
    pub vars: HashMap<String, String>,
    pub scheduled_at: Option<DateTime<Utc>>,
}