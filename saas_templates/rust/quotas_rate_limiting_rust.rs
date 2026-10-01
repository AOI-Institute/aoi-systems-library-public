use chrono::{Datelike, NaiveDateTime, Utc};
use serde_json::json;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool, Row};
use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tier {
    Solo,
    Team,
    Enterprise,
}

impl Tier {
    fn as_str(&self) -> &'static str {
        match self {
            Tier::Solo => "solo",
            Tier::Team => "team",
            Tier::Enterprise => "enterprise",
        }
    }
}

#[derive(Debug)]
pub struct User {
    pub id: i64,
    pub tier: Tier,
}

#[derive(Debug)]
pub enum QuotaError {
    QuotaExceeded {
        current: u64,
        limit: u64,
        reset_date: String,
    },
    StorageQuotaExceeded {
        usage: u64,
        limit: u64,
    },
    RateLimitExceeded {
        reset_seconds: u64,
    },
    IpRateLimitExceeded {
        reset_seconds: u64,
    },
    FeatureNotAvailable {
        tier: Tier,
        minimum_tier: Tier,
        upgrade_url: String,
    },
}

impl fmt::Display for QuotaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QuotaError::QuotaExceeded { current, limit, reset_date } => {
                write!(
                    f,
                    "{{\"error\":\"quota_exceeded\",\"current\":{},\"limit\":{},\"reset_date\":\"{}\"}}",
                    current, limit, reset_date
                )
            }
            QuotaError::StorageQuotaExceeded { usage, limit } => {
                write!(
                    f,
                    "{{\"error\":\"storage_quota_exceeded\",\"usage\":{},\"limit\":{}}}",
                    usage, limit
                )
            }
            QuotaError::RateLimitExceeded { reset_seconds } => {
                write!(
                    f,
                    "{{\"error\":\"rate_limit_exceeded\",\"reset_seconds\":{}}}",
                    reset_seconds
                )
            }
            QuotaError::IpRateLimitExceeded { reset_seconds } => {
                write!(
                    f,
                    "{{\"error\":\"ip_rate_limit_exceeded\",\"reset_seconds\":{}}}",
                    reset_seconds
                )
            }
            QuotaError::FeatureNotAvailable {
                tier,
                minimum_tier,
                upgrade_url,
            } => {
                write!(
                    f,
                    "{{\"error\":\"feature_not_available\",\"tier\":\"{}\",\"minimum_tier\":\"{}\",\"upgrade_url\":\"{}\"}}",
                    tier.as_str(),
                    minimum_tier.as_str(),
                    upgrade_url
                )
            }
        }
    }
}

pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS usage_metrics (
            user_id INTEGER NOT NULL,
            month TEXT NOT NULL,
            call_count INTEGER NOT NULL DEFAULT 0,
            storage_bytes INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_id, month)
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS api_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            ip TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            response_time_ms INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

fn current_month() -> String {
    let now = Utc::now();
    format!("{}-{:02}", now.year(), now.month())
}

fn month_start_date() -> NaiveDateTime {
    let now = Utc::now();
    NaiveDateTime::new(
        chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1).unwrap(),
        chrono::NaiveTime::from_hms_opt(0, 0, 0).unwrap(),
    )
}

fn month_end_date() -> NaiveDateTime {
    let now = Utc::now();
    let last_day = chrono::naive::MAX_DAYS_IN_MONTH[now.month() as usize - 1];
    NaiveDateTime::new(
        chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), last_day).unwrap(),
        chrono::NaiveTime::from_hms_opt(23, 59, 59).unwrap(),
    )
}

fn get_limits(tier: Tier) -> (Option<u64>, Option<u64>) {
    match tier {
        Tier::Solo => (Some(1_000), Some(1_000_000_000)),
        Tier::Team => (Some(10_000), Some(100_000_000_000)),
        Tier::Enterprise => (None, None),
    }
}

pub async fn check_api_quota(
    pool: &SqlitePool,
    user: &User,
) -> Result<(), QuotaError> {
    let month = current_month();
    let row = sqlx::query(
        r#"
        SELECT call_count FROM usage_metrics
        WHERE user_id = ? AND month = ?
        "#,
    )
    .bind(user.id)
    .bind(&month)
    .fetch_optional(pool)
    .await
    .map_err(|_| {
        QuotaError::QuotaExceeded {
            current: 0,
            limit: 0,
            reset_date: month_end_date().to_string(),
        }
    })?;

    let current_usage = row
        .map(|r| r.get::<i64, _>("call_count") as u64)
        .unwrap_or(0);

    let (limit_opt, _) = get_limits(user.tier);
    if let Some(limit) = limit_opt {
        if current_usage + 1 > limit {
            return Err(QuotaError::QuotaExceeded {
                current: current_usage,
                limit,
                reset_date: month_end_date().to_string(),
            });
        }
    }

    // Increment usage
    if row.is_some() {
        sqlx::query(
            r#"
            UPDATE usage_metrics
            SET call_count = call_count + 1, updated_at = ?
            WHERE user_id = ? AND month = ?
            "#,
        )
        .bind(Utc::now().to_string())
        .bind(user.id)
        .bind(&month)
        .execute(pool)
        .await
        .map_err(|_| {
            QuotaError::QuotaExceeded {
                current: current_usage,
                limit: limit_opt.unwrap_or(0),
                reset_date: month_end_date().to_string(),
            }
        })?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO usage_metrics (user_id, month, call_count, storage_bytes, updated_at)
            VALUES (?, ?, 1, 0, ?)
            "#,
        )
        .bind(user.id)
        .bind(&month)
        .bind(Utc::now().to_string())
        .execute(pool)
        .await
        .map_err(|_| {
            QuotaError::QuotaExceeded {
                current: current_usage,
                limit: limit_opt.unwrap_or(0),
                reset_date: month_end_date().to_string(),
            }
        })?;
    }

    Ok(())
}

pub async fn check_storage_quota(
    pool: &SqlitePool,
    user: &User,
    incoming_size: u64,
) -> Result<(), QuotaError> {
    let row = sqlx::query(
        r#"
        SELECT storage_bytes FROM usage_metrics
        WHERE user_id = ?
        "#,
    )
    .bind(user.id)
    .fetch_optional(pool)
    .await
    .map_err(|_| QuotaError::StorageQuotaExceeded { usage: 0, limit: 0 })?;

    let current_storage = row
        .map(|r| r.get::<i64, _>("storage_bytes") as u64)
        .unwrap_or(0);

    let (_, limit_opt) = get_limits(user.tier);
    if let Some(limit) = limit_opt {
        if current_storage + incoming_size > limit {
            return Err(QuotaError::StorageQuotaExceeded {
                usage: current_storage,
                limit,
            });
        }
    }

    // Update storage usage
    if row.is_some() {
        sqlx::query(
            r#"
            UPDATE usage_metrics
            SET storage_bytes = storage_bytes + ?, updated_at = ?
            WHERE user_id = ?
            "#,
        )
        .bind(incoming_size as i64)
        .bind(Utc::now().to_string())
        .bind(user.id)
        .execute(pool)
        .await
        .map_err(|_| QuotaError::StorageQuotaExceeded { usage: current_storage, limit: limit_opt.unwrap_or(0) })?;
    } else {
        sqlx::query(
            r#"
            INSERT INTO usage_metrics (user_id, month, call_count, storage_bytes, updated_at)
            VALUES (?, ?, 0, ?, ?)
            "#,
        )
        .bind(user.id)
        .bind(&current_month())
        .bind(incoming_size as i64)
        .bind(Utc::now().to_string())
        .execute(pool)
        .await
        .map_err(|_| QuotaError::StorageQuotaExceeded { usage: current_storage, limit: limit_opt.unwrap_or(0) })?;
    }

    Ok(())
}

pub async fn check_rate_limit_per_user(
    pool: &SqlitePool,
    user: &User,
) -> Result<(), QuotaError> {
    let one_min_ago = Utc::now() - chrono::Duration::minutes(1);
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM api_calls
        WHERE user_id = ? AND timestamp > ?
        "#,
    )
    .bind(user.id)
    .bind(one_min_ago.to_string())
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    if count >= 100 {
        return Err(QuotaError::RateLimitExceeded { reset_seconds: 60 });
    }

    Ok(())
}

pub async fn check_rate_limit_per_ip(
    pool: &SqlitePool,
    ip: &str,
) -> Result<(), QuotaError> {
    let one_sec_ago = Utc::now() - chrono::Duration::seconds(1);
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM api_calls
        WHERE ip = ? AND timestamp > ?
        "#,
    )
    .bind(ip)
    .bind(one_sec_ago.to_string())
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    if count >= 10 {
        return Err(QuotaError::IpRateLimitExceeded { reset_seconds: 1 });
    }

    Ok(())
}

pub async fn check_feature_gate(
    user: &User,
    feature: &str,
) -> Result<(), QuotaError> {
    let feature_map: HashMap<&str, Vec<Tier>> = [
        ("feature_a", vec![Tier::Team, Tier::Enterprise]),
        ("feature_b", vec![Tier::Enterprise]),
        ("feature_c", vec![Tier::Solo, Tier::Team, Tier::Enterprise]),
    ]
    .iter()
    .cloned()
    .collect();

    let allowed = feature_map
        .get(feature)
        .map(|tiers| tiers.contains(&user.tier))
        .unwrap_or(false);

    if !allowed {
        let minimum_tier = feature_map
            .get(feature)
            .and_then(|tiers| tiers.first())
            .cloned()
            .unwrap_or(Tier::Enterprise);
        return Err(QuotaError::FeatureNotAvailable {
            tier: user.tier,
            minimum_tier,
            upgrade_url: "https://example.com/upgrade".to_string(),
        });
    }

    Ok(())
}

pub async fn record_api_call(
    pool: &SqlitePool,
    user: &User,
    ip: &str,
    endpoint: &str,
    status_code: u16,
    response_time_ms: u64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO api_calls (user_id, ip, endpoint, timestamp, status_code, response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(user.id)
    .bind(ip)
    .bind(endpoint)
    .bind(Utc::now().to_string())
    .bind(status_code as i64)
    .bind(response_time_ms as i64)
    .execute(pool)
    .await
    .map(|_| ())
}