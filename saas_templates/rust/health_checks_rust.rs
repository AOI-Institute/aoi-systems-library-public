use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use std::sync::mpsc;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::fmt;
use std::error::Error;

#[derive(Clone, Default)]
pub struct HealthOptions {
    pub clock: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub version: String,
    pub release_id: String,
    pub service_id: String,
    pub description: String,
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type CheckFn = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
struct RegisteredCheck {
    component_id: String,
    component_type: String,
    check_fn: CheckFn,
    critical: bool,
    timeout_ms: u64,
}

pub trait CheckStore: Send + Sync {
    fn add_check(&self, check: RegisteredCheck) -> bool;
    fn list_checks(&self) -> Vec<RegisteredCheck>;
}

pub struct InMemoryCheckStore {
    checks: Mutex<BTreeMap<String, RegisteredCheck>>,
}

impl InMemoryCheckStore {
    pub fn new() -> Self {
        Self {
            checks: Mutex::new(BTreeMap::new()),
        }
    }
}

impl CheckStore for InMemoryCheckStore {
    fn add_check(&self, check: RegisteredCheck) -> bool {
        let mut map = self.checks.lock().unwrap();
        if map.contains_key(&check.component_id) {
            false
        } else {
            map.insert(check.component_id.clone(), check);
            true
        }
    }

    fn list_checks(&self) -> Vec<RegisteredCheck> {
        self.checks.lock().unwrap().values().cloned().collect()
    }
}

#[derive(Debug, Clone)]
pub struct HealthCheckError {
    pub code: &'static str,
    pub http_status: u16,
    pub message: String,
}

impl fmt::Display for HealthCheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl Error for HealthCheckError {}

#[derive(Debug, Clone)]
pub struct HealthResponse {
    pub http_status: u16,
    pub content_type: String,
    pub body: String,
}

pub struct HealthChecker {
    store: Arc<dyn CheckStore>,
    options: HealthOptions,
}

impl HealthChecker {
    pub fn new(store: Arc<dyn CheckStore>, options: Option<HealthOptions>) -> Result<Self, HealthCheckError> {
        let opts = options.unwrap_or_default();
        
        if Arc::strong_count(&store) == 0 {
            return Err(HealthCheckError {
                code: "INVALID_OPTION",
                http_status: 400,
                message: "invalid option: store".to_string(),
            });
        }
        
        if let Some(ref clock) = opts.clock {
            let _ = clock();
        }
        
        for (field, value) in [
            ("version", &opts.version),
            ("release_id", &opts.release_id),
            ("service_id", &opts.service_id),
            ("description", &opts.description),
        ] {
            if !value.is_empty() && !validate_metadata_chars(value) {
                return Err(HealthCheckError {
                    code: "INVALID_OPTION",
                    http_status: 400,
                    message: format!("invalid option: {}", field),
                });
            }
        }
        
        Ok(Self {
            store,
            options: opts,
        })
    }

    pub fn register_check(
        &self,
        component_id: &str,
        component_type: &str,
        check_fn: CheckFn,
        critical: bool,
        timeout_ms: u64,
    ) -> Result<(), HealthCheckError> {
        if !validate_id_chars(component_id) {
            return Err(HealthCheckError {
                code: "INVALID_COMPONENT_ID",
                http_status: 400,
                message: "component_id must be 1-64 characters from A-Z a-z 0-9 . _ -".to_string(),
            });
        }
        
        if !validate_id_chars(component_type) {
            return Err(HealthCheckError {
                code: "INVALID_COMPONENT_TYPE",
                http_status: 400,
                message: "component_type must be 1-64 characters from A-Z a-z 0-9 . _ -".to_string(),
            });
        }
        
        if timeout_ms < 1 || timeout_ms > 60000 {
            return Err(HealthCheckError {
                code: "INVALID_TIMEOUT",
                http_status: 400,
                message: "timeout_ms must be an integer from 1 to 60000".to_string(),
            });
        }
        
        let check = RegisteredCheck {
            component_id: component_id.to_string(),
            component_type: component_type.to_string(),
            check_fn,
            critical,
            timeout_ms,
        };
        
        if !self.store.add_check(check) {
            return Err(HealthCheckError {
                code: "DUPLICATE_COMPONENT",
                http_status: 409,
                message: "component_id is already registered".to_string(),
            });
        }
        
        Ok(())
    }

    pub fn liveness(&self) -> HealthResponse {
        let mut body = String::from(r#"{"status":"pass""#);
        add_metadata(&mut body, &self.options);
        body.push('}');
        
        HealthResponse {
            http_status: 200,
            content_type: "application/health+json".to_string(),
            body,
        }
    }

    pub fn readiness(&self) -> HealthResponse {
        let checks = self.store.list_checks();
        let mut sorted_checks = checks;
        sorted_checks.sort_by(|a, b| {
            let key_a = format!("{}:responseTime", a.component_id);
            let key_b = format!("{}:responseTime", b.component_id);
            key_a.cmp(&key_b)
        });
        
        let clock = self.options.clock.clone().unwrap_or_else(|| {
            Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
            })
        });
        
        let start_real = Instant::now();
        let mut results = Vec::new();
        
        for check in sorted_checks {
            let deadline = start_real + Duration::from_millis(check.timeout_ms);
            let check_fn = check.check_fn.clone();
            let clock_clone = clock.clone();
            let timeout_ms = check.timeout_ms;
            
            let (tx, rx) = mpsc::channel();
            
            thread::spawn(move || {
                let t0 = clock_clone();
                let r0 = Instant::now();
                
                let kind = catch_unwind(AssertUnwindSafe(|| check_fn()));
                
                let r1 = Instant::now();
                let t1 = clock_clone();
                let real_ms = r1.duration_since(r0).as_millis() as u64;
                
                let worker_kind = match kind {
                    Ok(true) => WorkerResult::Pass,
                    Ok(false) => WorkerResult::Reported,
                    Err(_) => WorkerResult::Errored,
                };
                
                let _ = tx.send((worker_kind, t0, t1, real_ms));
            });
            
            let (final_kind, observed_value, result_time, output) = {
                let mut worker_kind = None;
                let mut t0 = 0;
                let mut t1 = 0;
                let mut real_ms = 0;
                
                if let Ok((kind, t0_val, t1_val, real_ms_val)) = rx.try_recv() {
                    worker_kind = Some(kind);
                    t0 = t0_val;
                    t1 = t1_val;
                    real_ms = real_ms_val;
                } else {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(remaining) {
                        Ok((kind, t0_val, t1_val, real_ms_val)) => {
                            worker_kind = Some(kind);
                            t0 = t0_val;
                            t1 = t1_val;
                            real_ms = real_ms_val;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let result_time = clock();
                            let entry_kind = CheckResultKind::TimedOut;
                            let output = Some("check timed out".to_string());
                            results.push(CheckResult {
                                key: format!("{}:responseTime", check.component_id),
                                entry: format_check_entry(
                                    &check.component_id,
                                    &check.component_type,
                                    "fail",
                                    timeout_ms,
                                    result_time,
                                    output,
                                ),
                                critical: check.critical,
                                passed: false,
                            });
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            let result_time = clock();
                            let entry_kind = CheckResultKind::Errored;
                            let output = Some("check raised an error".to_string());
                            results.push(CheckResult {
                                key: format!("{}:responseTime", check.component_id),
                                entry: format_check_entry(
                                    &check.component_id,
                                    &check.component_type,
                                    "fail",
                                    0,
                                    result_time,
                                    output,
                                ),
                                critical: check.critical,
                                passed: false,
                            });
                            continue;
                        }
                    }
                };
                
                if let Some(kind) = worker_kind {
                    if real_ms > timeout_ms {
                        let result_time = t1;
                        let output = Some("check timed out".to_string());
                        results.push(CheckResult {
                            key: format!("{}:responseTime", check.component_id),
                            entry: format_check_entry(
                                &check.component_id,
                                &check.component_type,
                                "fail",
                                timeout_ms,
                                result_time,
                                output,
                            ),
                            critical: check.critical,
                            passed: false,
                        });
                    } else {
                        let clock_ms = (t1.saturating_sub(t0)).max(0) as u64;
                        let result_time = t1;
                        let (status, output) = match kind {
                            WorkerResult::Pass => ("pass", None),
                            WorkerResult::Reported => ("fail", Some("check reported failure".to_string())),
                            WorkerResult::Errored => ("fail", Some("check raised an error".to_string())),
                        };
                        results.push(CheckResult {
                            key: format!("{}:responseTime", check.component_id),
                            entry: format_check_entry(
                                &check.component_id,
                                &check.component_type,
                                status,
                                clock_ms,
                                result_time,
                                output,
                            ),
                            critical: check.critical,
                            passed: status == "pass",
                        });
                    }
                }
            };
        }
        
        let mut body = String::from(r#"{"status":""#);
        let mut overall_status = "pass";
        let mut has_fail = false;
        let mut has_critical_fail = false;
        
        for r in &results {
            if !r.passed {
                has_fail = true;
                if r.critical {
                    has_critical_fail = true;
                }
            }
        }
        
        if has_critical_fail {
            overall_status = "fail";
        } else if has_fail {
            overall_status = "warn";
        }
        
        body.push_str(overall_status);
        add_metadata(&mut body, &self.options);
        body.push_str(r#","checks":{"#);
        
        for (i, r) in results.iter().enumerate() {
            if i > 0 {
                body.push(',');
            }
            body.push('"');
            body.push_str(&r.key);
            body.push_str(r#"":["#);
            body.push_str(&r.entry);
            body.push(']');
        }
        
        body.push_str(r#"}}"#);
        
        let http_status = if overall_status == "fail" { 503 } else { 200 };
        
        HealthResponse {
            http_status,
            content_type: "application/health+json".to_string(),
            body,
        }
    }
}

struct CheckResult {
    key: String,
    entry: String,
    critical: bool,
    passed: bool,
}

#[derive(PartialEq, Clone, Copy)]
enum WorkerResult {
    Pass,
    Reported,
    Errored,
}

#[derive(PartialEq)]
enum CheckResultKind {
    Pass,
    Reported,
    Errored,
    TimedOut,
}

impl From<WorkerResult> for CheckResultKind {
    fn from(w: WorkerResult) -> Self {
        match w {
            WorkerResult::Pass => CheckResultKind::Pass,
            WorkerResult::Reported => CheckResultKind::Reported,
            WorkerResult::Errored => CheckResultKind::Errored,
        }
    }
}

fn format_check_entry(
    component_id: &str,
    component_type: &str,
    status: &str,
    observed_value: u64,
    time_ms: i64,
    output: Option<String>,
) -> String {
    let mut entry = String::new();
    entry.push_str(r#"{"componentId":"#);
    entry.push_str(&escape_json(component_id));
    entry.push_str(r#","componentType":"#);
    entry.push_str(&escape_json(component_type));
    entry.push_str(r#","observedValue":#);
    entry.push_str(&observed_value.to_string());
    entry.push_str(r#","observedUnit":"ms","status":"#);
    entry.push_str(&escape_json(status));
    entry.push_str(r#","time":"#);
    entry.push_str(&escape_json(&format_iso_time(time_ms)));
    if let Some(out) = output {
        entry.push_str(r#","output":"#);
        entry.push_str(&escape_json(&out));
    }
    entry.push('}');
    entry
}

fn format_iso_time(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86400);
    let mut secs_of_day = secs.rem_euclid(86400);
    
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    secs_of_day %= 3600;
    let minute = secs_of_day / 60;
    let second = secs_of_day % 60;
    
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hour, minute, second)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

fn add_metadata(body: &mut String, options: &HealthOptions) {
    if !options.version.is_empty() {
        body.push_str(r#","version":"#);
        body.push_str(&escape_json(&options.version));
    }
    if !options.release_id.is_empty() {
        body.push_str(r#","releaseId":"#);
        body.push_str(&escape_json(&options.release_id));
    }
    if !options.service_id.is_empty() {
        body.push_str(r#","serviceId":"#);
        body.push_str(&escape_json(&options.service_id));
    }
    if !options.description.is_empty() {
        body.push_str(r#","description":"#);
        body.push_str(&escape_json(&options.description));
    }
}

fn validate_id_chars(s: &str) -> bool {
    let len = s.len();
    if len < 1 || len > 64 {
        return false;
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn validate_metadata_chars(s: &str) -> bool {
    let len = s.len();
    if len < 1 || len > 128 {
        return false;
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '.' || c == '_' || c == ',' || c == '(' || c == ')' || c == '-')
}

fn escape_json(s: &str) -> String {
    let mut result = String::with_capacity(s.len() + 2);
    result.push('"');
    for c in s.chars() {
        match c {
            '"' => result.push_str(r#"\""#),
            '\\' => result.push_str(r#"\\"#),
            '\n' => result.push_str(r#"\n"#),
            '\r' => result.push_str(r#"\r"#),
            '\t' => result.push_str(r#"\t"#),
            c if c.is_control() => {
                result.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => result.push(c),
        }
    }
    result.push('"');
    result
}