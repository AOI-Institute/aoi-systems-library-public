use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, Result as SqlResult, NO_PARAMS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Pass,
    Challenge,
    Fail,
}

impl Decision {
    fn as_str(&self) -> &'static str {
        match self {
            Decision::Pass => "PASS",
            Decision::Challenge => "CHALLENGE",
            Decision::Fail => "FAIL",
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GateResult {
    pub gate_name: &'static str,
    pub decision: Decision,
    pub rule_inputs: Value,
    pub rule_outputs: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    pub message: String,
    pub code: u16,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChallengeResponse {
    pub success: bool,
    pub challenge: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub user_agent: String,
    pub screen_resolution: String,
    pub timezone: String,
    pub browser_language: String,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new_in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Ok(Self { conn })
    }

    fn migrate(conn: &Connection) -> SqlResult<()> {
        conn.execute_batch(
            "
            CREATE TABLE trial_abuse_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                email TEXT,
                stripe_payment_method_id TEXT,
                ip TEXT,
                device_fingerprint TEXT,
                signup_date TEXT,
                trial_started_at TEXT,
                payment_added_date TEXT,
                subscription_status TEXT,
                chargeback_count INTEGER,
                refund_count INTEGER,
                gate_flags TEXT,
                alert_reason TEXT,
                created_at TEXT
            );
            CREATE TABLE device_fingerprints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                device_hash TEXT,
                user_agent TEXT,
                screen_resolution TEXT,
                timezone TEXT,
                created_at TEXT
            );
            CREATE TABLE gate_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                gate_name TEXT,
                decision TEXT,
                rule_inputs TEXT,
                rule_outputs TEXT,
                created_at TEXT
            );
            CREATE TABLE signups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ip TEXT,
                created_at TEXT
            );
            CREATE TABLE stripe_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer TEXT,
                type TEXT
            );
            CREATE TABLE refunds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                status TEXT
            );
            ",
        )
    }

    fn log_gate_decision(
        &self,
        user_id: Option<i64>,
        gate_name: &str,
        decision: Decision,
        rule_inputs: &Value,
        rule_outputs: &Value,
    ) -> SqlResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO gate_decisions (user_id, gate_name, decision, rule_inputs, rule_outputs, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                user_id,
                gate_name,
                decision.as_str(),
                rule_inputs.to_string(),
                rule_outputs.to_string(),
                now
            ],
        )?;
        Ok(())
    }

    pub fn check_email_trial_history(
        &self,
        email: &str,
    ) -> SqlResult<GateResult> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM trial_abuse_ledger
                 WHERE email = ?1 AND subscription_status IN ('completed', 'chargebacked')",
                params![email],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let decision = if count == 0 {
            Decision::Pass
        } else if count == 1 {
            Decision::Challenge
        } else {
            Decision::Fail
        };
        let rule_inputs = json!({ "email": email, "prior_count": count });
        let rule_outputs = json!({ "decision": decision.as_str() });
        self.log_gate_decision(None, "email_trial_history", decision, &rule_inputs, &rule_outputs)?;
        Ok(GateResult {
            gate_name: "email_trial_history",
            decision,
            rule_inputs,
            rule_outputs,
        })
    }

    pub fn check_payment_method_history(
        &self,
        payment_id: &str,
    ) -> SqlResult<GateResult> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM trial_abuse_ledger
                 WHERE stripe_payment_method_id = ?1 AND subscription_status IN ('completed', 'chargebacked')",
                params![payment_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let decision = if count < 2 {
            Decision::Pass
        } else if count == 2 {
            Decision::Challenge
        } else {
            Decision::Fail
        };
        let rule_inputs = json!({ "payment_id": payment_id, "prior_count": count });
        let rule_outputs = json!({ "decision": decision.as_str() });
        self.log_gate_decision(None, "payment_method_history", decision, &rule_inputs, &rule_outputs)?;
        Ok(GateResult {
            gate_name: "payment_method_history",
            decision,
            rule_inputs,
            rule_outputs,
        })
    }

    pub fn check_ip_signup_rate_limit(
        &self,
        ip: &str,
    ) -> SqlResult<GateResult> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM signups
                 WHERE ip = ?1 AND created_at > datetime('now', '-24 hours')",
                params![ip],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let decision = if count < 5 {
            Decision::Pass
        } else if count < 10 {
            Decision::Challenge
        } else {
            Decision::Fail
        };
        let rule_inputs = json!({ "ip": ip, "count": count });
        let rule_outputs = json!({ "decision": decision.as_str() });
        self.log_gate_decision(None, "ip_signup_rate_limit", decision, &rule_inputs, &rule_outputs)?;
        Ok(GateResult {
            gate_name: "ip_signup_rate_limit",
            decision,
            rule_inputs,
            rule_outputs,
        })
    }

    fn device_hash(device: &DeviceInfo) -> String {
        let mut hasher = Sha256::new();
        hasher.update(device.user_agent.as_bytes());
        hasher.update(device.screen_resolution.as_bytes());
        hasher.update(device.timezone.as_bytes());
        hasher.update(device.browser_language.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    pub fn check_device_fingerprint(
        &self,
        device: &DeviceInfo,
        user_id: Option<i64>,
    ) -> SqlResult<GateResult> {
        let hash = Self::device_hash(device);
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(DISTINCT user_id) FROM device_fingerprints
                 WHERE device_hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let decision = if count < 2 {
            Decision::Pass
        } else if count <= 5 {
            Decision::Challenge
        } else {
            Decision::Fail
        };
        let rule_inputs = json!({ "device_hash": hash, "matching_users": count });
        let rule_outputs = json!({ "decision": decision.as_str() });
        self.log_gate_decision(user_id, "device_fingerprint", decision, &rule_inputs, &rule_outputs)?;
        Ok(GateResult {
            gate_name: "device_fingerprint",
            decision,
            rule_inputs,
            rule_outputs,
        })
    }

    pub fn check_trial_payment_timing(
        &self,
        user_id: i64,
        trial_days: i64,
    ) -> SqlResult<GateResult> {
        let row = self.conn.query_row(
            "SELECT trial_started_at, payment_added_date FROM trial_abuse_ledger
             WHERE user_id = ?1 ORDER BY trial_started_at DESC LIMIT 1",
            params![user_id],
            |row| {
                let trial_started_at: String = row.get(0)?;
                let payment_added_date: Option<String> = row.get(1)?;
                Ok((trial_started_at, payment_added_date))
            },
        );
        let (trial_started_at, payment_added_date) = match row {
            Ok(v) => v,
            Err(_) => return Ok(GateResult {
                gate_name: "trial_payment_timing",
                decision: Decision::Fail,
                rule_inputs: json!({ "user_id": user_id }),
                rule_outputs: json!({ "reason": "no_trial_record" }),
            }),
        };
        let trial_start: DateTime<Utc> = DateTime::parse_from_rfc3339(&trial_started_at)
            .unwrap()
            .with_timezone(&Utc);
        let now = Utc::now();
        let days_elapsed = (now - trial_start).num_days();
        let decision = if let Some(payment_date_str) = payment_added_date {
            let payment_date: DateTime<Utc> = DateTime::parse_from_rfc3339(&payment_date_str)
                .unwrap()
                .with_timezone(&Utc);
            if days_elapsed < trial_days + 5 && payment_date > trial_start {
                Decision::Pass
            } else if days_elapsed > trial_days + 30 && payment_date > trial_start + Duration::days(trial_days) {
                Decision::Challenge
            } else {
                Decision::Fail
            }
        } else {
            // No payment added
            if days_elapsed > trial_days + 90 {
                Decision::Fail
            } else {
                Decision::Pass
            }
        };
        let rule_inputs = json!({
            "trial_start_date": trial_started_at,
            "now": now.to_rfc3339(),
            "days_elapsed": days_elapsed,
            "payment_added_date": payment_added_date
        });
        let rule_outputs = json!({ "decision": decision.as_str() });
        self.log_gate_decision(Some(user_id), "trial_payment_timing", decision, &rule_inputs, &rule_outputs)?;
        Ok(GateResult {
            gate_name: "trial_payment_timing",
            decision,
            rule_inputs,
            rule_outputs,
        })
    }

    pub fn check_chargeback_history(
        &self,
        user_id: i64,
    ) -> SqlResult<GateResult> {
        let stripe_count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM stripe_events
                 WHERE customer = (SELECT stripe_customer_id FROM trial_abuse_ledger WHERE user_id = ?1 LIMIT 1)
                 AND type LIKE '%chargeback%'",
                params![user_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let refund_count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM refunds
                 WHERE user_id = ?1 AND status = 'chargebacked'",
                params![user_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let total = stripe_count + refund_count;
        let decision = if total == 0 {
            Decision::Pass
        } else if total == 1 {
            Decision::Challenge
        } else {
            Decision::Fail
        };
        let rule_inputs = json!({
            "stripe_count": stripe_count,
            "refund_count": refund_count,
            "total": total
        });
        let rule_outputs = json!({ "decision": decision.as_str() });
        self.log_gate_decision(Some(user_id), "chargeback_history", decision, &rule_inputs, &rule_outputs)?;
        Ok(GateResult {
            gate_name: "chargeback_history",
            decision,
            rule_inputs,
            rule_outputs,
        })
    }

    // Helper to insert a signup record for IP rate limiting tests
    pub fn insert_signup(&self, ip: &str) -> SqlResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO signups (ip, created_at) VALUES (?1, ?2)",
            params![ip, now],
        )?;
        Ok(())
    }

    // Helper to insert a trial abuse ledger record
    pub fn insert_trial_abuse_ledger(
        &self,
        user_id: Option<i64>,
        email: Option<&str>,
        stripe_payment_method_id: Option<&str>,
        ip: Option<&str>,
        device_fingerprint: Option<&str>,
        signup_date: Option<&str>,
        trial_started_at: Option<&str>,
        payment_added_date: Option<&str>,
        subscription_status: Option<&str>,
    ) -> SqlResult<()> {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO trial_abuse_ledger
             (user_id, email, stripe_payment_method_id, ip, device_fingerprint,
              signup_date, trial_started_at, payment_added_date,
              subscription_status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                user_id,
                email,
                stripe_payment_method_id,
                ip,
                device_fingerprint,
                signup_date,
                trial_started_at,
                payment_added_date,
                subscription_status,
                now
            ],
        )?;
        Ok(())
    }

    // Helper to insert a device fingerprint record
    pub fn insert_device_fingerprint(
        &self,
        user_id: i64,
        device: &DeviceInfo,
    ) -> SqlResult<()> {
        let hash = Self::device_hash(device);
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO device_fingerprints
             (user_id, device_hash, user_agent, screen_resolution, timezone, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                user_id,
                hash,
                device.user_agent,
                device.screen_resolution,
                device.timezone,
                now
            ],
        )?;
        Ok(())
    }

    // Helper to insert stripe event
    pub fn insert_stripe_event(
        &self,
        customer: &str,
        event_type: &str,
    ) -> SqlResult<()> {
        self.conn.execute(
            "INSERT INTO stripe_events (customer, type) VALUES (?1, ?2)",
            params![customer, event_type],
        )?;
        Ok(())
    }

    // Helper to insert refund
    pub fn insert_refund(
        &self,
        user_id: i64,
        status: &str,
    ) -> SqlResult<()> {
        self.conn.execute(
            "INSERT INTO refunds (user_id, status) VALUES (?1, ?2)",
            params![user_id, status],
        )?;
        Ok(())
    }
}