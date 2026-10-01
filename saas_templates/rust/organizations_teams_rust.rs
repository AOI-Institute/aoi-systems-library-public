use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, Duration};
use sha2::{Sha256, Digest};
use rand::Rng;
use uuid::Uuid;
use std::sync::{Arc, Mutex};

/// Trait for storage operations
trait Storage {
    fn create_org(&mut self, name: &str, slug: &str, created_at: SystemTime) -> Result<Uuid, String>;
    fn get_org(&self, org_id: &Uuid) -> Option<(String, String, SystemTime)>;
    fn get_org_by_slug(&self, slug: &str) -> Option<(Uuid, String, SystemTime)>;
    fn create_membership(&mut self, org_id: &Uuid, user_id: &Uuid, role: &str, created_at: SystemTime) -> Result<(), String>;
    fn get_membership(&self, org_id: &Uuid, user_id: &Uuid) -> Option<(String, SystemTime)>;
    fn update_membership_role(&mut self, org_id: &Uuid, user_id: &Uuid, new_role: &str) -> Result<(), String>;
    fn delete_membership(&mut self, org_id: &Uuid, user_id: &Uuid) -> Result<(), String>;
    fn create_invitation(&mut self, org_id: &Uuid, email: &str, role: &str, token_hash: &[u8], expires_at: SystemTime, invited_by: &Uuid, created_at: SystemTime) -> Result<Uuid, String>;
    fn get_invitation(&self, token_hash: &[u8]) -> Option<(Uuid, Uuid, String, SystemTime, SystemTime, Uuid, SystemTime)>;
    fn mark_invitation_accepted(&mut self, token_hash: &[u8], accepted_at: SystemTime) -> Result<(), String>;
    fn list_memberships(&self, org_id: &Uuid) -> Vec<(Uuid, String, SystemTime)>;
}

/// In-memory storage implementation
struct InMemoryStorage {
    organizations: HashMap<Uuid, (String, String, SystemTime)>,
    memberships: HashMap<(Uuid, Uuid), (String, SystemTime)>,
    invitations: HashMap<[u8; 32], (Uuid, Uuid, String, SystemTime, SystemTime, Uuid, SystemTime)>,
}

impl InMemoryStorage {
    fn new() -> Self {
        Self {
            organizations: HashMap::new(),
            memberships: HashMap::new(),
            invitations: HashMap::new(),
        }
    }
}

impl Storage for InMemoryStorage {
    fn create_org(&mut self, name: &str, slug: &str, created_at: SystemTime) -> Result<Uuid, String> {
        let org_id = Uuid::new_v4();
        self.organizations.insert(org_id, (name.to_string(), slug.to_string(), created_at));
        Ok(org_id)
    }

    fn get_org(&self, org_id: &Uuid) -> Option<(String, String, SystemTime)> {
        self.organizations.get(org_id).cloned()
    }

    fn get_org_by_slug(&self, slug: &str) -> Option<(Uuid, String, SystemTime)> {
        self.organizations.iter()
            .find(|(_, (_, s, _))| s == slug)
            .map(|(&id, (_, name, created_at))| (id, name.clone(), *created_at))
    }

    fn create_membership(&mut self, org_id: &Uuid, user_id: &Uuid, role: &str, created_at: SystemTime) -> Result<(), String> {
        let key = (*org_id, *user_id);
        if self.memberships.contains_key(&key) {
            return Err("Membership already exists".to_string());
        }
        self.memberships.insert(key, (role.to_string(), created_at));
        Ok(())
    }

    fn get_membership(&self, org_id: &Uuid, user_id: &Uuid) -> Option<(String, SystemTime)> {
        self.memberships.get(&(*org_id, *user_id)).cloned()
    }

    fn update_membership_role(&mut self, org_id: &Uuid, user_id: &Uuid, new_role: &str) -> Result<(), String> {
        let key = (*org_id, *user_id);
        match self.memberships.get_mut(&key) {
            Some((_, _)) => {
                self.memberships.insert(key, (new_role.to_string(), SystemTime::now()));
                Ok(())
            }
            None => Err("Membership not found".to_string()),
        }
    }

    fn delete_membership(&mut self, org_id: &Uuid, user_id: &Uuid) -> Result<(), String> {
        let key = (*org_id, *user_id);
        if self.memberships.remove(&key).is_some() {
            Ok(())
        } else {
            Err("Membership not found".to_string())
        }
    }

    fn create_invitation(&mut self, org_id: &Uuid, email: &str, role: &str, token_hash: &[u8], expires_at: SystemTime, invited_by: &Uuid, created_at: SystemTime) -> Result<Uuid, String> {
        let id = Uuid::new_v4();
        let key = {
            let mut hasher = Sha256::new();
            hasher.update(token_hash);
            let result = hasher.finalize();
            let mut array = [0u8; 32];
            array.copy_from_slice(&result[..]);
            array
        };
        self.invitations.insert(key, (id, *org_id, email.to_string(), expires_at, created_at, *invited_by, SystemTime::now()));
        Ok(id)
    }

    fn get_invitation(&self, token_hash: &[u8]) -> Option<(Uuid, Uuid, String, SystemTime, SystemTime, Uuid, SystemTime)> {
        let mut hasher = Sha256::new();
        hasher.update(token_hash);
        let result = hasher.finalize();
        let mut array = [0u8; 32];
        array.copy_from_slice(&result[..]);
        self.invitations.get(&array).cloned()
    }

    fn mark_invitation_accepted(&mut self, token_hash: &[u8], accepted_at: SystemTime) -> Result<(), String> {
        let mut hasher = Sha256::new();
        hasher.update(token_hash);
        let result = hasher.finalize();
        let mut array = [0u8; 32];
        array.copy_from_slice(&result[..]);
        if let Some(inv) = self.invitations.get_mut(&array) {
            inv.5 = accepted_at;
            Ok(())
        } else {
            Err("Invitation not found".to_string())
        }
    }

    fn list_memberships(&self, org_id: &Uuid) -> Vec<(Uuid, String, SystemTime)> {
        self.memberships.iter()
            .filter(|((oid, _), _)| oid == org_id)
            .map(|((_, uid), (role, created_at))| (*uid, role.clone(), *created_at))
            .collect()
    }
}

/// SQL storage implementation
struct SqlStorage {
    // SQLite connection would go here, but for simplicity, we'll use in-memory for tests
}

impl SqlStorage {
    fn new() -> Self {
        Self {}
    }
}

impl Storage for SqlStorage {
    fn create_org(&mut self, name: &str, slug: &str, created_at: SystemTime) -> Result<Uuid, String> {
        // Implementation would use SQLite
        Err("Not implemented".to_string())
    }

    fn get_org(&self, org_id: &Uuid) -> Option<(String, String, SystemTime)> {
        // Implementation would use SQLite
        None
    }

    fn get_org_by_slug(&self, slug: &str) -> Option<(Uuid, String, SystemTime)> {
        // Implementation would use SQLite
        None
    }

    fn create_membership(&mut self, org_id: &Uuid, user_id: &Uuid, role: &str, created_at: SystemTime) -> Result<(), String> {
        // Implementation would use SQLite
        Err("Not implemented".to_string())
    }

    fn get_membership(&self, org_id: &Uuid, user_id: &Uuid) -> Option<(String, SystemTime)> {
        // Implementation would use SQLite
        None
    }

    fn update_membership_role(&mut self, org_id: &Uuid, user_id: &Uuid, new_role: &str) -> Result<(), String> {
        // Implementation would use SQLite
        Err("Not implemented".to_string())
    }

    fn delete_membership(&mut self, org_id: &Uuid, user_id: &Uuid) -> Result<(), String> {
        // Implementation would use SQLite
        Err("Not implemented".to_string())
    }

    fn create_invitation(&mut self, org_id: &Uuid, email: &str, role: &str, token_hash: &[u8], expires_at: SystemTime, invited_by: &Uuid, created_at: SystemTime) -> Result<Uuid, String> {
        // Implementation would use SQLite
        Err("Not implemented".to_string())
    }

    fn get_invitation(&self, token_hash: &[u8]) -> Option<(Uuid, Uuid, String, SystemTime, SystemTime, Uuid, SystemTime)> {
        // Implementation would use SQLite
        None
    }

    fn mark_invitation_accepted(&mut self, token_hash: &[u8], accepted_at: SystemTime) -> Result<(), String> {
        // Implementation would use SQLite
        Err("Not implemented".to_string())
    }

    fn list_memberships(&self, org_id: &Uuid) -> Vec<(Uuid, String, SystemTime)> {
        // Implementation would use SQLite
        vec![]
    }
}

/// Main system implementation
struct OrganizationsTeams {
    storage: Box<dyn Storage>,
}

impl OrganizationsTeams {
    fn new(use_sql: bool) -> Self {
        if use_sql {
            Self { storage: Box::new(SqlStorage::new()) }
        } else {
            Self { storage: Box::new(InMemoryStorage::new()) }
        }
    }

    fn create_org(&mut self, user: &str, name: &str) -> Result<(String, String, SystemTime), (u32, String, String)> {
        // Check if user is a member of any org (for simplicity, we'll assume user is not a member)
        let slug = generate_slug(&name);
        let created_at = SystemTime::now();
        match self.storage.create_org(&name, &slug, created_at) {
            Ok(org_id) => {
                // Create membership for user as owner
                let user_id = Uuid::new_v4(); // For simplicity, we'll generate a user ID
                match self.storage.create_membership(&org_id, &user_id, "owner", created_at) {
                    Ok(_) => Ok((org_id.to_string(), slug, created_at)),
                    Err(e) => Err((400, "Failed to create membership".to_string(), e)),
                }
            }
            Err(e) => Err((400, "Failed to create org".to_string(), e)),
        }
    }

    fn invite(&mut self, actor: &str, org_id: &str, email: &str, role: &str) -> Result<(String, SystemTime, SystemTime), (u32, String, String)> {
        // Validate actor is a member and has permission to invite
        let org_uuid = Uuid::parse_str(org_id).map_err(|_| (400, "Invalid org_id".to_string(), "".to_string()))?;
        let actor_uuid = Uuid::new_v4(); // For simplicity, we'll generate a user ID
        let membership = self.storage.get_membership(&org_uuid, &actor_uuid);
        if membership.is_none() {
            return Err((403, "Not a member".to_string(), "".to_string()));
        }
        let (_, _) = membership.unwrap(); // role and created_at

        // Check if actor has permission to invite (admin or owner)
        let role_str = membership.unwrap().0;
        if role_str != "owner" && role_str != "admin" {
            return Err((403, "Insufficient permissions".to_string(), "".to_string()));
        }

        // Generate invitation token
        let token = generate_token();
        let token_hash = hash_token(&token);
        let expires_at = SystemTime::now() + Duration::from_secs(7 * 24 * 3600);
        let created_at = SystemTime::now();
        let invited_by = actor_uuid;

        match self.storage.create_invitation(&org_uuid, email, role, &token_hash, expires_at, &invited_by, created_at) {
            Ok(invitation_id) => Ok((token, expires_at, created_at)),
            Err(e) => Err((400, "Failed to create invitation".to_string(), e)),
        }
    }

    fn accept_invitation(&mut self, user: &str, raw_token: &str) -> Result<(String, String, SystemTime), (u32, String, String)> {
        let token_hash = hash_token(raw_token.as_bytes());
        let invitation = self.storage.get_invitation(&token_hash);
        if invitation.is_none() {
            return Err((404, "Invitation not found".to_string(), "".to_string()));
        }
        let (invitation_id, org_id, email, expires_at, created_at, invited_by, accepted_at) = invitation.unwrap();

        // Check if invitation is expired
        if SystemTime::now() > expires_at {
            return Err((400, "Invitation expired".to_string(), "".to_string()));
        }

        // Check if invitation already accepted
        if accepted_at != SystemTime::UNIX_EPOCH {
            return Err((400, "Invitation already accepted".to_string(), "".to_string()));
        }

        // Check if user's email matches invitation email
        if email != user {
            return Err((403, "Email does not match invitation".to_string(), "".to_string()));
        }

        // Mark invitation as accepted
        match self.storage.mark_invitation_accepted(&token_hash, SystemTime::now()) {
            Ok(_) => {},
            Err(e) => return Err((400, "Failed to accept invitation".to_string(), e)),
        }

        // Create membership for user
        let user_id = Uuid::new_v4(); // For simplicity, we'll generate a user ID
        match self.storage.create_membership(&org_id, &user_id, "member", SystemTime::now()) {
            Ok(_) => Ok((org_id.to_string(), "member".to_string(), SystemTime::now())),
            Err(e) => Err((400, "Failed to create membership".to_string(), e)),
        }
    }

    fn change_role(&mut self, actor: &str, org_id: &str, user_id: &str, role: &str) -> Result<(), (u32, String, String)> {
        let org_uuid = Uuid::parse_str(org_id).map_err(|_| (400, "Invalid org_id".to_string(), "".to_string()))?;
        let actor_uuid = Uuid::new_v4(); // For simplicity, we'll generate a user ID
        let user_uuid = Uuid::parse_str(user_id).map_err(|_| (400, "Invalid user_id".to_string(), "".to_string()))?;

        // Check if actor is a member
        let actor_membership = self.storage.get_membership(&org_uuid, &actor_uuid);
        if actor_membership.is_none() {
            return Err((403, "Not a member".to_string(), "".to_string()));
        }
        let (actor_role, _) = actor_membership.unwrap();

        // Check if target user is a member
        let target_membership = self.storage.get_membership(&org_uuid, &user_uuid);
        if target_membership.is_none() {
            return Err((404, "User not a member".to_string(), "".to_string()));
        }

        // Check permissions
        if actor_role == "member" {
            return Err((403, "Insufficient permissions".to_string(), "".to_string()));
        }
        if actor_role == "admin" && (target_membership.unwrap().0 == "owner" || role == "owner") {
            return Err((403, "Cannot change owner's role".to_string(), "".to_string()));
        }
        if actor_role == "owner" && role == "owner" {
            return Err((403, "Cannot change owner's role".to_string(), "".to_string()));
        }

        // Check if org has at least one owner after change
        let mut owner_count = 0;
        for (uid, role_str, _) in self.storage.list_memberships(&org_uuid) {
            if role_str == "owner" {
                owner_count += 1;
            }
        }
        if role == "owner" && owner_count <= 1 {
            return Err((400, "Org must have at least one owner".to_string(), "".to_string()));
        }

        // Update role
        match self.storage.update_membership_role(&org_uuid, &user_uuid, role) {
            Ok(_) => Ok(()),
            Err(e) => Err((400, "Failed to update role".to_string(), e)),
        }
    }

    fn remove_member(&mut self, actor: &str, org_id: &str, user_id: &str) -> Result<(), (u32, String, String)> {
        let org_uuid = Uuid::parse_str(org_id).map_err(|_| (400, "Invalid org_id".to_string(), "".to_string()))?;
        let actor_uuid = Uuid::new_v4(); // For simplicity, we'll generate a user ID
        let user_uuid = Uuid::parse_str(user_id).map_err(|_| (400, "Invalid user_id".to_string(), "".to_string()))?;

        // Check if actor is a member
        let actor_membership = self.storage.get_membership(&org_uuid, &actor_uuid);
        if actor_membership.is_none() {
            return Err((403, "Not a member".to_string(), "".to_string()));
        }
        let (actor_role, _) = actor_membership.unwrap();

        // Check if target user is a member
        let target_membership = self.storage.get_membership(&org_uuid, &user_uuid);
        if target_membership.is_none() {
            return Err((404, "User not a member".to_string(), "".to_string()));
        }

        // Check permissions
        if actor_role == "member" {
            return Err((403, "Insufficient permissions".to_string(), "".to_string()));
        }
        if actor_role == "admin" && target_membership.unwrap().0 == "owner" {
            return Err((403, "Cannot remove owner".to_string(), "".to_string()));
        }
        if actor_role == "owner" && target_membership.unwrap().0 == "owner" {
            return Err((403, "Cannot remove owner".to_string(), "".to_string()));
        }

        // Check if org has at least one owner after removal
        let mut owner_count = 0;
        for (uid, role_str, _) in self.storage.list_memberships(&org_uuid) {
            if role_str == "owner" {
                owner_count += 1;
            }
        }
        if target_membership.unwrap().0 == "owner" && owner_count <= 1 {
            return Err((400, "Org must have at least one owner".to_string(), "".to_string()));
        }

        // Remove member
        match self.storage.delete_membership(&org_uuid, &user_uuid) {
            Ok(_) => Ok(()),
            Err(e) => Err((400, "Failed to remove member".to_string(), e)),
        }
    }

    fn leave_org(&mut self, user: &str, org_id: &str) -> Result<(), (u32, String, String)> {
        let org_uuid = Uuid::parse_str(org_id).map_err(|_| (400, "Invalid org_id".to_string(), "".to_string()))?;
        let user_uuid = Uuid::new_v4(); // For simplicity, we'll generate a user ID

        // Check if user is a member
        let membership = self.storage.get_membership(&org_uuid, &user_uuid);
        if membership.is_none() {
            return Err((404, "Not a member".to_string(), "".to_string()));
        }
        let (role, _) = membership.unwrap();

        // Check if user is the last owner
        let mut owner_count = 0;
        for (uid, role_str, _) in self.storage.list_memberships(&org_uuid) {
            if role_str == "owner" {
                owner_count += 1;
            }
        }
        if role == "owner" && owner_count <= 1 {
            return Err((400, "Last owner cannot leave".to_string(), "".to_string()));
        }

        // Remove member
        match self.storage.delete_membership(&org_uuid, &user_uuid) {
            Ok(_) => Ok(()),
            Err(e) => Err((400, "Failed to leave org".to_string(), e)),
        }
    }

    fn list_members(&self, actor: &str, org_id: &str) -> Result<Vec<(String, String, SystemTime)>, (u32, String, String)> {
        let org_uuid = Uuid::parse_str(org_id).map_err(|_| (400, "Invalid org_id".to_string(), "".to_string()))?;
        let actor_uuid = Uuid::new_v4(); // For simplicity, we'll generate a user ID

        // Check if actor is a member
        let membership = self.storage.get_membership(&org_uuid, &actor_uuid);
        if membership.is_none() {
            return Err((403, "Not a member".to_string(), "".to_string()));
        }

        // List members
        let memberships = self.storage.list_memberships(&org_uuid);
        Ok(memberships.iter().map(|(uid, role, created_at)| (uid.to_string(), role.clone(), *created_at)).collect())
    }

    fn get_org(&self, actor: &str, org_id: &str) -> Result<(String, String, SystemTime), (u32, String, String)> {
        let org_uuid = Uuid::parse_str(org_id).map_err(|_| (400, "Invalid org_id".to_string(), "".to_string()))?;
        let actor_uuid = Uuid::new_v4(); // For simplicity, we'll generate a user ID

        // Check if actor is a member
        let membership = self.storage.get_membership(&org_uuid, &actor_uuid);
        if membership.is_none() {
            return Err((404, "Org not found".to_string(), "".to_string()));
        }

        // Get org
        let org = self.storage.get_org(&org_uuid);
        if org.is_none() {
            return Err((404, "Org not found".to_string(), "".to_string()));
        }
        let (name, slug, created_at) = org.unwrap();

        Ok((name, slug, created_at))
    }
}

/// Helper functions
fn generate_slug(name: &str) -> String {
    name.to_lowercase().replace(' ', "-")
}

fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let token: [u8; 32] = rng.gen();
    base64::encode(token)
}

fn hash_token(token: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(token);
    let result = hasher.finalize();
    let mut array = [0u8; 32];
    array.copy_from_slice(&result[..]);
    array
}

fn main() {
    // Example usage
    let mut system = OrganizationsTeams::new(false);
    let user = "test@example.com";
    let org_name = "Test Org";
    let result = system.create_org(user, org_name);
    println!("{:?}", result);
}