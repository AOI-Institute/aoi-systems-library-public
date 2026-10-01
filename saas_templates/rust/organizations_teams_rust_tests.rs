use super::*;
use std::time::{SystemTime, Duration};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_org() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, slug, created_at) = result.unwrap();
        assert_eq!(slug, "test-org");
    }

    #[test]
    fn test_invite() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let actor = "test@example.com";
        let email = "invite@example.com";
        let role = "member";
        let result = system.invite(actor, &org_id, email, role);
        assert!(result.is_ok());
        let (token, expires_at, created_at) = result.unwrap();
        assert_eq!(token.len(), 32 * 4 / 3 + 2); // Base64 encoded length
    }

    #[test]
    fn test_accept_invitation() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let actor = "test@example.com";
        let email = "invite@example.com";
        let role = "member";
        let result = system.invite(actor, &org_id, email, role);
        assert!(result.is_ok());
        let (token, _, _) = result.unwrap();

        let user_email = "invite@example.com";
        let result = system.accept_invitation(user_email, &token);
        assert!(result.is_ok());
        let (org_id, role, created_at) = result.unwrap();
        assert_eq!(role, "member");
    }

    #[test]
    fn test_change_role() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let actor = "test@example.com";
        let email = "invite@example.com";
        let role = "member";
        let result = system.invite(actor, &org_id, email, role);
        assert!(result.is_ok());
        let (token, _, _) = result.unwrap();

        let user_email = "invite@example.com";
        let result = system.accept_invitation(user_email, &token);
        assert!(result.is_ok());

        let new_role = "admin";
        let result = system.change_role(actor, &org_id, "invite@example.com", new_role);
        assert!(result.is_ok());
    }

    #[test]
    fn test_remove_member() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let actor = "test@example.com";
        let email = "invite@example.com";
        let role = "member";
        let result = system.invite(actor, &org_id, email, role);
        assert!(result.is_ok());
        let (token, _, _) = result.unwrap();

        let user_email = "invite@example.com";
        let result = system.accept_invitation(user_email, &token);
        assert!(result.is_ok());

        let result = system.remove_member(actor, &org_id, "invite@example.com");
        assert!(result.is_ok());
    }

    #[test]
    fn test_leave_org() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let result = system.leave_org(user, &org_id);
        assert!(result.is_ok());
    }

    #[test]
    fn test_list_members() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let actor = "test@example.com";
        let email = "invite@example.com";
        let role = "member";
        let result = system.invite(actor, &org_id, email, role);
        assert!(result.is_ok());
        let (token, _, _) = result.unwrap();

        let user_email = "invite@example.com";
        let result = system.accept_invitation(user_email, &token);
        assert!(result.is_ok());

        let result = system.list_members(actor, &org_id);
        assert!(result.is_ok());
        let members = result.unwrap();
        assert_eq!(members.len(), 2); // owner and member
    }

    #[test]
    fn test_get_org() {
        let mut system = OrganizationsTeams::new(false);
        let user = "test@example.com";
        let org_name = "Test Org";
        let result = system.create_org(user, org_name);
        assert!(result.is_ok());
        let (org_id, _, _) = result.unwrap();

        let actor = "test@example.com";
        let result = system.get_org(actor, &org_id);
        assert!(result.is_ok());
        let (name, slug, created_at) = result.unwrap();
        assert_eq!(name, org_name);
        assert_eq!(slug, "test-org");
    }
}