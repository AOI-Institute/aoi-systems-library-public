use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub id: String,
    pub org_id: String,
    pub url: String,
    pub secret: String,
    pub event_types: Vec<String>,
    pub active: bool,
    pub failure_count: i32,
    pub created_at: SystemTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub org_id: String,
    pub event_type: String,
    pub payload: Value,
    pub created_at: SystemTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delivery {
    pub id: String,
    pub message_id: String,
    pub endpoint_id: String,
    pub attempt: i32,
    pub status_code: Option<u16>,
    pub success: bool,
    pub error: Option<String>,
    pub next_attempt_at: Option<SystemTime>,
    pub delivered_at: Option<SystemTime>,
}

#[derive(Debug)]
pub enum WebhookError {
    SignatureMismatch,
    TimestampOutOfRange,
    InvalidHeader,
    InvalidSecret,
    EndpointNotFound,
    MessageNotFound,
    DeliveryNotFound,
    StoreError,
}
impl fmt::Display for WebhookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}
impl Error for WebhookError {}

pub trait Store: Send + Sync {
    fn create_endpoint(
        &self,
        org_id: &str,
        url: &str,
        event_types: &[String],
    ) -> Result<(String, String), Box<dyn Error>>;
    fn get_endpoint(&self, id: &str) -> Option<Endpoint>;
    fn update_endpoint(&self, endpoint: Endpoint) -> Result<(), Box<dyn Error>>;
    fn create_message(&self, org_id: &str, event_type: &str, payload: Value) -> Result<String, Box<dyn Error>>;
    fn get_message(&self, id: &str) -> Option<Message>;
    fn create_delivery(&self, delivery: Delivery) -> Result<(), Box<dyn Error>>;
    fn get_delivery(&self, id: &str) -> Option<Delivery>;
    fn update_delivery(&self, delivery: Delivery) -> Result<(), Box<dyn Error>>;
    fn list_active_endpoints(&self, org_id: &str, event_type: &str) -> Vec<Endpoint>;
}

#[derive(Clone)]
pub struct InMemoryStore {
    endpoints: Arc<Mutex<HashMap<String, Endpoint>>>,
    messages: Arc<Mutex<HashMap<String, Message>>>,
    deliveries: Arc<Mutex<HashMap<String, Delivery>>>,
}
impl InMemoryStore {
    pub fn new() -> Self {
        Self {
            endpoints: Arc::new(Mutex::new(HashMap::new())),
            messages: Arc::new(Mutex::new(HashMap::new())),
            deliveries: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
impl Store for InMemoryStore {
    fn create_endpoint(
        &self,
        org_id: &str,
        url: &str,
        event_types: &[String],
    ) -> Result<(String, String), Box<dyn Error>> {
        let id = Uuid::new_v4().to_string();
        let mut secret_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut secret_bytes);
        let secret = format!("whsec_{}", STANDARD.encode(&secret_bytes));
        let endpoint = Endpoint {
            id: id.clone(),
            org_id: org_id.to_string(),
            url: url.to_string(),
            secret: secret.clone(),
            event_types: event_types.to_vec(),
            active: true,
            failure_count: 0,
            created_at: SystemTime::now(),
        };
        self.endpoints.lock().unwrap().insert(id.clone(), endpoint);
        Ok((id, secret))
    }
    fn get_endpoint(&self, id: &str) -> Option<Endpoint> {
        self.endpoints.lock().unwrap().get(id).cloned()
    }
    fn update_endpoint(&self, endpoint: Endpoint) -> Result<(), Box<dyn Error>> {
        self.endpoints
            .lock()
            .unwrap()
            .insert(endpoint.id.clone(), endpoint);
        Ok(())
    }
    fn create_message(&self, org_id: &str, event_type: &str, payload: Value) -> Result<String, Box<dyn Error>> {
        let id = format!("msg_{}", Uuid::new_v4());
        let message = Message {
            id: id.clone(),
            org_id: org_id.to_string(),
            event_type: event_type.to_string(),
            payload,
            created_at: SystemTime::now(),
        };
        self.messages.lock().unwrap().insert(id.clone(), message);
        Ok(id)
    }
    fn get_message(&self, id: &str) -> Option<Message> {
        self.messages.lock().unwrap().get(id).cloned()
    }
    fn create_delivery(&self, delivery: Delivery) -> Result<(), Box<dyn Error>> {
        self.deliveries
            .lock()
            .unwrap()
            .insert(delivery.id.clone(), delivery);
        Ok(())
    }
    fn get_delivery(&self, id: &str) -> Option<Delivery> {
        self.deliveries.lock().unwrap().get(id).cloned()
    }
    fn update_delivery(&self, delivery: Delivery) -> Result<(), Box<dyn Error>> {
        self.deliveries
            .lock()
            .unwrap()
            .insert(delivery.id.clone(), delivery);
        Ok(())
    }
    fn list_active_endpoints(&self, org_id: &str, event_type: &str) -> Vec<Endpoint> {
        self.endpoints
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.org_id == org_id && e.active && e.event_types.contains(&event_type.to_string()))
            .cloned()
            .collect()
    }
}

// Placeholder for SQL store; not used in tests
pub struct SQLStore;
impl Store for SQLStore {
    fn create_endpoint(
        &self,
        _org_id: &str,
        _url: &str,
        _event_types: &[String],
    ) -> Result<(String, String), Box<dyn Error>> {
        unimplemented!()
    }
    fn get_endpoint(&self, _id: &str) -> Option<Endpoint> {
        unimplemented!()
    }
    fn update_endpoint(&self, _endpoint: Endpoint) -> Result<(), Box<dyn Error>> {
        unimplemented!()
    }
    fn create_message(&self, _org_id: &str, _event_type: &str, _payload: Value) -> Result<String, Box<dyn Error>> {
        unimplemented!()
    }
    fn get_message(&self, _id: &str) -> Option<Message> {
        unimplemented!()
    }
    fn create_delivery(&self, _delivery: Delivery) -> Result<(), Box<dyn Error>> {
        unimplemented!()
    }
    fn get_delivery(&self, _id: &str) -> Option<Delivery> {
        unimplemented!()
    }
    fn update_delivery(&self, _delivery: Delivery) -> Result<(), Box<dyn Error>> {
        unimplemented!()
    }
    fn list_active_endpoints(&self, _org_id: &str, _event_type: &str) -> Vec<Endpoint> {
        unimplemented!()
    }
}

pub fn sign(secret: &str, msg_id: &str, timestamp: u64, body: &[u8]) -> Result<String, Box<dyn Error>> {
    let key_bytes = STANDARD.decode(secret.trim_start_matches("whsec_"))?;
    let mut mac = HmacSha256::new_from_slice(&key_bytes)?;
    let data = format!("{}.{}.{}", msg_id, timestamp, String::from_utf8_lossy(body));
    mac.update(data.as_bytes());
    let sig = mac.finalize().into_bytes();
    Ok(format!("v1,{}", STANDARD.encode(sig)))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn verify(
    secret: &str,
    headers: &HashMap<String, String>,
    raw_body: &[u8],
    tolerance_seconds: u64,
) -> Result<bool, WebhookError> {
    let sig_header = headers
        .get("webhook-signature")
        .ok_or(WebhookError::InvalidHeader)?;
    let msg_id = headers
        .get("webhook-id")
        .ok_or(WebhookError::InvalidHeader)?;
    let ts_str = headers
        .get("webhook-timestamp")
        .ok_or(WebhookError::InvalidHeader)?;
    let ts: u64 = ts_str.parse().map_err(|_| WebhookError::InvalidHeader)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WebhookError::InvalidHeader)?
        .as_secs();
    if now > ts + tolerance_seconds || ts > now + tolerance_seconds {
        return Err(WebhookError::TimestampOutOfRange);
    }
    let sigs: Vec<&str> = sig_header.split_whitespace().collect();
    for sig in sigs {
        let expected = sign(secret, msg_id, ts, raw_body)?;
        if constant_time_eq(expected.as_bytes(), sig.as_bytes()) {
            return Ok(true);
        }
    }
    Err(WebhookError::SignatureMismatch)
}

pub fn rotate_secret(store: &dyn Store, endpoint_id: &str) -> Result<String, Box<dyn Error>> {
    let mut endpoint = store
        .get_endpoint(endpoint_id)
        .ok_or(WebhookError::EndpointNotFound)?;
    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    let new_secret = format!("whsec_{}", STANDARD.encode(&secret_bytes));
    endpoint.secret = new_secret.clone();
    store.update_endpoint(endpoint)?;
    Ok(new_secret)
}

pub fn create_endpoint(
    store: &dyn Store,
    org_id: &str,
    url: &str,
    event_types: &[String],
) -> Result<(String, String), Box<dyn Error>> {
    store.create_endpoint(org_id, url, event_types)
}

pub fn send_event(
    store: &dyn Store,
    org_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<String, Box<dyn Error>> {
    let message_id = store.create_message(org_id, event_type, payload)?;
    let endpoints = store.list_active_endpoints(org_id, event_type);
    for ep in endpoints {
        let delivery = Delivery {
            id: Uuid::new_v4().to_string(),
            message_id: message_id.clone(),
            endpoint_id: ep.id.clone(),
            attempt: 0,
            status_code: None,
            success: false,
            error: None,
            next_attempt_at: Some(SystemTime::now()),
            delivered_at: None,
        };
        store.create_delivery(delivery)?;
    }
    Ok(message_id)
}

fn schedule_next(attempt: i32) -> Option<SystemTime> {
    let backoffs = [
        Duration::from_secs(5),
        Duration::from_secs(5 * 60),
        Duration::from_secs(30 * 60),
        Duration::from_secs(2 * 60 * 60),
        Duration::from_secs(5 * 60 * 60),
        Duration::from_secs(10 * 60 * 60),
        Duration::from_secs(10 * 60 * 60),
    ];
    if attempt < backoffs.len() as i32 {
        Some(SystemTime::now() + backoffs[attempt as usize])
    } else {
        None
    }
}

pub fn deliver<F>(
    store: &dyn Store,
    delivery_id: &str,
    sender: F,
) -> Result<(), Box<dyn Error>>
where
    F: Fn(&str, &HashMap<String, String>, &[u8]) -> Result<(u16, Vec<u8>), Box<dyn Error>>,
{
    let mut delivery = store
        .get_delivery(delivery_id)
        .ok_or(WebhookError::DeliveryNotFound)?;
    let message = store
        .get_message(&delivery.message_id)
        .ok_or(WebhookError::MessageNotFound)?;
    let endpoint = store
        .get_endpoint(&delivery.endpoint_id)
        .ok_or(WebhookError::EndpointNotFound)?;
    let body = serde_json::to_vec(&message.payload)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs();
    let signature = sign(&endpoint.secret, &delivery.message_id, timestamp, &body)?;
    let mut headers = HashMap::new();
    headers.insert("webhook-id".to_string(), delivery.message_id.clone());
    headers.insert("webhook-timestamp".to_string(), timestamp.to_string());
    headers.insert("webhook-signature".to_string(), signature);
    headers.insert("Content-Type".to_string(), "application/json".to_string());
    let result = sender(&endpoint.url, &headers, &body);
    match result {
        Ok((status, _)) => {
            delivery.status_code = Some(status);
            if (200..300).contains(&status) {
                delivery.success = true;
                delivery.delivered_at = Some(SystemTime::now());
            } else {
                delivery.success = false;
                delivery.error = Some(format!("HTTP {}", status));
                delivery.attempt += 1;
                delivery.next_attempt_at = schedule_next(delivery.attempt);
            }
        }
        Err(e) => {
            delivery.success = false;
            delivery.error = Some(e.to_string());
            delivery.attempt += 1;
            delivery.next_attempt_at = schedule_next(delivery.attempt);
        }
    }
    store.update_delivery(delivery)?;
    Ok(())
}