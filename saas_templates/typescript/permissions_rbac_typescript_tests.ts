import { db, permissionMiddleware, HttpError, User, adminCreateUser, adminListCustomers, deleteUser, deleteDeployment, deleteOrganization } from "./permissions_rbac_typescript";
import { performance } from "perf_hooks";

function resetDB() {
  db.users.clear();
  db.sessions.clear();
  db.apiKeys.clear();
  db.files.clear();
  db.preferences.clear();
  db.deployments.clear();
  db.dnsRecords.clear();
  db.themeConfigs.clear();
  db.deploymentLogs.clear();
  db.organizations.clear();
  db.orgDeployments.clear();
  db.orgUsers.clear();
  db.auditLog = [];
}

/* ---------- Helper to create users ---------- */
function makeUser(id: string, tier: Tier): User {
  const u: User = { id, tier };
  db.users.set(id, u);
  return u;
}

/* ---------- Tests ---------- */
describe("Permission Middleware", () => {
  beforeEach(() => {
    resetDB();
  });

  test("require_owner on non-owner → 403", () => {
    const user = makeUser("u1", "admin");
    expect(() => permissionMiddleware.requireOwner(user, "test")).toThrow(HttpError);
    try {
      permissionMiddleware.requireOwner(user, "test");
    } catch (e) {
      const err = e as HttpError;
      expect(err.code).toBe(403);
      expect(err.error).toBe("owner_only");
    }
  });

  test("require_admin on member → 403", () => {
    const user = makeUser("u2", "member");
    expect(() => permissionMiddleware.requireAdmin(user, "test")).toThrow(HttpError);
    try {
      permissionMiddleware.requireAdmin(user, "test");
    } catch (e) {
      const err = e as HttpError;
      expect(err.code).toBe(403);
      expect(err.error).toBe("admin_only");
    }
  });

  test("require_authenticated on public → 401", () => {
    expect(() => permissionMiddleware.requireAuthenticated(null, "test")).toThrow(HttpError);
    try {
      permissionMiddleware.requireAuthenticated(null, "test");
    } catch (e) {
      const err = e as HttpError;
      expect(err.code).toBe(401);
      expect(err.error).toBe("authentication_required");
    }
  });

  test("tier hierarchy – member cannot do admin actions", () => {
    const member = makeUser("u3", "member");
    expect(() => permissionMiddleware.requireAdmin(member, "adminEndpoint")).toThrow(HttpError);
  });

  test("tier hierarchy – admin cannot do owner actions", () => {
    const admin = makeUser("u4", "admin");
    expect(() => permissionMiddleware.requireOwner(admin, "ownerEndpoint")).toThrow(HttpError);
  });

  test("permission check response time < 10ms", () => {
    const admin = makeUser("u5", "admin");
    const start = performance.now();
    permissionMiddleware.requireAdmin(admin, "fastCheck");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});

describe("Cascade Delete", () => {
  beforeEach(() => {
    resetDB();
  });

  test("cascade_delete user → all related records deleted in transaction", () => {
    const user = makeUser("u10", "member");
    // create related records
    db.sessions.set("s1", { userId: "u10" });
    db.apiKeys.set("k1", { userId: "u10" });
    db.files.set("f1", { ownerId: "u10" });
    db.preferences.set("p1", { userId: "u10" });

    const result = deleteUser("u10");
    expect(result.success).toBe(true);
    expect(db.sessions.has("s1")).toBe(false);
    expect(db.apiKeys.has("k1")).toBe(false);
    expect(db.files.has("f1")).toBe(false);
    expect(db.preferences.has("p1")).toBe(false);
    expect(db.users.has("u10")).toBe(false);
  });

  test("cascade_delete deployment → all related records deleted", () => {
    const orgId = "org1";
    db.organizations.set(orgId, {});
    db.deployments.set("d1", { orgId });
    db.dnsRecords.set("dns1", { deploymentId: "d1" });
    db.themeConfigs.set("theme1", { deploymentId: "d1" });
    db.deploymentLogs.set("log1", { deploymentId: "d1" });
    db.orgDeployments.set(orgId, new Set(["d1"]));

    const result = deleteDeployment("d1");
    expect(result.success).toBe(true);
    expect(db.deployments.has("d1")).toBe(false);
    expect(db.dnsRecords.has("dns1")).toBe(false);
    expect(db.themeConfigs.has("theme1")).toBe(false);
    expect(db.deploymentLogs.has("log1")).toBe(false);
    expect(db.orgDeployments.get(orgId)?.has("d1")).toBeFalsy();
  });

  test("cascade_delete org → all nested records deleted", () => {
    const orgId = "org2";
    db.organizations.set(orgId, {});
    // users
    const uA = makeUser("uA", "member");
    const uB = makeUser("uB", "admin");
    db.orgUsers.set(orgId, new Set(["uA", "uB"]));
    // deployments
    db.deployments.set("depA", { orgId });
    db.deployments.set("depB", { orgId });
    db.orgDeployments.set(orgId, new Set(["depA", "depB"]));
    // related deployment data
    db.dnsRecords.set("dnsA", { deploymentId: "depA" });
    db.dnsRecords.set("dnsB", { deploymentId: "depB" });

    const result = deleteOrganization(orgId);
    expect(result.success).toBe(true);
    // org removed
    expect(db.organizations.has(orgId)).toBe(false);
    // users removed
    expect(db.users.has("uA")).toBe(false);
    expect(db.users.has("uB")).toBe(false);
    // deployments removed
    expect(db.deployments.has("depA")).toBe(false);
    expect(db.deployments.has("depB")).toBe(false);
    // dns records removed
    expect(db.dnsRecords.has("dnsA")).toBe(false);
    expect(db.dnsRecords.has("dnsB")).toBe(false);
  });

  test("cascade on error → rollback (no partial deletes)", () => {
    const user = makeUser("u_err", "member");
    db.sessions.set("s_err", { userId: "u_err" });
    // Inject error by mocking deleteUser internal loop to throw
    const originalDeleteUser = deleteUser;
    const faultyDeleteUser = (uid: string) => {
      db.beginTransaction();
      try {
        // delete sessions correctly
        for (const [sid, sess] of db.sessions) {
          if (sess.userId === uid) {
            db.sessions.delete(sid);
          }
        }
        // Force error
        throw new Error("forced error");
      } catch (e) {
        db.rollbackTransaction();
        throw e;
      }
    };
    // Replace function temporarily
    (global as any).deleteUser = faultyDeleteUser;
    expect(() => (global as any).deleteUser("u_err")).toThrow(Error);
    // After rollback, session should still exist
    expect(db.sessions.has("s_err")).toBe(true);
    // Restore original
    (global as any).deleteUser = originalDeleteUser;
  });
});

describe("Audit Logging", () => {
  beforeEach(() => {
    resetDB();
  });

  test("permission audit logged → queries show who accessed what", () => {
    const admin = makeUser("admin1", "admin");
    try {
      permissionMiddleware.requireAdmin(admin, "adminListCustomers");
    } catch (_) {}
    const entry = db.auditLog.find(e => e.action === "permission_check" && e.userId === "admin1");
    expect(entry).toBeDefined();
    expect(entry?.endpoint).toBe("adminListCustomers");
    expect(entry?.requiredTier).toBe("admin");
    expect(entry?.decision).toBe("PASS");
  });
});

/* ---------- Run tests ---------- */
if (require.main === module) {
  // Simple runner for environments without jest
  const { run } = require("jest");
  run();
}