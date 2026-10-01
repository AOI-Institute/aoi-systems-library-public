package organizations_teams

import (
	"testing"
	"time"
)

func TestNonMemberCannotReadMembersOfAnotherOrg(t *testing.T) {
	store := NewInMemoryStore()
	service := NewOrganizationsTeams(store)

	// Create org1 with user1 as owner
	user1 := User{ID: "user1", Email: "user1@example.com"}
	org1, err := service.CreateOrg(user1, "Org1")
	if err != nil {
		t.Fatalf("Failed to create org1: %v", err)
	}

	// Create org2 with user2 as owner
	user2 := User{ID: "user2", Email: "user2@example.com"}
	org2, err := service.CreateOrg(user2, "Org2")
	if err != nil {
		t.Fatalf("Failed to create org2: %v", err)
	}

	// user2 tries to list members of org1 (IDOR attempt)
	_, err = service.ListMembers(user2, org1.ID)
	if err == nil {
		t.Fatal("Expected error when non-member tries to list members of another org")
	}
	if err.Error() != "not found" {
		t.Fatalf("Expected 'not found' error, got: %v", err)
	}

	// user2 tries to get org1 (IDOR attempt)
	_, err = service.GetOrg(user2, org1.ID)
	if err == nil {
		t.Fatal("Expected error when non-member tries to get another org")
	}
	if err.Error() != "not found" {
		t.Fatalf("Expected 'not found' error, got: %v", err)
	}

	// Verify org2 is accessible to user2
	_, err = service.GetOrg(user2, org2.ID)
	if err != nil {
		t.Fatalf("Expected to get org2, got error: %v", err)
	}
}

func TestMemberCannotInviteAdminCan(t *testing.T) {
	store := NewInMemoryStore()
	service := NewOrganizationsTeams(store)

	// Create org with user1 as owner
	user1 := User{ID: "user1", Email: "user1@example.com"}
	org, err := service.CreateOrg(user1, "TestOrg")
	if err != nil {
		t.Fatalf("Failed to create org: %v", err)
	}

	// Invite user2 as admin
	rawToken, err := service.Invite(user1, org.ID, "user2@example.com", RoleAdmin)
	if err != nil {
		t.Fatalf("Failed to invite user2: %v", err)
	}

	// user2 accepts invitation
	user2 := User{ID: "user2", Email: "user2@example.com"}
	membership, err := service.AcceptInvitation(user2, rawToken)
	if err != nil {
		t.Fatalf("Failed to accept invitation: %v", err)
	}
	if membership.Role != RoleAdmin {
		t.Fatalf("Expected role admin, got: %v", membership.Role)
	}

	// user2 (admin) invites user3
	_, err = service.Invite(user2, org.ID, "user3@example.com", RoleMember)
	if err != nil {
		t.Fatalf("Admin should be able to invite: %v", err)
	}

	// Invite user4 as member
	rawToken4, err := service.Invite(user1, org.ID, "user4@example.com", RoleMember)
	if err != nil {
		t.Fatalf("Failed to invite user4: %v", err)
	}

	// user4 accepts invitation
	user4 := User{ID: "user4", Email: "user4@example.com"}
	_, err = service.AcceptInvitation(user4, rawToken4)
	if err != nil {
		t.Fatalf("Failed to accept invitation: %v", err)
	}

	// user4 (member) tries to invite user5
	_, err = service.Invite(user4, org.ID, "user5@example.com", RoleMember)
	if err == nil {
		t.Fatal("Expected error when member tries to invite")
	}
	if err.Error() != "forbidden" {
		t.Fatalf("Expected 'forbidden' error, got: %v", err)
	}
}

func TestAdminCannotRemoveOwnerLastOwnerCannotLeave(t *testing.T) {
	store := NewInMemoryStore()
	service := NewOrganizationsTeams(store)

	// Create org with user1 as owner
	user1 := User{ID: "user1", Email: "user1@example.com"}
	org, err := service.CreateOrg(user1, "TestOrg")
	if err != nil {
		t.Fatalf("Failed to create org: %v", err)
	}

	// Invite user2 as admin
	rawToken, err := service.Invite(user1, org.ID, "user2@example.com", RoleAdmin)
	if err != nil {
		t.Fatalf("Failed to invite user2: %v", err)
	}

	// user2 accepts invitation
	user2 := User{ID: "user2", Email: "user2@example.com"}
	_, err = service.AcceptInvitation(user2, rawToken)
	if err != nil {
		t.Fatalf("Failed to accept invitation: %v", err)
	}

	// user2 (admin) tries to remove user1 (owner)
	err = service.RemoveMember(user2, org.ID, user1.ID)
	if err == nil {
		t.Fatal("Expected error when admin tries to remove owner")
	}
	if err.Error() != "forbidden" {
		t.Fatalf("Expected 'forbidden' error, got: %v", err)
	}

	// user1 (owner) tries to leave
	err = service.LeaveOrg(user1, org.ID)
	if err == nil {
		t.Fatal("Expected error when last owner tries to leave")
	}
	if err.Error() != "cannot leave as the last owner" {
		t.Fatalf("Expected 'cannot leave as the last owner' error, got: %v", err)
	}
}

func TestInvitationWorksOnceSecondUseFails(t *testing.T) {
	store := NewInMemoryStore()
	service := NewOrganizationsTeams(store)

	// Create org with user1 as owner
	user1 := User{ID: "user1", Email: "user1@example.com"}
	org, err := service.CreateOrg(user1, "TestOrg")
	if err != nil {
		t.Fatalf("Failed to create org: %v", err)
	}

	// Invite user2
	rawToken, err := service.Invite(user1, org.ID, "user2@example.com", RoleMember)
	if err != nil {
		t.Fatalf("Failed to invite user2: %v", err)
	}

	// user2 accepts invitation
	user2 := User{ID: "user2", Email: "user2@example.com"}
	_, err = service.AcceptInvitation(user2, rawToken)
	if err != nil {
		t.Fatalf("Failed to accept invitation: %v", err)
	}

	// Try to accept the same invitation again
	_, err = service.AcceptInvitation(user2, rawToken)
	if err == nil {
		t.Fatal("Expected error when accepting invitation twice")
	}
	if err.Error() != "invitation already accepted" {
		t.Fatalf("Expected 'invitation already accepted' error, got: %v", err)
	}
}

func TestExpiredInvitationFailsEmailMismatchFails(t *testing.T) {
	store := NewInMemoryStore()
	service := NewOrganizationsTeams(store)

	// Create org with user1 as owner
	user1 := User{ID: "user1", Email: "user1@example.com"}
	org, err := service.CreateOrg(user1, "TestOrg")
	if err != nil {
		t.Fatalf("Failed to create org: %v", err)
	}

	// Invite user2
	rawToken, err := service.Invite(user1, org.ID, "user2@example.com", RoleMember)
	if err != nil {
		t.Fatalf("Failed to invite user2: %v", err)
	}

	// Manually expire the invitation
	tokenHash := hashToken(rawToken)
	invitation, err := store.GetInvitationByTokenHash(tokenHash)
	if err != nil {
		t.Fatalf("Failed to get invitation: %v", err)
	}
	invitation.ExpiresAt = time.Now().Add(-1 * time.Hour)
	err = store.UpdateInvitation(invitation)
	if err != nil {
		t.Fatalf("Failed to update invitation: %v", err)
	}

	// Try to accept expired invitation
	user2 := User{ID: "user2", Email: "user2@example.com"}
	_, err = service.AcceptInvitation(user2, rawToken)
	if err == nil {
		t.Fatal("Expected error when accepting expired invitation")
	}
	if err.Error() != "invitation expired" {
		t.Fatalf("Expected 'invitation expired' error, got: %v", err)
	}

	// Test email mismatch
	rawToken2, err := service.Invite(user1, org.ID, "user3@example.com", RoleMember)
	if err != nil {
		t.Fatalf("Failed to invite user3: %v", err)
	}

	// user2 tries to accept user3's invitation
	user2Wrong := User{ID: "user2", Email: "user2@example.com"}
	_, err = service.AcceptInvitation(user2Wrong, rawToken2)
	if err == nil {
		t.Fatal("Expected error when accepting invitation with wrong email")
	}
	if err.Error() != "email mismatch" {
		t.Fatalf("Expected 'email mismatch' error, got: %v", err)
	}
}

func TestRawTokenNotStoredInDatabase(t *testing.T) {
	store := NewInMemoryStore()
	service := NewOrganizationsTeams(store)

	// Create org with user1 as owner
	user1 := User{ID: "user1", Email: "user1@example.com"}
	org, err := service.CreateOrg(user1, "TestOrg")
	if err != nil {
		t.Fatalf("Failed to create org: %v", err)
	}

	// Invite user2
	rawToken, err := service.Invite(user1, org.ID, "user2@example.com", RoleMember)
	if err != nil {
		t.Fatalf("Failed to invite user2: %v", err)
	}

	// Check that the raw token is not stored in the invitation
	tokenHash := hashToken(rawToken)
	invitation, err := store.GetInvitationByTokenHash(tokenHash)
	if err != nil {
		t.Fatalf("Failed to get invitation: %v", err)
	}

	// The token hash should not equal the raw token
	if invitation.TokenHash == rawToken {
		t.Fatal("Raw token should not be stored in the database")
	}

	// The token hash should be a SHA-256 hash of the raw token
	expectedHash := hashToken(rawToken)
	if invitation.TokenHash != expectedHash {
		t.Fatalf("Expected token hash %s, got %s", expectedHash, invitation.TokenHash)
	}
}