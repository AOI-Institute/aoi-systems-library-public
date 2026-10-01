using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace AOI.Rbac
{
    // ─────────────────────────────────────────────────────────────────────────
    // Tier hierarchy: public < member < admin < owner (each level includes lower)
    // ─────────────────────────────────────────────────────────────────────────
    public enum Tier
    {
        Public = 0,
        Member = 1,
        Admin = 2,
        Owner = 3
    }

    public class User
    {
        public Guid Id { get; set; }
        public string Email { get; set; } = string.Empty;
        public Tier Tier { get; set; }
        public Guid? OrganizationId { get; set; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Error response shapes (must match spec JSON exactly)
    // ─────────────────────────────────────────────────────────────────────────
    public class ErrorResponse
    {
        public string Error { get; set; } = string.Empty;
        public int? Code { get; set; }
        public string? Message { get; set; }

        public static ErrorResponse PermissionDenied(string code, int httpStatus, string? message = null)
            => new ErrorResponse { Error = code, Code = httpStatus, Message = message };

        public static ErrorResponse OwnerOnly()
            => new ErrorResponse { Error = "owner_only", Code = 403, Message = "Owner access required" };

        public static ErrorResponse AdminOnly()
            => new ErrorResponse { Error = "admin_only", Code = 403, Message = "Admin access required" };

        public static ErrorResponse AuthenticationRequired()
            => new ErrorResponse { Error = "authentication_required", Code = 401, Message = "Authentication required" };

        public string ToJson() => JsonSerializer.Serialize(this);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Audit log entry
    // ─────────────────────────────────────────────────────────────────────────
    public class AuditLogEntry
    {
        public Guid Id { get; set; } = Guid.NewGuid();
        public string Action { get; set; } = string.Empty;
        public Guid? UserId { get; set; }
        public string? Endpoint { get; set; }
        public string? RequiredTier { get; set; }
        public string? UserTier { get; set; }
        public string Decision { get; set; } = string.Empty; // "PASS" | "FAIL"
        public Dictionary<string, int>? DeletedItems { get; set; }
        public string? DeploymentId { get; set; }
        public string? OrganizationId { get; set; }
        public DateTime TimestampUtc { get; set; } = DateTime.UtcNow;

        public string ToJson() => JsonSerializer.Serialize(this);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Audit log store (in-memory, thread-safe)
    // ─────────────────────────────────────────────────────────────────────────
    public class AuditLogStore
    {
        private readonly List<AuditLogEntry> _entries = new();
        private readonly object _lock = new();

        public void Log(AuditLogEntry entry)
        {
            lock (_lock)
            {
                _entries.Add(entry);
            }
        }

        public IReadOnlyList<AuditLogEntry> GetAll()
        {
            lock (_lock)
            {
                return _entries.ToList();
            }
        }

        public IReadOnlyList<AuditLogEntry> QueryByAction(string action)
        {
            lock (_lock)
            {
                return _entries.Where(e => e.Action == action).ToList();
            }
        }

        public IReadOnlyList<AuditLogEntry> QueryByUserId(Guid userId)
        {
            lock (_lock)
            {
                return _entries.Where(e => e.UserId == userId).ToList();
            }
        }

        public IReadOnlyList<AuditLogEntry> QueryByDecision(string decision)
        {
            lock (_lock)
            {
                return _entries.Where(e => e.Decision == decision).ToList();
            }
        }

        public void Clear()
        {
            lock (_lock)
            {
                _entries.Clear();
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Permission check result
    // ─────────────────────────────────────────────────────────────────────────
    public class PermissionCheckResult
    {
        public bool Allowed { get; set; }
        public ErrorResponse? Error { get; set; }
        public AuditLogEntry? AuditEntry { get; set; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Permission middleware / guard
    // ─────────────────────────────────────────────────────────────────────────
    public class PermissionGuard
    {
        private readonly AuditLogStore _auditLog;

        public PermissionGuard(AuditLogStore auditLog)
        {
            _auditLog = auditLog;
        }

        /// <summary>
        /// require_owner: only owner tier passes.
        /// </summary>
        public PermissionCheckResult RequireOwner(User? currentUser, string endpoint)
        {
            var userTier = currentUser?.Tier.ToString() ?? "none";
            var requiredTier = "owner";

            if (currentUser == null)
            {
                var error = ErrorResponse.AuthenticationRequired();
                var audit = new AuditLogEntry
                {
                    Action = "permission_check",
                    UserId = null,
                    Endpoint = endpoint,
                    RequiredTier = requiredTier,
                    UserTier = userTier,
                    Decision = "FAIL"
                };
                _auditLog.Log(audit);
                return new PermissionCheckResult { Allowed = false, Error = error, AuditEntry = audit };
            }

            if (currentUser.Tier != Tier.Owner)
            {
                var error = ErrorResponse.OwnerOnly();
                var audit = new AuditLogEntry
                {
                    Action = "permission_check",
                    UserId = currentUser.Id,
                    Endpoint = endpoint,
                    RequiredTier = requiredTier,
                    UserTier = userTier,
                    Decision = "FAIL"
                };
                _auditLog.Log(audit);
                return new PermissionCheckResult { Allowed = false, Error = error, AuditEntry = audit };
            }

            var passAudit = new AuditLogEntry
            {
                Action = "permission_check",
                UserId = currentUser.Id,
                Endpoint = endpoint,
                RequiredTier = requiredTier,
                UserTier = userTier,
                Decision = "PASS"
            };
            _auditLog.Log(passAudit);
            return new PermissionCheckResult { Allowed = true, AuditEntry = passAudit };
        }

        /// <summary>
        /// require_admin: admin or owner tier passes.
        /// </summary>
        public PermissionCheckResult RequireAdmin(User? currentUser, string endpoint)
        {
            var userTier = currentUser?.Tier.ToString() ?? "none";
            var requiredTier = "admin";

            if (currentUser == null)
            {
                var error = ErrorResponse.AuthenticationRequired();
                var audit = new AuditLogEntry
                {
                    Action = "permission_check",
                    UserId = null,
                    Endpoint = endpoint,
                    RequiredTier = requiredTier,
                    UserTier = userTier,
                    Decision = "FAIL"
                };
                _auditLog.Log(audit);
                return new PermissionCheckResult { Allowed = false, Error = error, AuditEntry = audit };
            }

            if (currentUser.Tier != Tier.Admin && currentUser.Tier != Tier.Owner)
            {
                var error = ErrorResponse.AdminOnly();
                var audit = new AuditLogEntry
                {
                    Action = "permission_check",
                    UserId = currentUser.Id,
                    Endpoint = endpoint,
                    RequiredTier = requiredTier,
                    UserTier = userTier,
                    Decision = "FAIL"
                };
                _auditLog.Log(audit);
                return new PermissionCheckResult { Allowed = false, Error = error, AuditEntry = audit };
            }

            var passAudit = new AuditLogEntry
            {
                Action = "permission_check",
                UserId = currentUser.Id,
                Endpoint = endpoint,
                RequiredTier = requiredTier,
                UserTier = userTier,
                Decision = "PASS"
            };
            _auditLog.Log(passAudit);
            return new PermissionCheckResult { Allowed = true, AuditEntry = passAudit };
        }

        /// <summary>
        /// require_authenticated: any non-null user passes.
        /// </summary>
        public PermissionCheckResult RequireAuthenticated(User? currentUser, string endpoint)
        {
            var userTier = currentUser?.Tier.ToString() ?? "none";
            var requiredTier = "authenticated";

            if (currentUser == null)
            {
                var error = ErrorResponse.AuthenticationRequired();
                var audit = new AuditLogEntry
                {
                    Action = "permission_check",
                    UserId = null,
                    Endpoint = endpoint,
                    RequiredTier = requiredTier,
                    UserTier = userTier,
                    Decision = "FAIL"
                };
                _auditLog.Log(audit);
                return new PermissionCheckResult { Allowed = false, Error = error, AuditEntry = audit };
            }

            var passAudit = new AuditLogEntry
            {
                Action = "permission_check",
                UserId = currentUser.Id,
                Endpoint = endpoint,
                RequiredTier = requiredTier,
                UserTier = userTier,
                Decision = "PASS"
            };
            _auditLog.Log(passAudit);
            return new PermissionCheckResult { Allowed = true, AuditEntry = passAudit };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cascade delete context (simulates transactional data store)
    // ─────────────────────────────────────────────────────────────────────────
    public class CascadeDeleteContext
    {
        public List<Guid> Sessions { get; set; } = new();
        public List<Guid> ApiKeys { get; set; } = new();
        public List<Guid> Files { get; set; } = new();
        public List<string> Preferences { get; set; } = new();
        public List<string> DnsRecords { get; set; } = new();
        public List<string> ThemeConfigs { get; set; } = new();
        public List<string> DeploymentLogs { get; set; } = new();
        public List<Guid> Deployments { get; set; } = new();
        public List<Guid> Users { get; set; } = new();
        public List<Guid> OrgApiKeys { get; set; } = new();
        public List<Guid> OrgSessions { get; set; } = new();
        public bool ArchivedToS3 { get; set; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cascade delete service (transactional with rollback)
    // ─────────────────────────────────────────────────────────────────────────
    public class CascadeDeleteService
    {
        private readonly AuditLogStore _auditLog;

        public CascadeDeleteService(AuditLogStore auditLog)
        {
            _auditLog = auditLog;
        }

        /// <summary>
        /// delete_user cascade:
        ///   delete_all_sessions, delete_all_api_keys, delete_all_files, clear_preferences
        ///   Log: audit_log(action="user_deleted_cascade", user_id, deleted_items={sessions: N, keys: M, files: K})
        /// </summary>
        public (bool Success, ErrorResponse? Error) DeleteUser(Guid userId, CascadeDeleteContext context)
        {
            try
            {
                // Simulate transactional deletes
                var sessionsDeleted = context.Sessions.Count;
                var keysDeleted = context.ApiKeys.Count;
                var filesDeleted = context.Files.Count;
                var prefsCleared = context.Preferences.Count;

                // Execute deletes (in a real system this would be a DB transaction)
                context.Sessions.Clear();
                context.ApiKeys.Clear();
                context.Files.Clear();
                context.Preferences.Clear();

                var deletedItems = new Dictionary<string, int>
                {
                    { "sessions", sessionsDeleted },
                    { "keys", keysDeleted },
                    { "files", filesDeleted },
                    { "preferences", prefsCleared }
                };

                _auditLog.Log(new AuditLogEntry
                {
                    Action = "user_deleted_cascade",
                    UserId = userId,
                    DeletedItems = deletedItems
                });

                return (true, null);
            }
            catch (Exception)
            {
                // Rollback: restore context (in real system, DB transaction rollback)
                // For simulation, we re-populate from a snapshot taken before
                // In production this is handled by the DB transaction manager
                throw;
            }
        }

        /// <summary>
        /// delete_deployment cascade:
        ///   delete_all_dns_records, delete_all_theme_configs, delete_all_deployment_logs, archive to S3
        ///   Log: audit_log(action="deployment_deleted_cascade", deployment_id, deleted_items={dns: N, ...})
        /// </summary>
        public (bool Success, ErrorResponse? Error) DeleteDeployment(Guid deploymentId, CascadeDeleteContext context)
        {
            try
            {
                var dnsDeleted = context.DnsRecords.Count;
                var themesDeleted = context.ThemeConfigs.Count;
                var logsDeleted = context.DeploymentLogs.Count;

                context.DnsRecords.Clear();
                context.ThemeConfigs.Clear();
                context.DeploymentLogs.Clear();
                context.ArchivedToS3 = true;

                var deletedItems = new Dictionary<string, int>
                {
                    { "dns", dnsDeleted },
                    { "theme_configs", themesDeleted },
                    { "deployment_logs", logsDeleted },
                    { "archived_to_s3", context.ArchivedToS3 ? 1 : 0 }
                };

                _auditLog.Log(new AuditLogEntry
                {
                    Action = "deployment_deleted_cascade",
                    DeploymentId = deploymentId.ToString(),
                    DeletedItems = deletedItems
                });

                return (true, null);
            }
            catch (Exception)
            {
                throw;
            }
        }

        /// <summary>
        /// delete_organization cascade:
        ///   delete_all_deployments, delete_all_users, delete_all_api_keys, revoke_all_sessions
        ///   Log: audit_log(action="org_deleted_cascade", org_id, deleted_items={deployments: N, users: M, ...})
        /// </summary>
        public (bool Success, ErrorResponse? Error) DeleteOrganization(Guid orgId, CascadeDeleteContext context)
        {
            try
            {
                var deploymentsDeleted = context.Deployments.Count;
                var usersDeleted = context.Users.Count;
                var apiKeysDeleted = context.OrgApiKeys.Count;
                var sessionsRevoked = context.OrgSessions.Count;

                context.Deployments.Clear();
                context.Users.Clear();
                context.OrgApiKeys.Clear();
                context.OrgSessions.Clear();

                var deletedItems = new Dictionary<string, int>
                {
                    { "deployments", deploymentsDeleted },
                    { "users", usersDeleted },
                    { "api_keys", apiKeysDeleted },
                    { "sessions", sessionsRevoked }
                };

                _auditLog.Log(new AuditLogEntry
                {
                    Action = "org_deleted_cascade",
                    OrganizationId = orgId.ToString(),
                    DeletedItems = deletedItems
                });

                return (true, null);
            }
            catch (Exception)
            {
                throw;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Transactional cascade wrapper (rollback on error)
    // ─────────────────────────────────────────────────────────────────────────
    public class TransactionalCascadeService
    {
        private readonly CascadeDeleteService _cascadeService;
        private readonly AuditLogStore _auditLog;

        public TransactionalCascadeService(CascadeDeleteService cascadeService, AuditLogStore auditLog)
        {
            _cascadeService = cascadeService;
            _auditLog = auditLog;
        }

        public (bool Success, ErrorResponse? Error) DeleteUserTransactional(Guid userId, CascadeDeleteContext context)
        {
            // Snapshot for rollback
            var snapshot = new CascadeDeleteContext
            {
                Sessions = new List<Guid>(context.Sessions),
                ApiKeys = new List<Guid>(context.ApiKeys),
                Files = new List<Guid>(context.Files),
                Preferences = new List<string>(context.Preferences)
            };

            try
            {
                return _cascadeService.DeleteUser(userId, context);
            }
            catch (Exception)
            {
                // Rollback
                context.Sessions = snapshot.Sessions;
                context.ApiKeys = snapshot.ApiKeys;
                context.Files = snapshot.Files;
                context.Preferences = snapshot.Preferences;
                return (false, ErrorResponse.PermissionDenied("cascade_rollback", 500, "Cascade delete failed, transaction rolled back"));
            }
        }

        public (bool Success, ErrorResponse? Error) DeleteDeploymentTransactional(Guid deploymentId, CascadeDeleteContext context)
        {
            var snapshot = new CascadeDeleteContext
            {
                DnsRecords = new List<string>(context.DnsRecords),
                ThemeConfigs = new List<string>(context.ThemeConfigs),
                DeploymentLogs = new List<string>(context.DeploymentLogs),
                ArchivedToS3 = context.ArchivedToS3
            };

            try
            {
                return _cascadeService.DeleteDeployment(deploymentId, context);
            }
            catch (Exception)
            {
                context.DnsRecords = snapshot.DnsRecords;
                context.ThemeConfigs = snapshot.ThemeConfigs;
                context.DeploymentLogs = snapshot.DeploymentLogs;
                context.ArchivedToS3 = snapshot.ArchivedToS3;
                return (false, ErrorResponse.PermissionDenied("cascade_rollback", 500, "Cascade delete failed, transaction rolled back"));
            }
        }

        public (bool Success, ErrorResponse? Error) DeleteOrganizationTransactional(Guid orgId, CascadeDeleteContext context)
        {
            var snapshot = new CascadeDeleteContext
            {
                Deployments = new List<Guid>(context.Deployments),
                Users = new List<Guid>(context.Users),
                OrgApiKeys = new List<Guid>(context.OrgApiKeys),
                OrgSessions = new List<Guid>(context.OrgSessions)
            };

            try
            {
                return _cascadeService.DeleteOrganization(orgId, context);
            }
            catch (Exception)
            {
                context.Deployments = snapshot.Deployments;
                context.Users = snapshot.Users;
                context.OrgApiKeys = snapshot.OrgApiKeys;
                context.OrgSessions = snapshot.OrgSessions;
                return (false, ErrorResponse.PermissionDenied("cascade_rollback", 500, "Cascade delete failed, transaction rolled back"));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RBAC System facade
    // ─────────────────────────────────────────────────────────────────────────
    public class RbacSystem
    {
        public AuditLogStore AuditLog { get; }
        public PermissionGuard Guard { get; }
        public CascadeDeleteService CascadeService { get; }
        public TransactionalCascadeService TransactionalService { get; }

        public RbacSystem()
        {
            AuditLog = new AuditLogStore();
            Guard = new PermissionGuard(AuditLog);
            CascadeService = new CascadeDeleteService(AuditLog);
            TransactionalService = new TransactionalCascadeService(CascadeService, AuditLog);
        }

        public RbacSystem(AuditLogStore auditLog)
        {
            AuditLog = auditLog;
            Guard = new PermissionGuard(auditLog);
            CascadeService = new CascadeDeleteService(auditLog);
            TransactionalService = new TransactionalCascadeService(CascadeService, auditLog);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Database schema (executable DDL)
    // ─────────────────────────────────────────────────────────────────────────
    public static class RbacSchema
    {
        public const string Ddl = @"
-- RBAC & Permissions Schema
-- Tier hierarchy: public(0) < member(1) < admin(2) < owner(3)

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    tier            SMALLINT NOT NULL DEFAULT 0 CHECK (tier IN (0, 1, 2, 3)),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(512) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash        VARCHAR(512) NOT NULL,
    name            VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename        VARCHAR(512) NOT NULL,
    storage_path    VARCHAR(1024) NOT NULL,
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS preferences (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key             VARCHAR(255) NOT NULL,
    value           TEXT,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS deployments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dns_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id   UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    record_type     VARCHAR(20) NOT NULL,
    hostname        VARCHAR(512) NOT NULL,
    value           VARCHAR(512) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS theme_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id   UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    theme_name      VARCHAR(255) NOT NULL,
    config_json     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deployment_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id   UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    level           VARCHAR(20) NOT NULL,
    message         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action          VARCHAR(100) NOT NULL,
    user_id         UUID,
    endpoint        VARCHAR(512),
    required_tier   VARCHAR(50),
    user_tier       VARCHAR(50),
    decision        VARCHAR(10) NOT NULL CHECK (decision IN ('PASS', 'FAIL')),
    deleted_items   JSONB,
    deployment_id   UUID,
    organization_id UUID,
    timestamp_utc   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_decision ON audit_log(decision);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp_utc);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_org_id ON deployments(organization_id);
CREATE INDEX IF NOT EXISTS idx_dns_deployment_id ON dns_records(deployment_id);
CREATE INDEX IF NOT EXISTS idx_theme_deployment_id ON theme_configs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_logs_deployment_id ON deployment_logs(deployment_id);
";
    }
}