package rbac

import (
	"testing"
	"time"
)

func TestRequireOwnerNonOwner(t *testing.T) {
	ResetAllData()
	user := &User{ID: "u1", Tier: TierMember}
	err := RequireOwner(user, "admin_create_user")
	if err == nil {
		t.Fatalf("expected error for non‑owner")
	}
	rbErr, ok := err.(*RBACError)
	if !ok {
		t.Fatalf("expected RBACError, got %T", err)
	}
	if rbErr.Code != 403 || rbErr.Message != "owner_only" {
		t.Fatalf("unexpected error: %+v", rbErr)
	}
	// audit entry should be recorded
	logs := GetAuditLog()
	if len(logs) == 0 {
		t.Fatalf("audit log missing")
	}
	last := logs[len(logs)-1]
	if last.Decision != "FAIL" || last.RequiredTier != TierOwner {
		t.Fatalf("audit entry incorrect: %+v", last)
	}
}

func TestRequireAdminMember(t *testing.T) {
	ResetAllData()
	user := &User{ID: "u2", Tier: TierMember}
	err := RequireAdmin(user, "admin_list_customers")
	if err == nil {
		t.Fatalf("expected error for member on admin check")
	}
	rbErr, ok := err.(*RBACError)
	if !ok {
		t.Fatalf("expected RBACError")
	}
	if rbErr.Code != 403 || rbErr.Message != "admin_only" {
		t.Fatalf("unexpected error: %+v", rbErr)
	}
}

func TestRequireAuthenticatedPublic(t *testing.T) {
	ResetAllData()
	err := RequireAuthenticated(nil, "some_endpoint")
	if err == nil {
		t.Fatalf("expected authentication error")
	}
	rbErr, ok := err.(*RBACError)
	if !ok {
		t.Fatalf("expected RBACError")
	}
	if rbErr.Code != 401 || rbErr.Message != "authentication_required" {
		t.Fatalf("unexpected error: %+v", rbErr)
	}
}

func TestCascadeDeleteUser(t *testing.T) {
	ResetAllData()
	// create user and related records
	user := &User{ID: "u3", Tier: TierMember}
	users[user.ID] = user
	sessions["s1"] = &Session{ID: "s1", UserID: user.ID}
	apiKeys["k1"] = &APIKey{ID: "k1", UserID: user.ID}
	files["f1"] = &File{ID: "f1", OwnerID: user.ID}
	preferences["p1"] = &Preference{ID: "p1", UserID: user.ID}

	if err := DeleteUser(user.ID); err != nil {
		t.Fatalf("DeleteUser returned error: %v", err)
	}
	if _, ok := GetUser(user.ID); ok {
		t.Fatalf("user not deleted")
	}
	if _, ok := GetSession("s1"); ok {
		t.Fatalf("session not deleted")
	}
	if _, ok := GetAPIKey("k1"); ok {
		t.Fatalf("apikey not deleted")
	}
	if _, ok := GetFile("f1"); ok {
		t.Fatalf("file not deleted")
	}
	if _, ok := GetPreference("p1"); ok {
		t.Fatalf("preference not deleted")
	}
	// audit entry
	found := false
	for _, e := range GetAuditLog() {
		if e.Action == "user_deleted_cascade" && e.UserID == user.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("audit log for user cascade missing")
	}
}

func TestCascadeDeleteDeployment(t *testing.T) {
	ResetAllData()
	dep := &Deployment{ID: "d1", OrgID: "org1"}
	deployments[dep.ID] = dep
	dnsRecords["dns1"] = &DNSRecord{ID: "dns1", DeploymentID: dep.ID}
	themeConfigs["tc1"] = &ThemeConfig{ID: "tc1", DeploymentID: dep.ID}
	deploymentLogs["log1"] = &DeploymentLog{ID: "log1", DeploymentID: dep.ID}

	if err := DeleteDeployment(dep.ID); err != nil {
		t.Fatalf("DeleteDeployment error: %v", err)
	}
	if _, ok := GetDeployment(dep.ID); ok {
		t.Fatalf("deployment not deleted")
	}
	if _, ok := GetDNSRecord("dns1"); ok {
		t.Fatalf("dns record not deleted")
	}
	if _, ok := GetThemeConfig("tc1"); ok {
		t.Fatalf("theme config not deleted")
	}
	if _, ok := GetDeploymentLog("log1"); ok {
		t.Fatalf("deployment log not deleted")
	}
}

func TestCascadeDeleteOrganization(t *testing.T) {
	ResetAllData()
	org := &Organization{ID: "orgA"}
	organizations[org.ID] = org

	// deployments under org
	dep := &Deployment{ID: "dA", OrgID: org.ID}
	deployments[dep.ID] = dep

	// users under org (id prefixed with orgID-)
	user := &User{ID: org.ID + "-u1", Tier: TierMember}
	users[user.ID] = user

	// related keys/sessions
	apiKeys["kA"] = &APIKey{ID: "kA", UserID: user.ID}
	sessions["sA"] = &Session{ID: "sA", UserID: user.ID}

	if err := DeleteOrganization(org.ID); err != nil {
		t.Fatalf("DeleteOrganization error: %v", err)
	}
	if _, ok := GetOrganization(org.ID); ok {
		t.Fatalf("organization not deleted")
	}
	if _, ok := GetDeployment(dep.ID); ok {
		t.Fatalf("deployment not deleted")
	}
	if _, ok := GetUser(user.ID); ok {
		t.Fatalf("user not deleted")
	}
	if _, ok := GetAPIKey("kA"); ok {
		t.Fatalf("apikey not deleted")
	}
	if _, ok := GetSession("sA"); ok {
		t.Fatalf("session not deleted")
	}
}

func TestCascadeRollbackOnError(t *testing.T) {
	ResetAllData()
	user := &User{ID: "uRollback", Tier: TierMember}
	users[user.ID] = user
	sessions["sRollback"] = &Session{ID: "sRollback", UserID: user.ID}

	SetCascadeInjectError(true)
	err := DeleteUser(user.ID)
	if err == nil {
		t.Fatalf("expected simulated error")
	}
	// ensure data unchanged
	if _, ok := GetUser(user.ID); !ok {
		t.Fatalf("user should still exist after rollback")
	}
	if _, ok := GetSession("sRollback"); !ok {
		t.Fatalf("session should still exist after rollback")
	}
	SetCascadeInjectError(false)
}

func TestPermissionAuditLogged(t *testing.T) {
	ResetAllData()
	owner := &User{ID: "owner1", Tier: TierOwner}
	users[owner.ID] = owner

	// successful check
	if err := RequireOwner(owner, "admin_create_user"); err != nil {
		t.Fatalf("owner should pass")
	}
	// failed check
	nonOwner := &User{ID: "nonowner", Tier: TierMember}
	_ = RequireOwner(nonOwner, "admin_create_user")

	logs := GetAuditLog()
	var passFound, failFound bool
	for _, e := range logs {
		if e.UserID == owner.ID && e.Decision == "PASS" && e.RequiredTier == TierOwner {
			passFound = true
		}
		if e.UserID == nonOwner.ID && e.Decision == "FAIL" && e.RequiredTier == TierOwner {
			failFound = true
		}
	}
	if !passFound || !failFound {
		t.Fatalf("audit entries for pass/fail missing")
	}
}

func TestTierHierarchy(t *testing.T) {
	ResetAllData()
	owner := &User{ID: "o1", Tier: TierOwner}
	admin := &User{ID: "a1", Tier: TierAdmin}
	member := &User{ID: "m1", Tier: TierMember}

	if err := RequireAdmin(admin, "admin_action"); err != nil {
		t.Fatalf("admin should be allowed")
	}
	if err := RequireOwner(owner, "owner_action"); err != nil {
		t.Fatalf("owner should be allowed")
	}
	if err := RequireOwner(admin, "owner_action"); err == nil {
		t.Fatalf("admin should NOT be allowed owner action")
	}
	if err := RequireAdmin(member, "admin_action"); err == nil {
		t.Fatalf("member should NOT be allowed admin action")
	}
}

func TestPermissionCheckResponseTime(t *testing.T) {
	ResetAllData()
	user := &User{ID: "fast", Tier: TierOwner}
	start := time.Now()
	if err := RequireOwner(user, "fast_endpoint"); err != nil {
		t.Fatalf("owner check failed")
	}
	elapsed := time.Since(start)
	if elapsed > 10*time.Millisecond {
		t.Fatalf("permission check took %v, exceeds 10ms", elapsed)
	}
}