use super::*;
use rusqlite::Connection;
use std::env;

struct MockStripe;
impl StripeClient for MockStripe {
    fn update_subscription(&self, _stripe_id: &str, _price_id: &str) -> AdminResult<()> {
        Ok(())
    }
}

fn setup() -> AdminSystem {
    let conn = Connection::open_in_memory().unwrap();
    let system = AdminSystem::new(conn, Box::new(MockStripe));
    system.init_schema().unwrap();
    // Create an owner user
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO users (email,name,tier,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params!["owner@example.com", "Owner", "enterprise", "active", now, now],
        )
        .unwrap();
    system
}

#[test]
fn test_create_user_happy_path() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let resp = system.create_user(&owner, "new@example.com", "New User", "basic", true);
    match resp {
        Response::Success { data, .. } => {
            let uid: i64 = serde_json::from_value(data.get("user_id").unwrap().clone()).unwrap();
            assert!(uid > 0);
            let user = system.get_user_by_id(uid).unwrap();
            assert_eq!(user.email, "new@example.com");
        }
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_create_user_duplicate_email() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    system
        .create_user(&owner, "dup@example.com", "Dup", "basic", true)
        .unwrap();
    let resp = system.create_user(&owner, "dup@example.com", "Dup2", "basic", true);
    match resp {
        Response::Error { error, .. } => assert_eq!(error, "conflict"),
        _ => panic!("Expected conflict"),
    }
}

#[test]
fn test_create_user_non_owner() {
    let system = setup();
    let user = system
        .create_user(&system.get_user_by_email("owner@example.com").unwrap().unwrap(), "user@example.com", "User", "basic", true)
        .unwrap();
    let uid: i64 = serde_json::from_value(user.data.get("user_id").unwrap().clone()).unwrap();
    let normal = system.get_user_by_id(uid).unwrap();
    let resp = system.create_user(&normal, "another@example.com", "Another", "basic", true);
    match resp {
        Response::Error { error, .. } => assert_eq!(error, "owner_only"),
        _ => panic!("Expected owner_only"),
    }
}

#[test]
fn test_reset_password_happy_path() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let resp = system.reset_password(&owner, owner.id);
    match resp {
        Response::Error { error, .. } => assert_eq!(error, "cannot_reset_own_password"),
        _ => panic!("Expected own reset error"),
    }
    let new_user = system
        .create_user(&owner, "reset@example.com", "Reset", "basic", true)
        .unwrap();
    let uid: i64 = serde_json::from_value(new_user.data.get("user_id").unwrap().clone()).unwrap();
    let resp = system.reset_password(&owner, uid);
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_change_role_happy_path() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let new_user = system
        .create_user(&owner, "role@example.com", "Role", "basic", true)
        .unwrap();
    let uid: i64 = serde_json::from_value(new_user.data.get("user_id").unwrap().clone()).unwrap();
    let resp = system.change_role(&owner, uid, "premium");
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_change_role_last_owner() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let resp = system.change_role(&owner, owner.id, "basic");
    match resp {
        Response::Error { error, .. } => assert_eq!(error, "cannot_demote_last_owner"),
        _ => panic!("Expected error"),
    }
}

#[test]
fn test_suspend_user_happy_path() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let new_user = system
        .create_user(&owner, "suspend@example.com", "Suspend", "basic", true)
        .unwrap();
    let uid: i64 = serde_json::from_value(new_user.data.get("user_id").unwrap().clone()).unwrap();
    let resp = system.suspend_user(&owner, uid, "violation");
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_suspend_own_account() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let resp = system.suspend_user(&owner, owner.id, "self");
    match resp {
        Response::Error { error, .. } => assert_eq!(error, "cannot_suspend_yourself"),
        _ => panic!("Expected error"),
    }
}

#[test]
fn test_customers_list() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    // Insert customers
    let now = Utc::now().to_rfc3339();
    for i in 0..5 {
        system
            .conn
            .execute(
                "INSERT INTO customers (email,name,tier,signup_date,invoice_count,status) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    format!("cust{}@example.com", i),
                    format!("Customer {}", i),
                    "basic",
                    now,
                    0,
                    "active"
                ],
            )
            .unwrap();
    }
    let resp = system.list_customers(&owner, 1, 10);
    match resp {
        Response::Success { data, .. } => {
            let arr = data.as_array().unwrap();
            assert_eq!(arr.len(), 5);
        }
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_customers_detail() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO customers (email,name,tier,signup_date,invoice_count,status) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                "cust@example.com",
                "Customer",
                "basic",
                now,
                0,
                "active"
            ],
        )
        .unwrap();
    let cid = system.conn.last_insert_rowid();
    let resp = system.get_customer(&owner, cid);
    match resp {
        Response::Success { data, .. } => {
            assert_eq!(data.get("customer_id").unwrap(), &serde_json::json!(cid));
        }
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_change_plan() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO customers (email,name,tier,signup_date,invoice_count,status) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                "cust@example.com",
                "Customer",
                "basic",
                now,
                0,
                "active"
            ],
        )
        .unwrap();
    let cid = system.conn.last_insert_rowid();
    let resp = system.change_plan(&owner, cid, "premium");
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_queue_refund() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let resp = system.queue_refund(&owner, 1, 5000, "refund reason");
    match resp {
        Response::Success { data, .. } => {
            assert_eq!(data.get("status").unwrap(), &serde_json::json!("queued"));
        }
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_create_deployment() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO customers (email,name,tier,signup_date,invoice_count,status) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                "cust@example.com",
                "Customer",
                "basic",
                now,
                0,
                "active"
            ],
        )
        .unwrap();
    let cid = system.conn.last_insert_rowid();
    let resp = system.create_deployment(&owner, cid, "example.com", "basic", "theme1");
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_publish_deployment() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO customers (email,name,tier,signup_date,invoice_count,status) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                "cust@example.com",
                "Customer",
                "basic",
                now,
                0,
                "active"
            ],
        )
        .unwrap();
    let cid = system.conn.last_insert_rowid();
    let dep_resp = system.create_deployment(&owner, cid, "example.com", "basic", "theme1");
    let dep_id: i64 = serde_json::from_value(dep_resp.data.get("deployment_id").unwrap().clone()).unwrap();
    let resp = system.publish_deployment(&owner, dep_id);
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_governance_approve() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    // Insert pending action
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO governance_actions (action_type,actor_id,target_resource_id,reason,submitted_at,status) VALUES (?1,?2,?3,?4,?5,?6)",
            params!["delete_user", owner.id, 1, "test", now, "pending"],
        )
        .unwrap();
    let action_id = system.conn.last_insert_rowid();
    let resp = system.decide_governance_action(&owner, action_id, "approve", None);
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_governance_reject() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    let now = Utc::now().to_rfc3339();
    system
        .conn
        .execute(
            "INSERT INTO governance_actions (action_type,actor_id,target_resource_id,reason,submitted_at,status) VALUES (?1,?2,?3,?4,?5,?6)",
            params!["delete_user", owner.id, 1, "test", now, "pending"],
        )
        .unwrap();
    let action_id = system.conn.last_insert_rowid();
    let resp = system.decide_governance_action(&owner, action_id, "reject", Some("not needed"));
    match resp {
        Response::Success { .. } => {}
        _ => panic!("Expected success"),
    }
}

#[test]
fn test_audit_log_search() {
    let system = setup();
    let owner = system.get_user_by_email("owner@example.com").unwrap().unwrap();
    // Create a user to generate audit log
    system.create_user(&owner, "audit@example.com", "Audit", "basic", true).unwrap();
    let now = Utc::now();
    let resp = system.search_audit_log(&owner, None, None, None, 10, 0);
    match resp {
        Response::Success { data, .. } => {
            let arr = data.as_array().unwrap();
            assert!(arr.len() > 0);
        }
        _ => panic!("Expected success"),
    }
}