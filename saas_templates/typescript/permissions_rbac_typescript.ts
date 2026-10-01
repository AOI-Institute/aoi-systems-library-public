import { performance } from "perf_hooks";

/* ---------- Types & Enums ---------- */
export type Tier = "public" | "member" | "admin" | "owner";

export interface User {
  id: string;
  tier: Tier;
}

export interface AuditEntry {
  timestamp: string; // UTC ISO 8601
  action: string;
  userId?: string;
  endpoint?: string;
  requiredTier?: Tier;
  userTier?: Tier;
  decision?: "PASS" | "FAIL";
  details?: any;
}

/* ---------- In‑Memory DB ---------- */
class InMemoryDB {
  // Primary tables
  users = new Map<string, User>();
  sessions = new Map<string, { userId: string }>();
  apiKeys = new Map<string, { userId: string }>();
  files = new Map<string, { ownerId: string }>();
  preferences = new Map<string, { userId: string }>();

  deployments = new Map<string, { orgId: string }>();
  dnsRecords = new Map<string, { deploymentId: string }>();
  themeConfigs = new Map<string, { deploymentId: string }>();
  deploymentLogs = new Map<string, { deploymentId: string }>();

  organizations = new Map<string, { }>();
  orgDeployments = new Map<string, Set<string>>(); // orgId -> deploymentIds
  orgUsers = new Map<string, Set<string>>(); // orgId -> userIds

  // Audit log
  auditLog: AuditEntry[] = [];

  // Transaction support (simple copy‑on‑write)
  private snapshot?: {
    users: Map<string, User>;
    sessions: Map<string, { userId: string }>;
    apiKeys: Map<string, { userId: string }>;
    files: Map<string, { ownerId: string }>;
    preferences: Map<string, { userId: string }>;
    deployments: Map<string, { orgId: string }>;
    dnsRecords: Map<string, { deploymentId: string }>;
    themeConfigs: Map<string, { deploymentId: string }>;
    deploymentLogs: Map<string, { deploymentId: string }>;
    organizations: Map<string, {}>;
    orgDeployments: Map<string, Set<string>>;
    orgUsers: Map<string, Set<string>>;
  } | null = null;

  beginTransaction() {
    this.snapshot = {
      users: new Map(this.users),
      sessions: new Map(this.sessions),
      apiKeys: new Map(this.apiKeys),
      files: new Map(this.files),
      preferences: new Map(this.preferences),
      deployments: new Map(this.deployments),
      dnsRecords: new Map(this.dnsRecords),
      themeConfigs: new Map(this.themeConfigs),
      deploymentLogs: new Map(this.deploymentLogs),
      organizations: new Map(this.organizations),
      orgDeployments: new Map(this.orgDeployments),
      orgUsers: new Map(this.orgUsers),
    };
  }

  commitTransaction() {
    this.snapshot = null;
  }

  rollbackTransaction() {
    if (this.snapshot) {
      this.users = this.snapshot.users;
      this.sessions = this.snapshot.sessions;
      this.apiKeys = this.snapshot.apiKeys;
      this.files = this.snapshot.files;
      this.preferences = this.snapshot.preferences;
      this.deployments = this.snapshot.deployments;
      this.dnsRecords = this.snapshot.dnsRecords;
      this.themeConfigs = this.snapshot.themeConfigs;
      this.deploymentLogs = this.snapshot.deploymentLogs;
      this.organizations = this.snapshot.organizations;
      this.orgDeployments = this.snapshot.orgDeployments;
      this.orgUsers = this.snapshot.orgUsers;
      this.snapshot = null;
    }
  }

  /* ---------- Audit ---------- */
  log(entry: AuditEntry) {
    entry.timestamp = new Date().toISOString();
    this.auditLog.push(entry);
  }

  /* ---------- DDL (for reference) ---------- */
  getDDL(): string {
    return `
CREATE TABLE users (id TEXT PRIMARY KEY, tier TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
CREATE TABLE files (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id));
CREATE TABLE preferences (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));

CREATE TABLE organizations (id TEXT PRIMARY KEY);
CREATE TABLE org_users (org_id TEXT, user_id TEXT);
CREATE TABLE org_deployments (org_id TEXT, deployment_id TEXT);

CREATE TABLE deployments (id TEXT PRIMARY KEY, org_id TEXT REFERENCES organizations(id));
CREATE TABLE dns_records (id TEXT PRIMARY KEY, deployment_id TEXT REFERENCES deployments(id));
CREATE TABLE theme_configs (id TEXT PRIMARY KEY, deployment_id TEXT REFERENCES deployments(id));
CREATE TABLE deployment_logs (id TEXT PRIMARY KEY, deployment_id TEXT REFERENCES deployments(id));

CREATE TABLE audit_log (timestamp TEXT, action TEXT, user_id TEXT, endpoint TEXT,
                        required_tier TEXT, user_tier TEXT, decision TEXT, details TEXT);
`;
  }
}

/* ---------- Singleton DB Instance ---------- */
export const db = new InMemoryDB();

/* ---------- Errors ---------- */
export class HttpError extends Error {
  public code: number;
  public error: string;
  constructor(error: string, message: string, code: number) {
    super(message);
    this.error = error;
    this.code = code;
  }
}

/* ---------- Permission Middleware ---------- */
function auditPermissionCheck(
  user: User | null,
  endpoint: string,
  requiredTier: Tier,
  decision: "PASS" | "FAIL"
) {
  db.log({
    action: "permission_check",
    userId: user?.id,
    endpoint,
    requiredTier,
    userTier: user?.tier,
    decision,
  });
}

function requireOwner(currentUser: User | null, endpoint: string): void {
  const start = performance.now();
  if (!currentUser) {
    auditPermissionCheck(null, endpoint, "owner", "FAIL");
    throw new HttpError("authentication_required", "Authentication required", 401);
  }
  if (currentUser.tier !== "owner") {
    auditPermissionCheck(currentUser, endpoint, "owner", "FAIL");
    throw new HttpError("owner_only", "Owner only action", 403);
  }
  auditPermissionCheck(currentUser, endpoint, "owner", "PASS");
  const elapsed = performance.now() - start;
  if (elapsed > 10) console.warn(`Permission check >10ms: ${elapsed}ms`);
}

function requireAdmin(currentUser: User | null, endpoint: string): void {
  const start = performance.now();
  if (!currentUser) {
    auditPermissionCheck(null, endpoint, "admin", "FAIL");
    throw new HttpError("authentication_required", "Authentication required", 401);
  }
  if (!["admin", "owner"].includes(currentUser.tier)) {
    auditPermissionCheck(currentUser, endpoint, "admin", "FAIL");
    throw new HttpError("admin_only", "Admin only action", 403);
  }
  auditPermissionCheck(currentUser, endpoint, "admin", "PASS");
  const elapsed = performance.now() - start;
  if (elapsed > 10) console.warn(`Permission check >10ms: ${elapsed}ms`);
}

function requireAuthenticated(currentUser: User | null, endpoint: string): void {
  const start = performance.now();
  if (!currentUser) {
    auditPermissionCheck(null, endpoint, "public", "FAIL");
    throw new HttpError("authentication_required", "Authentication required", 401);
  }
  auditPermissionCheck(currentUser, endpoint, "public", "PASS");
  const elapsed = performance.now() - start;
  if (elapsed > 10) console.warn(`Permission check >10ms: ${elapsed}ms`);
}

/* ---------- Example Endpoints ---------- */
export function adminCreateUser(currentUser: User | null, newUser: User) {
  requireOwner(currentUser, "adminCreateUser");
  if (db.users.has(newUser.id)) {
    throw new HttpError("conflict", "User already exists", 409);
  }
  db.users.set(newUser.id, newUser);
  return { success: true };
}

export function adminListCustomers(currentUser: User | null) {
  requireAdmin(currentUser, "adminListCustomers");
  // For demo, return all organization IDs
  return Array.from(db.organizations.keys());
}

/* ---------- Cascade Delete Implementations ---------- */
export function deleteUser(userId: string) {
  const user = db.users.get(userId);
  if (!user) {
    throw new HttpError("not_found", "User not found", 404);
  }
  db.beginTransaction();
  try {
    // Delete sessions
    let deletedSessions = 0;
    for (const [sid, sess] of db.sessions) {
      if (sess.userId === userId) {
        db.sessions.delete(sid);
        deletedSessions++;
      }
    }
    // Delete API keys
    let deletedKeys = 0;
    for (const [kid, key] of db.apiKeys) {
      if (key.userId === userId) {
        db.apiKeys.delete(kid);
        deletedKeys++;
      }
    }
    // Delete files
    let deletedFiles = 0;
    for (const [fid, file] of db.files) {
      if (file.ownerId === userId) {
        db.files.delete(fid);
        deletedFiles++;
      }
    }
    // Clear preferences
    let deletedPrefs = 0;
    for (const [pid, pref] of db.preferences) {
      if (pref.userId === userId) {
        db.preferences.delete(pid);
        deletedPrefs++;
      }
    }
    // Finally delete user
    db.users.delete(userId);

    db.log({
      action: "user_deleted_cascade",
      userId,
      details: {
        sessions: deletedSessions,
        keys: deletedKeys,
        files: deletedFiles,
        preferences: deletedPrefs,
      },
    });
    db.commitTransaction();
    return { success: true };
  } catch (e) {
    db.rollbackTransaction();
    throw e;
  }
}

export function deleteDeployment(deploymentId: string) {
  const deployment = db.deployments.get(deploymentId);
  if (!deployment) {
    throw new HttpError("not_found", "Deployment not found", 404);
  }
  db.beginTransaction();
  try {
    // Delete DNS records
    let deletedDns = 0;
    for (const [did, dns] of db.dnsRecords) {
      if (dns.deploymentId === deploymentId) {
        db.dnsRecords.delete(did);
        deletedDns++;
      }
    }
    // Delete theme configs
    let deletedThemes = 0;
    for (const [tid, theme] of db.themeConfigs) {
      if (theme.deploymentId === deploymentId) {
        db.themeConfigs.delete(tid);
        deletedThemes++;
      }
    }
    // Delete deployment logs
    let deletedLogs = 0;
    for (const [lid, log] of db.deploymentLogs) {
      if (log.deploymentId === deploymentId) {
        db.deploymentLogs.delete(lid);
        deletedLogs++;
      }
    }
    // Archive to S3 placeholder (no-op)
    const archived = true;

    // Remove from orgDeployments map
    const orgId = deployment.orgId;
    const set = db.orgDeployments.get(orgId);
    if (set) set.delete(deploymentId);

    // Delete deployment itself
    db.deployments.delete(deploymentId);

    db.log({
      action: "deployment_deleted_cascade",
      userId: null,
      details: {
        deploymentId,
        dns: deletedDns,
        themes: deletedThemes,
        logs: deletedLogs,
        archived,
      },
    });
    db.commitTransaction();
    return { success: true };
  } catch (e) {
    db.rollbackTransaction();
    throw e;
  }
}

export function deleteOrganization(orgId: string) {
  const org = db.organizations.get(orgId);
  if (!org) {
    throw new HttpError("not_found", "Organization not found", 404);
  }
  db.beginTransaction();
  try {
    // Delete deployments
    const deployments = db.orgDeployments.get(orgId) ?? new Set<string>();
    let deletedDeployments = 0;
    for (const depId of deployments) {
      deleteDeployment(depId);
      deletedDeployments++;
    }
    db.orgDeployments.delete(orgId);

    // Delete users
    const users = db.orgUsers.get(orgId) ?? new Set<string>();
    let deletedUsers = 0;
    for (const uid of users) {
      deleteUser(uid);
      deletedUsers++;
    }
    db.orgUsers.delete(orgId);

    // Delete API keys belonging to org users (already removed by deleteUser)

    // Revoke sessions (already removed by deleteUser)

    // Delete organization record
    db.organizations.delete(orgId);

    db.log({
      action: "org_deleted_cascade",
      userId: null,
      details: {
        orgId,
        deployments: deletedDeployments,
        users: deletedUsers,
      },
    });
    db.commitTransaction();
    return { success: true };
  } catch (e) {
    db.rollbackTransaction();
    throw e;
  }
}

/* ---------- Exported Middleware for external use ---------- */
export const permissionMiddleware = {
  requireOwner,
  requireAdmin,
  requireAuthenticated,
};