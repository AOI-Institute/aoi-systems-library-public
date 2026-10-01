use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::RwLock;
use tokio::time::timeout;
use uuid::Uuid;

use sqlx::{Pool, Postgres, Transaction, Executor, Row};
use stripe::{
    Client, Customer, Invoice, InvoiceId, PaymentIntent, PaymentIntentId, PriceId, Subscription,
    SubscriptionId, WebhookEvent,
};

#[derive(Debug, Error)]
pub enum BillingError {
    #[error("Invalid tier: {0}")]
    InvalidTier(String),
    #[error("Refund exceeds invoice amount")]
    RefundExceedsInvoice,
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Event already processed")]
    EventAlreadyProcessed,
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("Stripe error: {0}")]
    Stripe(#[from] stripe::Error),
    #[error("Internal error")]
    Internal,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubscriptionRecord {
    pub stripe_subscription_id: String,
    pub customer_id: String,
    pub tier: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub cancelled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InvoiceRecord {
    pub stripe_invoice_id: String,
    pub customer_id: String,
    pub amount: i64,
    pub status: String,
    pub paid_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RefundRecord {
    pub id: Uuid,
    pub invoice_id: String,
    pub amount: i64,
    pub status: String,
    pub reason: String,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
    pub executed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EventRecord {
    pub stripe_event_id: String,
    pub event_type: String,
    pub processed_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateSubscriptionRequest {
    pub customer_id: String,
    pub tier: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChangePlanRequest {
    pub subscription_id: String,
    pub new_tier: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueueRefundRequest {
    pub invoice_id: String,
    pub amount: i64,
    pub reason: String,
    pub created_by: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WebhookEventData {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WebhookRequest {
    pub id: String,
    pub r#type: String,
    pub data: serde_json::Value,
    pub signature: String,
}

pub struct BillingService {
    db_pool: Pool<Postgres>,
    stripe_client: Client,
    price_ids: Arc<RwLock<HashMap<String, String>>>,
}

impl BillingService {
    pub async fn new(db_pool: Pool<Postgres>) -> Result<Self, BillingError> {
        let stripe_secret_key = std::env::var("STRIPE_SECRET_KEY")
            .map_err(|_| BillingError::Internal)?;
        let stripe_client = Client::new(stripe_secret_key);

        let mut price_ids = HashMap::new();
        price_ids.insert("solo".to_string(), "price_1UI...".to_string());
        price_ids.insert("team".to_string(), "price_1UI...".to_string());
        price_ids.insert("enterprise".to_string(), "price_1UI...".to_string());

        Ok(Self {
            db_pool,
            stripe_client,
            price_ids: Arc::new(RwLock::new(price_ids)),
        })
    }

    pub async fn create_subscription(
        &self,
        request: CreateSubscriptionRequest,
    ) -> Result<serde_json::Value, BillingError> {
        let tier = request.tier.to_lowercase();
        let price_ids = self.price_ids.read().await;
        let price_id = price_ids
            .get(&tier)
            .ok_or_else(|| BillingError::InvalidTier(tier.clone()))?;

        let subscription = stripe::Subscription::create(
            &self.stripe_client,
            stripe::CreateSubscription {
                customer: Some(stripe::CustomerId::from_raw(&request.customer_id)),
                items: vec![stripe::NewSubscriptionItem {
                    price: Some(stripe::PriceId::from_raw(price_id)),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .await?;

        let subscription_id = subscription.id.to_string();
        let created_at = Utc::now();

        let mut tx = self.db_pool.begin().await?;

        sqlx::query!(
            r#"
            INSERT INTO subscriptions (
                stripe_subscription_id, customer_id, tier, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
            "#,
            subscription_id,
            request.customer_id,
            tier,
            "active",
            created_at,
            created_at
        )
        .execute(&mut tx)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO audit_log (action, customer_id, tier, stripe_sub_id)
            VALUES ($1, $2, $3, $4)
            "#,
            "subscription_created",
            request.customer_id,
            tier,
            subscription_id
        )
        .execute(&mut tx)
        .await?;

        tx.commit().await?;

        let response = serde_json::json!({
            "success": true,
            "subscription_id": subscription_id,
            "tier": tier,
            "status": "active",
            "next_billing_date": subscription.current_period_end
        });

        Ok(response)
    }

    pub async fn change_plan(
        &self,
        request: ChangePlanRequest,
    ) -> Result<serde_json::Value, BillingError> {
        let new_tier = request.new_tier.to_lowercase();
        let price_ids = self.price_ids.read().await;
        let new_price_id = price_ids
            .get(&new_tier)
            .ok_or_else(|| BillingError::InvalidTier(new_tier.clone()))?;

        let mut tx = self.db_pool.begin().await?;

        let old_record: SubscriptionRecord = sqlx::query_as!(
            SubscriptionRecord,
            r#"
            SELECT * FROM subscriptions WHERE stripe_subscription_id = $1
            "#,
            request.subscription_id
        )
        .fetch_one(&mut tx)
        .await?;

        let old_tier = old_record.tier;

        let subscription = stripe::Subscription::update(
            &self.stripe_client,
            &stripe::SubscriptionId::from_raw(&request.subscription_id),
            stripe::UpdateSubscription {
                items: vec![stripe::UpdateSubscriptionItem {
                    id: None,
                    price: Some(stripe::PriceId::from_raw(new_price_id)),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .await?;

        sqlx::query!(
            r#"
            UPDATE subscriptions
            SET tier = $1, updated_at = $2
            WHERE stripe_subscription_id = $3
            "#,
            new_tier,
            Utc::now(),
            request.subscription_id
        )
        .execute(&mut tx)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO audit_log (action, subscription_id, old_tier, new_tier, proration_credits)
            VALUES ($1, $2, $3, $4, $5)
            "#,
            "plan_changed",
            request.subscription_id,
            old_tier,
            new_tier,
            subscription.pending_invoice_item_interval
        )
        .execute(&mut tx)
        .await?;

        tx.commit().await?;

        let response = serde_json::json!({
            "success": true,
            "subscription_id": request.subscription_id,
            "old_tier": old_tier,
            "new_tier": new_tier,
            "effective_date": subscription.current_period_start,
            "proration_credit": subscription.pending_invoice_item_interval
        });

        Ok(response)
    }

    pub async fn queue_refund(
        &self,
        request: QueueRefundRequest,
    ) -> Result<serde_json::Value, BillingError> {
        let mut tx = self.db_pool.begin().await?;

        let invoice: InvoiceRecord = sqlx::query_as!(
            InvoiceRecord,
            r#"
            SELECT * FROM invoices WHERE stripe_invoice_id = $1
            "#,
            request.invoice_id
        )
        .fetch_one(&mut tx)
        .await?;

        if invoice.status != "succeeded" {
            return Err(BillingError::Internal);
        }

        if request.amount > invoice.amount {
            return Err(BillingError::RefundExceedsInvoice);
        }

        let refund_id = Uuid::new_v4();
        let created_at = Utc::now();

        sqlx::query!(
            r#"
            INSERT INTO refunds (
                id, invoice_id, amount, status, reason, created_by, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
            refund_id,
            request.invoice_id,
            request.amount,
            "queued",
            request.reason,
            request.created_by,
            created_at
        )
        .execute(&mut tx)
        .await?;

        sqlx::query!(
            r#"
            INSERT INTO audit_log (action, invoice_id, amount, reason)
            VALUES ($1, $2, $3, $4)
            "#,
            "refund_queued",
            request.invoice_id,
            request.amount,
            request.reason
        )
        .execute(&mut tx)
        .await?;

        tx.commit().await?;

        let response = serde_json::json!({
            "success": true,
            "refund_id": refund_id.to_string(),
            "status": "queued",
            "amount": request.amount,
            "reason": request.reason
        });

        Ok(response)
    }

    pub async fn handle_stripe_webhook(
        &self,
        request: WebhookRequest,
    ) -> Result<serde_json::Value, BillingError> {
        let webhook_secret = std::env::var("STRIPE_WEBHOOK_SECRET")
            .map_err(|_| BillingError::Internal)?;

        let event = WebhookEvent::construct_event(
            &request.signature,
            &request.data.to_string(),
            &webhook_secret,
        )
        .map_err(|_| BillingError::InvalidSignature)?;

        let event_id = event.id.to_string();
        let event_type = event.type_.to_string();

        let mut tx = self.db_pool.begin().await?;

        let processed = sqlx::query!(
            r#"
            SELECT COUNT(*) as count FROM events WHERE stripe_event_id = $1
            "#,
            event_id
        )
        .fetch_one(&mut tx)
        .await?
        .count;

        if processed > 0 {
            tx.commit().await?;
            return Ok(serde_json::json!({"received": true}));
        }

        match event_type.as_str() {
            "invoice.payment_succeeded" => {
                let invoice_data = event.data.object.as_object().unwrap();
                let invoice_id = invoice_data["id"].as_str().unwrap().to_string();
                let customer_id = invoice_data["customer"].as_str().unwrap().to_string();
                let amount = invoice_data["amount_paid"].as_i64().unwrap_or(0);

                sqlx::query!(
                    r#"
                    INSERT INTO invoices (
                        stripe_invoice_id, customer_id, amount, status, paid_at
                    ) VALUES ($1, $2, $3, $4, $5)
                    "#,
                    invoice_id,
                    customer_id,
                    amount,
                    "succeeded",
                    Utc::now()
                )
                .execute(&mut tx)
                .await?;

                sqlx::query!(
                    r#"
                    INSERT INTO audit_log (action, customer_id, invoice_id, amount)
                    VALUES ($1, $2, $3, $4)
                    "#,
                    "payment_succeeded",
                    customer_id,
                    invoice_id,
                    amount
                )
                .execute(&mut tx)
                .await?;
            }
            "invoice.payment_failed" => {
                let invoice_data = event.data.object.as_object().unwrap();
                let customer_id = invoice_data["customer"].as_str().unwrap().to_string();
                let invoice_id = invoice_data["id"].as_str().unwrap().to_string();
                let reason = invoice_data["status"].as_str().unwrap_or("unknown").to_string();

                sqlx::query!(
                    r#"
                    UPDATE subscriptions
                    SET status = 'past_due'
                    WHERE customer_id = $1 AND status != 'cancelled'
                    "#,
                    customer_id
                )
                .execute(&mut tx)
                .await?;

                sqlx::query!(
                    r#"
                    INSERT INTO audit_log (action, customer_id, invoice_id, reason)
                    VALUES ($1, $2, $3, $4)
                    "#,
                    "payment_failed",
                    customer_id,
                    invoice_id,
                    reason
                )
                .execute(&mut tx)
                .await?;
            }
            "customer.subscription.updated" => {
                let subscription_data = event.data.object.as_object().unwrap();
                let customer_id = subscription_data["customer"].as_str().unwrap().to_string();
                let subscription_id = subscription_data["id"].as_str().unwrap().to_string();
                let old_tier = subscription_data["items"]["data"][0]["price"]["lookup_key"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let new_tier = subscription_data["items"]["data"][0]["price"]["lookup_key"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let status = subscription_data["status"].as_str().unwrap_or("unknown").to_string();

                sqlx::query!(
                    r#"
                    UPDATE subscriptions
                    SET tier = $1, status = $2, updated_at = $3
                    WHERE stripe_subscription_id = $4
                    "#,
                    new_tier,
                    status,
                    Utc::now(),
                    subscription_id
                )
                .execute(&mut tx)
                .await?;

                sqlx::query!(
                    r#"
                    INSERT INTO audit_log (action, customer_id, old_tier, new_tier)
                    VALUES ($1, $2, $3, $4)
                    "#,
                    "subscription_updated",
                    customer_id,
                    old_tier,
                    new_tier
                )
                .execute(&mut tx)
                .await?;
            }
            "customer.subscription.deleted" => {
                let subscription_data = event.data.object.as_object().unwrap();
                let customer_id = subscription_data["customer"].as_str().unwrap().to_string();
                let subscription_id = subscription_data["id"].as_str().unwrap().to_string();

                sqlx::query!(
                    r#"
                    UPDATE subscriptions
                    SET status = 'cancelled', cancelled_at = $1
                    WHERE stripe_subscription_id = $2
                    "#,
                    Utc::now(),
                    subscription_id
                )
                .execute(&mut tx)
                .await?;

                sqlx::query!(
                    r#"
                    INSERT INTO audit_log (action, customer_id)
                    VALUES ($1, $2)
                    "#,
                    "subscription_cancelled",
                    customer_id
                )
                .execute(&mut tx)
                .await?;
            }
            _ => {}
        }

        sqlx::query!(
            r#"
            INSERT INTO events (stripe_event_id, event_type, processed_at)
            VALUES ($1, $2, $3)
            "#,
            event_id,
            event_type,
            Utc::now()
        )
        .execute(&mut tx)
        .await?;

        tx.commit().await?;

        Ok(serde_json::json!({"received": true}))
    }

    pub async fn run_migrations(&self) -> Result<(), BillingError> {
        let sql = r#"
        CREATE TABLE IF NOT EXISTS subscriptions (
            stripe_subscription_id VARCHAR(255) PRIMARY KEY,
            customer_id VARCHAR(255) NOT NULL,
            tier VARCHAR(50) NOT NULL,
            status VARCHAR(50) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            cancelled_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS invoices (
            stripe_invoice_id VARCHAR(255) PRIMARY KEY,
            customer_id VARCHAR(255) NOT NULL,
            amount BIGINT NOT NULL,
            status VARCHAR(50) NOT NULL,
            paid_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS refunds (
            id UUID PRIMARY KEY,
            invoice_id VARCHAR(255) NOT NULL,
            amount BIGINT NOT NULL,
            status VARCHAR(50) NOT NULL,
            reason TEXT NOT NULL,
            created_by VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            executed_at TIMESTAMP WITH TIME ZONE
        );

        CREATE TABLE IF NOT EXISTS events (
            stripe_event_id VARCHAR(255) PRIMARY KEY,
            event_type VARCHAR(100) NOT NULL,
            processed_at TIMESTAMP WITH TIME ZONE NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id SERIAL PRIMARY KEY,
            action VARCHAR(100) NOT NULL,
            customer_id VARCHAR(255),
            subscription_id VARCHAR(255),
            invoice_id VARCHAR(255),
            amount BIGINT,
            reason TEXT,
            old_tier VARCHAR(50),
            new_tier VARCHAR(50),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
        "#;

        self.db_pool.execute(sql).await?;
        Ok(())
    }
}