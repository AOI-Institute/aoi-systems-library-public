use super::*;
use mockall::{automock, predicate::*};
use stripe::{Client, MockStripe};
use sqlx::PgPool;
use tokio::time::{sleep, Duration};

#[tokio::test]
async fn test_create_subscription_happy_path() {
    let mut mock_db = MockDb::new();
    let mut mock_stripe = MockStripe::new();
    
    let subscription = stripe::Subscription {
        id: stripe::SubscriptionId::from_raw("sub_123"),
        current_period_end: 1234567890,
        ..Default::default()
    };
    
    mock_stripe
        .expect_create_subscription()
        .return_once(|_| Ok(subscription));
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO subscriptions"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO audit_log"))
        .times(1)
        .return_ok();
    
    let service = BillingService::new(mock_db, mock_stripe);
    let request = CreateSubscriptionRequest {
        customer_id: "cust_123".to_string(),
        tier: "solo".to_string(),
    };
    
    let result = service.create_subscription(request).await;
    assert!(result.is_ok());
    let response = result.unwrap();
    assert_eq!(response["success"], true);
    assert_eq!(response["subscription_id"], "sub_123");
    assert_eq!(response["tier"], "solo");
    assert_eq!(response["status"], "active");
}

#[tokio::test]
async fn test_create_subscription_invalid_tier() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let service = BillingService::new(mock_db, mock_stripe);
    let request = CreateSubscriptionRequest {
        customer_id: "cust_123".to_string(),
        tier: "invalid".to_string(),
    };
    
    let result = service.create_subscription(request).await;
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), BillingError::InvalidTier(_)));
}

#[tokio::test]
async fn test_change_plan_happy_path() {
    let mut mock_db = MockDb::new();
    let mut mock_stripe = MockStripe::new();
    
    let old_record = SubscriptionRecord {
        stripe_subscription_id: "sub_123".to_string(),
        customer_id: "cust_123".to_string(),
        tier: "solo".to_string(),
        status: "active".to_string(),
        created_at: Utc::now(),
        updated_at: Utc::now(),
        cancelled_at: None,
    };
    
    mock_db
        .expect_query_as()
        .with(sqlx::query_as!(SubscriptionRecord, "SELECT * FROM subscriptions WHERE stripe_subscription_id = $1", "sub_123"))
        .return_once(|_| Ok(old_record));
    
    let subscription = stripe::Subscription {
        id: stripe::SubscriptionId::from_raw("sub_123"),
        current_period_start: 1234567890,
        pending_invoice_item_interval: Some("month".to_string()),
        ..Default::default()
    };
    
    mock_stripe
        .expect_update_subscription()
        .return_once(|_| Ok(subscription));
    
    mock_db
        .expect_query()
        .with(sqlx::query!("UPDATE subscriptions SET tier = $1, updated_at = $2 WHERE stripe_subscription_id = $3", "team", any(), "sub_123"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO audit_log"))
        .times(1)
        .return_ok();
    
    let service = BillingService::new(mock_db, mock_stripe);
    let request = ChangePlanRequest {
        subscription_id: "sub_123".to_string(),
        new_tier: "team".to_string(),
    };
    
    let result = service.change_plan(request).await;
    assert!(result.is_ok());
    let response = result.unwrap();
    assert_eq!(response["success"], true);
    assert_eq!(response["subscription_id"], "sub_123");
    assert_eq!(response["old_tier"], "solo");
    assert_eq!(response["new_tier"], "team");
}

#[tokio::test]
async fn test_queue_refund_happy_path() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let invoice = InvoiceRecord {
        stripe_invoice_id: "inv_123".to_string(),
        customer_id: "cust_123".to_string(),
        amount: 10000,
        status: "succeeded".to_string(),
        paid_at: Some(Utc::now()),
    };
    
    mock_db
        .expect_query_as()
        .with(sqlx::query_as!(InvoiceRecord, "SELECT * FROM invoices WHERE stripe_invoice_id = $1", "inv_123"))
        .return_once(|_| Ok(invoice));
    
    let refund_id = Uuid::new_v4();
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO refunds"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO audit_log"))
        .times(1)
        .return_ok();
    
    let service = BillingService::new(mock_db, mock_stripe);
    let request = QueueRefundRequest {
        invoice_id: "inv_123".to_string(),
        amount: 5000,
        reason: "duplicate".to_string(),
        created_by: "admin".to_string(),
    };
    
    let result = service.queue_refund(request).await;
    assert!(result.is_ok());
    let response = result.unwrap();
    assert_eq!(response["success"], true);
    assert_eq!(response["status"], "queued");
    assert_eq!(response["amount"], 5000);
}

#[tokio::test]
async fn test_queue_refund_amount_exceeds_invoice() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let invoice = InvoiceRecord {
        stripe_invoice_id: "inv_123".to_string(),
        customer_id: "cust_123".to_string(),
        amount: 10000,
        status: "succeeded".to_string(),
        paid_at: Some(Utc::now()),
    };
    
    mock_db
        .expect_query_as()
        .with(sqlx::query_as!(InvoiceRecord, "SELECT * FROM invoices WHERE stripe_invoice_id = $1", "inv_123"))
        .return_once(|_| Ok(invoice));
    
    let service = BillingService::new(mock_db, mock_stripe);
    let request = QueueRefundRequest {
        invoice_id: "inv_123".to_string(),
        amount: 15000,
        reason: "duplicate".to_string(),
        created_by: "admin".to_string(),
    };
    
    let result = service.queue_refund(request).await;
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), BillingError::RefundExceedsInvoice));
}

#[tokio::test]
async fn test_handle_webhook_payment_succeeded() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let event_data = serde_json::json!({
        "id": "evt_123",
        "type": "invoice.payment_succeeded",
        "data": {
            "object": {
                "id": "inv_123",
                "customer": "cust_123",
                "amount_paid": 10000
            }
        }
    });
    
    let webhook_request = WebhookRequest {
        id: "evt_123".to_string(),
        r#type: "invoice.payment_succeeded".to_string(),
        data: event_data,
        signature: "valid_signature".to_string(),
    };
    
    mock_db
        .expect_query()
        .with(sqlx::query!("SELECT COUNT(*) as count FROM events WHERE stripe_event_id = $1", "evt_123"))
        .return_once(|_| Ok(0));
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO invoices"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO audit_log"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO events"))
        .times(1)
        .return_ok();
    
    let service = BillingService::new(mock_db, mock_stripe);
    let result = service.handle_stripe_webhook(webhook_request).await;
    assert!(result.is_ok());
    let response = result.unwrap();
    assert_eq!(response["received"], true);
}

#[tokio::test]
async fn test_handle_webhook_duplicate_event() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let event_data = serde_json::json!({
        "id": "evt_123",
        "type": "invoice.payment_succeeded",
        "data": {
            "object": {
                "id": "inv_123",
                "customer": "cust_123",
                "amount_paid": 10000
            }
        }
    });
    
    let webhook_request = WebhookRequest {
        id: "evt_123".to_string(),
        r#type: "invoice.payment_succeeded".to_string(),
        data: event_data,
        signature: "valid_signature".to_string(),
    };
    
    mock_db
        .expect_query()
        .with(sqlx::query!("SELECT COUNT(*) as count FROM events WHERE stripe_event_id = $1", "evt_123"))
        .return_once(|_| Ok(1));
    
    let service = BillingService::new(mock_db, mock_stripe);
    let result = service.handle_stripe_webhook(webhook_request).await;
    assert!(result.is_ok());
    let response = result.unwrap();
    assert_eq!(response["received"], true);
}

#[tokio::test]
async fn test_handle_webhook_subscription_updated() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let event_data = serde_json::json!({
        "id": "evt_123",
        "type": "customer.subscription.updated",
        "data": {
            "object": {
                "id": "sub_123",
                "customer": "cust_123",
                "items": {
                    "data": [{
                        "price": {
                            "lookup_key": "team"
                        }
                    }]
                },
                "status": "active"
            }
        }
    });
    
    let webhook_request = WebhookRequest {
        id: "evt_123".to_string(),
        r#type: "customer.subscription.updated".to_string(),
        data: event_data,
        signature: "valid_signature".to_string(),
    };
    
    mock_db
        .expect_query()
        .with(sqlx::query!("SELECT COUNT(*) as count FROM events WHERE stripe_event_id = $1", "evt_123"))
        .return_once(|_| Ok(0));
    
    mock_db
        .expect_query()
        .with(sqlx::query!("UPDATE subscriptions SET tier = $1, status = $2, updated_at = $3 WHERE stripe_subscription_id = $4", "team", "active", any(), "sub_123"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO audit_log"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO events"))
        .times(1)
        .return_ok();
    
    let service = BillingService::new(mock_db, mock_stripe);
    let result = service.handle_stripe_webhook(webhook_request).await;
    assert!(result.is_ok());
    let response = result.unwrap();
    assert_eq!(response["received"], true);
}

#[tokio::test]
async fn test_webhook_response_time() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let event_data = serde_json::json!({
        "id": "evt_123",
        "type": "invoice.payment_succeeded",
        "data": {
            "object": {
                "id": "inv_123",
                "customer": "cust_123",
                "amount_paid": 10000
            }
        }
    });
    
    let webhook_request = WebhookRequest {
        id: "evt_123".to_string(),
        r#type: "invoice.payment_succeeded".to_string(),
        data: event_data,
        signature: "valid_signature".to_string(),
    };
    
    mock_db
        .expect_query()
        .with(sqlx::query!("SELECT COUNT(*) as count FROM events WHERE stripe_event_id = $1", "evt_123"))
        .return_once(|_| Ok(0));
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO invoices"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO audit_log"))
        .times(1)
        .return_ok();
    
    mock_db
        .expect_query()
        .with(sqlx::query!("INSERT INTO events"))
        .times(1)
        .return_ok();
    
    let service = BillingService::new(mock_db, mock_stripe);
    
    let start = std::time::Instant::now();
    let result = service.handle_stripe_webhook(webhook_request).await;
    let duration = start.elapsed();
    
    assert!(result.is_ok());
    assert!(duration < Duration::from_secs(3));
    let response = result.unwrap();
    assert_eq!(response["received"], true);
}

#[tokio::test]
async fn test_webhook_signature_invalid() {
    let mut mock_db = MockDb::new();
    let mock_stripe = MockStripe::new();
    
    let event_data = serde_json::json!({
        "id": "evt_123",
        "type": "invoice.payment_succeeded",
        "data": {
            "object": {
                "id": "inv_123",
                "customer": "cust_123",
                "amount_paid": 10000
            }
        }
    });
    
    let webhook_request = WebhookRequest {
        id: "evt_123".to_string(),
        r#type: "invoice.payment_succeeded".to_string(),
        data: event_data,
        signature: "invalid_signature".to_string(),
    };
    
    let service = BillingService::new(mock_db, mock_stripe);
    let result = service.handle_stripe_webhook(webhook_request).await;
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), BillingError::InvalidSignature));
}