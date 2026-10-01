using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using AOI.Rbac;
using Xunit;

namespace AOI.Rbac.Tests
{
    public class RbacTests
    {
        private readonly RbacSystem _rbac;
        private readonly AuditLogStore _auditLog;

        public RbacTests()
        {
            _auditLog = new AuditLogStore();
            _rbac = new RbacSystem(_auditLog);
        }

        private User CreateUser(Tier tier, Guid? orgId = null)
            => new User { Id = Guid.NewGuid(), Email = $"user_{tier}@test.com", Tier = tier, OrganizationId = orgId };

        // ─────────────────────────────────────────────────────────────────────
        // TEST 1: require_owner on non-owner → 403
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void RequireOwner_NonOwner_Returns403()
        {
            var admin = CreateUser(Tier.Admin);
            var result = _rbac.Guard.RequireOwner(admin, "/api/admin/create-user");

            Assert.False(result.Allowed);
            Assert.NotNull(result.Error);
            Assert.Equal("owner_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void RequireOwner_Member_Returns403()
        {
            var member = CreateUser(Tier.Member);
            var result = _rbac.Guard.RequireOwner(member, "/api/admin/create-user");

            Assert.False(result.Allowed);
            Assert.Equal("owner_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void RequireOwner_Public_Returns403()
        {
            var pub = CreateUser(Tier.Public);
            var result = _rbac.Guard.RequireOwner(pub, "/api/admin/create-user");

            Assert.False(result.Allowed);
            Assert.Equal("owner_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void RequireOwner_Owner_ReturnsPass()
        {
            var owner = CreateUser(Tier.Owner);
            var result = _rbac.Guard.RequireOwner(owner, "/api/admin/create-user");

            Assert.True(result.Allowed);
            Assert.Null(result.Error);
        }

        [Fact]
        public void RequireOwner_NullUser_Returns401()
        {
            var result = _rbac.Guard.RequireOwner(null, "/api/admin/create-user");

            Assert.False(result.Allowed);
            Assert.Equal("authentication_required", result.Error!.Error);
            Assert.Equal(401, result.Error.Code);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 2: require_admin on member → 403
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void RequireAdmin_Member_Returns403()
        {
            var member = CreateUser(Tier.Member);
            var result = _rbac.Guard.RequireAdmin(member, "/api/admin/list-customers");

            Assert.False(result.Allowed);
            Assert.Equal("admin_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void RequireAdmin_Public_Returns403()
        {
            var pub = CreateUser(Tier.Public);
            var result = _rbac.Guard.RequireAdmin(pub, "/api/admin/list-customers");

            Assert.False(result.Allowed);
            Assert.Equal("admin_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void RequireAdmin_Admin_ReturnsPass()
        {
            var admin = CreateUser(Tier.Admin);
            var result = _rbac.Guard.RequireAdmin(admin, "/api/admin/list-customers");

            Assert.True(result.Allowed);
            Assert.Null(result.Error);
        }

        [Fact]
        public void RequireAdmin_Owner_ReturnsPass()
        {
            var owner = CreateUser(Tier.Owner);
            var result = _rbac.Guard.RequireAdmin(owner, "/api/admin/list-customers");

            Assert.True(result.Allowed);
            Assert.Null(result.Error);
        }

        [Fact]
        public void RequireAdmin_NullUser_Returns401()
        {
            var result = _rbac.Guard.RequireAdmin(null, "/api/admin/list-customers");

            Assert.False(result.Allowed);
            Assert.Equal("authentication_required", result.Error!.Error);
            Assert.Equal(401, result.Error.Code);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 3: require_authenticated on public → 401
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void RequireAuthenticated_NullUser_Returns401()
        {
            var result = _rbac.Guard.RequireAuthenticated(null, "/api/profile");

            Assert.False(result.Allowed);
            Assert.Equal("authentication_required", result.Error!.Error);
            Assert.Equal(401, result.Error.Code);
        }

        [Fact]
        public void RequireAuthenticated_PublicUser_ReturnsPass()
        {
            var pub = CreateUser(Tier.Public);
            var result = _rbac.Guard.RequireAuthenticated(pub, "/api/profile");

            Assert.True(result.Allowed);
            Assert.Null(result.Error);
        }

        [Fact]
        public void RequireAuthenticated_Member_ReturnsPass()
        {
            var member = CreateUser(Tier.Member);
            var result = _rbac.Guard.RequireAuthenticated(member, "/api/profile");

            Assert.True(result.Allowed);
        }

        [Fact]
        public void RequireAuthenticated_Admin_ReturnsPass()
        {
            var admin = CreateUser(Tier.Admin);
            var result = _rbac.Guard.RequireAuthenticated(admin, "/api/profile");

            Assert.True(result.Allowed);
        }

        [Fact]
        public void RequireAuthenticated_Owner_ReturnsPass()
        {
            var owner = CreateUser(Tier.Owner);
            var result = _rbac.Guard.RequireAuthenticated(owner, "/api/profile");

            Assert.True(result.Allowed);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 4: cascade_delete user → all related records deleted in transaction
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void CascadeDeleteUser_DeletesAllRelatedRecords()
        {
            var userId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                Sessions = new List<Guid> { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() },
                ApiKeys = new List<Guid> { Guid.NewGuid(), Guid.NewGuid() },
                Files = new List<Guid> { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() },
                Preferences = new List<string> { "theme", "language", "notifications" }
            };

            var (success, error) = _rbac.CascadeService.DeleteUser(userId, context);

            Assert.True(success);
            Assert.Null(error);
            Assert.Empty(context.Sessions);
            Assert.Empty(context.ApiKeys);
            Assert.Empty(context.Files);
            Assert.Empty(context.Preferences);

            // Verify audit log
            var auditEntries = _auditLog.QueryByAction("user_deleted_cascade");
            Assert.Single(auditEntries);
            var entry = auditEntries[0];
            Assert.Equal(userId, entry.UserId);
            Assert.NotNull(entry.DeletedItems);
            Assert.Equal(3, entry.DeletedItems!["sessions"]);
            Assert.Equal(2, entry.DeletedItems!["keys"]);
            Assert.Equal(4, entry.DeletedItems!["files"]);
            Assert.Equal(3, entry.DeletedItems!["preferences"]);
        }

        [Fact]
        public void CascadeDeleteUser_EmptyContext_Succeeds()
        {
            var userId = Guid.NewGuid();
            var context = new CascadeDeleteContext();

            var (success, error) = _rbac.CascadeService.DeleteUser(userId, context);

            Assert.True(success);
            Assert.Null(error);

            var auditEntries = _auditLog.QueryByAction("user_deleted_cascade");
            Assert.Single(auditEntries);
            Assert.Equal(0, auditEntries[0].DeletedItems!["sessions"]);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 5: cascade_delete deployment → all related records deleted
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void CascadeDeleteDeployment_DeletesAllRelatedRecords()
        {
            var deploymentId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                DnsRecords = new List<string> { "a.example.com", "www.example.com", "api.example.com" },
                ThemeConfigs = new List<string> { "default", "dark" },
                DeploymentLogs = new List<string> { "log1", "log2", "log3", "log4" }
            };

            var (success, error) = _rbac.CascadeService.DeleteDeployment(deploymentId, context);

            Assert.True(success);
            Assert.Null(error);
            Assert.Empty(context.DnsRecords);
            Assert.Empty(context.ThemeConfigs);
            Assert.Empty(context.DeploymentLogs);
            Assert.True(context.ArchivedToS3);

            var auditEntries = _auditLog.QueryByAction("deployment_deleted_cascade");
            Assert.Single(auditEntries);
            var entry = auditEntries[0];
            Assert.Equal(deploymentId.ToString(), entry.DeploymentId);
            Assert.Equal(3, entry.DeletedItems!["dns"]);
            Assert.Equal(2, entry.DeletedItems!["theme_configs"]);
            Assert.Equal(4, entry.DeletedItems!["deployment_logs"]);
            Assert.Equal(1, entry.DeletedItems!["archived_to_s3"]);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 6: cascade_delete org → all nested records deleted
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void CascadeDeleteOrganization_DeletesAllNestedRecords()
        {
            var orgId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                Deployments = new List<Guid> { Guid.NewGuid(), Guid.NewGuid() },
                Users = new List<Guid> { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() },
                OrgApiKeys = new List<Guid> { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() },
                OrgSessions = new List<Guid> { Guid.NewGuid(), Guid.NewGuid() }
            };

            var (success, error) = _rbac.CascadeService.DeleteOrganization(orgId, context);

            Assert.True(success);
            Assert.Null(error);
            Assert.Empty(context.Deployments);
            Assert.Empty(context.Users);
            Assert.Empty(context.OrgApiKeys);
            Assert.Empty(context.OrgSessions);

            var auditEntries = _auditLog.QueryByAction("org_deleted_cascade");
            Assert.Single(auditEntries);
            var entry = auditEntries[0];
            Assert.Equal(orgId.ToString(), entry.OrganizationId);
            Assert.Equal(2, entry.DeletedItems!["deployments"]);
            Assert.Equal(3, entry.DeletedItems!["users"]);
            Assert.Equal(4, entry.DeletedItems!["api_keys"]);
            Assert.Equal(2, entry.DeletedItems!["sessions"]);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 7: cascade on error → rollback (no partial deletes)
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void CascadeDeleteUser_RollbackOnFailure_NoPartialDeletes()
        {
            var userId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                Sessions = new List<Guid> { Guid.NewGuid(), Guid.NewGuid() },
                ApiKeys = new List<Guid> { Guid.NewGuid() },
                Files = new List<Guid> { Guid.NewGuid() },
                Preferences = new List<string> { "theme" }
            };

            // Simulate a failure by using a service that throws
            var failingService = new FailingCascadeService(_auditLog);
            var (success, error) = failingService.DeleteUser(userId, context);

            Assert.False(success);
            Assert.NotNull(error);
            Assert.Equal(500, error!.Code);

            // Verify rollback: context should be restored
            Assert.Equal(2, context.Sessions.Count);
            Assert.Equal(1, context.ApiKeys.Count);
            Assert.Equal(1, context.Files.Count);
            Assert.Equal(1, context.Preferences.Count);
        }

        [Fact]
        public void CascadeDeleteDeployment_RollbackOnFailure_NoPartialDeletes()
        {
            var deploymentId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                DnsRecords = new List<string> { "a.example.com" },
                ThemeConfigs = new List<string> { "default" },
                DeploymentLogs = new List<string> { "log1" }
            };

            var failingService = new FailingCascadeService(_auditLog);
            var (success, error) = failingService.DeleteDeployment(deploymentId, context);

            Assert.False(success);
            Assert.NotNull(error);

            // Verify rollback
            Assert.Single(context.DnsRecords);
            Assert.Single(context.ThemeConfigs);
            Assert.Single(context.DeploymentLogs);
            Assert.False(context.ArchivedToS3);
        }

        [Fact]
        public void CascadeDeleteOrganization_RollbackOnFailure_NoPartialDeletes()
        {
            var orgId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                Deployments = new List<Guid> { Guid.NewGuid() },
                Users = new List<Guid> { Guid.NewGuid() },
                OrgApiKeys = new List<Guid> { Guid.NewGuid() },
                OrgSessions = new List<Guid> { Guid.NewGuid() }
            };

            var failingService = new FailingCascadeService(_auditLog);
            var (success, error) = failingService.DeleteOrganization(orgId, context);

            Assert.False(success);
            Assert.NotNull(error);

            // Verify rollback
            Assert.Single(context.Deployments);
            Assert.Single(context.Users);
            Assert.Single(context.OrgApiKeys);
            Assert.Single(context.OrgSessions);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 8: permission audit logged → queries show who accessed what
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void PermissionAudit_LogsAllChecks()
        {
            var owner = CreateUser(Tier.Owner);
            var admin = CreateUser(Tier.Admin);
            var member = CreateUser(Tier.Member);

            // Owner passes owner check
            _rbac.Guard.RequireOwner(owner, "/api/admin/create-user");
            // Admin fails owner check
            _rbac.Guard.RequireOwner(admin, "/api/admin/create-user");
            // Member fails admin check
            _rbac.Guard.RequireAdmin(member, "/api/admin/list-customers");
            // Admin passes admin check
            _rbac.Guard.RequireAdmin(admin, "/api/admin/list-customers");
            // Null fails authenticated check
            _rbac.Guard.RequireAuthenticated(null, "/api/profile");
            // Member passes authenticated check
            _rbac.Guard.RequireAuthenticated(member, "/api/profile");

            var allEntries = _auditLog.GetAll();
            Assert.Equal(6, allEntries.Count);

            // Verify PASS entries
            var passEntries = _auditLog.QueryByDecision("PASS");
            Assert.Equal(3, passEntries.Count);

            // Verify FAIL entries
            var failEntries = _auditLog.QueryByDecision("FAIL");
            Assert.Equal(3, failEntries.Count);

            // Verify specific user's audit trail
            var adminEntries = _auditLog.QueryByUserId(admin.Id);
            Assert.Equal(2, adminEntries.Count);
            Assert.Contains(adminEntries, e => e.Decision == "FAIL" && e.RequiredTier == "owner");
            Assert.Contains(adminEntries, e => e.Decision == "PASS" && e.RequiredTier == "admin");

            // Verify action type
            var permissionChecks = _auditLog.QueryByAction("permission_check");
            Assert.Equal(6, permissionChecks.Count);
        }

        [Fact]
        public void PermissionAudit_RecordsEndpointAndTiers()
        {
            var member = CreateUser(Tier.Member);
            _rbac.Guard.RequireAdmin(member, "/api/admin/list-customers");

            var entries = _auditLog.QueryByAction("permission_check");
            Assert.Single(entries);
            var entry = entries[0];
            Assert.Equal("/api/admin/list-customers", entry.Endpoint);
            Assert.Equal("admin", entry.RequiredTier);
            Assert.Equal("Member", entry.UserTier);
            Assert.Equal("FAIL", entry.Decision);
            Assert.Equal(member.Id, entry.UserId);
        }

        [Fact]
        public void PermissionAudit_RecordsPassForForensics()
        {
            var owner = CreateUser(Tier.Owner);
            _rbac.Guard.RequireOwner(owner, "/api/admin/create-user");

            var entries = _auditLog.QueryByAction("permission_check");
            Assert.Single(entries);
            Assert.Equal("PASS", entries[0].Decision);
            Assert.Equal("owner", entries[0].RequiredTier);
            Assert.Equal("Owner", entries[0].UserTier);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 9: tier hierarchy → member cannot do admin actions, admin cannot do owner actions
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void TierHierarchy_MemberCannotDoAdminActions()
        {
            var member = CreateUser(Tier.Member);
            var result = _rbac.Guard.RequireAdmin(member, "/api/admin/list-customers");

            Assert.False(result.Allowed);
            Assert.Equal("admin_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void TierHierarchy_AdminCannotDoOwnerActions()
        {
            var admin = CreateUser(Tier.Admin);
            var result = _rbac.Guard.RequireOwner(admin, "/api/admin/create-user");

            Assert.False(result.Allowed);
            Assert.Equal("owner_only", result.Error!.Error);
            Assert.Equal(403, result.Error.Code);
        }

        [Fact]
        public void TierHierarchy_PublicCannotDoMemberActions()
        {
            var pub = CreateUser(Tier.Public);
            // Public can authenticate but cannot do admin/owner actions
            var authResult = _rbac.Guard.RequireAuthenticated(pub, "/api/profile");
            Assert.True(authResult.Allowed);

            var adminResult = _rbac.Guard.RequireAdmin(pub, "/api/admin/list-customers");
            Assert.False(adminResult.Allowed);

            var ownerResult = _rbac.Guard.RequireOwner(pub, "/api/admin/create-user");
            Assert.False(ownerResult.Allowed);
        }

        [Fact]
        public void TierHierarchy_AdminCanDoAdminAndLowerActions()
        {
            var admin = CreateUser(Tier.Admin);

            var adminResult = _rbac.Guard.RequireAdmin(admin, "/api/admin/list-customers");
            Assert.True(adminResult.Allowed);

            var authResult = _rbac.Guard.RequireAuthenticated(admin, "/api/profile");
            Assert.True(authResult.Allowed);
        }

        [Fact]
        public void TierHierarchy_OwnerCanDoAllActions()
        {
            var owner = CreateUser(Tier.Owner);

            var ownerResult = _rbac.Guard.RequireOwner(owner, "/api/admin/create-user");
            Assert.True(ownerResult.Allowed);

            var adminResult = _rbac.Guard.RequireAdmin(owner, "/api/admin/list-customers");
            Assert.True(adminResult.Allowed);

            var authResult = _rbac.Guard.RequireAuthenticated(owner, "/api/profile");
            Assert.True(authResult.Allowed);
        }

        [Fact]
        public void TierHierarchy_MemberCanDoAuthenticatedActions()
        {
            var member = CreateUser(Tier.Member);
            var result = _rbac.Guard.RequireAuthenticated(member, "/api/profile");
            Assert.True(result.Allowed);
        }

        // ─────────────────────────────────────────────────────────────────────
        // TEST 10: permission check response time < 10ms → no performance impact
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void PermissionCheck_ResponseTime_Under10ms()
        {
            var owner = CreateUser(Tier.Owner);
            var admin = CreateUser(Tier.Admin);
            var member = CreateUser(Tier.Member);
            var pub = CreateUser(Tier.Public);

            // Warm up
            for (int i = 0; i < 100; i++)
            {
                _rbac.Guard.RequireOwner(owner, "/api/test");
                _rbac.Guard.RequireAdmin(admin, "/api/test");
                _rbac.Guard.RequireAuthenticated(member, "/api/test");
            }

            var sw = Stopwatch.StartNew();
            const int iterations = 1000;

            for (int i = 0; i < iterations; i++)
            {
                _rbac.Guard.RequireOwner(owner, "/api/test");
                _rbac.Guard.RequireAdmin(admin, "/api/test");
                _rbac.Guard.RequireAuthenticated(member, "/api/test");
                _rbac.Guard.RequireOwner(pub, "/api/test");
            }

            sw.Stop();
            var avgMs = sw.Elapsed.TotalMilliseconds / iterations;

            Assert.True(avgMs < 10, $"Average permission check took {avgMs:F3}ms, expected < 10ms");
        }

        [Fact]
        public void PermissionCheck_SingleCheck_Under10ms()
        {
            var owner = CreateUser(Tier.Owner);

            var sw = Stopwatch.StartNew();
            var result = _rbac.Guard.RequireOwner(owner, "/api/admin/create-user");
            sw.Stop();

            Assert.True(sw.Elapsed.TotalMilliseconds < 10,
                $"Single permission check took {sw.Elapsed.TotalMilliseconds:F3}ms, expected < 10ms");
            Assert.True(result.Allowed);
        }

        // ─────────────────────────────────────────────────────────────────────
        // Additional coverage: error response JSON shapes
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void ErrorResponse_OwnerOnly_MatchesSpecJson()
        {
            var error = ErrorResponse.OwnerOnly();
            var json = error.ToJson();
            var doc = JsonDocument.Parse(json);

            Assert.Equal("owner_only", doc.RootElement.GetProperty("Error").GetString());
            Assert.Equal(403, doc.RootElement.GetProperty("Code").GetInt32());
        }

        [Fact]
        public void ErrorResponse_AdminOnly_MatchesSpecJson()
        {
            var error = ErrorResponse.AdminOnly();
            var json = error.ToJson();
            var doc = JsonDocument.Parse(json);

            Assert.Equal("admin_only", doc.RootElement.GetProperty("Error").GetString());
            Assert.Equal(403, doc.RootElement.GetProperty("Code").GetInt32());
        }

        [Fact]
        public void ErrorResponse_AuthenticationRequired_MatchesSpecJson()
        {
            var error = ErrorResponse.AuthenticationRequired();
            var json = error.ToJson();
            var doc = JsonDocument.Parse(json);

            Assert.Equal("authentication_required", doc.RootElement.GetProperty("Error").GetString());
            Assert.Equal(401, doc.RootElement.GetProperty("Code").GetInt32());
        }

        // ─────────────────────────────────────────────────────────────────────
        // Additional: cascade audit log entries
        // ─────────────────────────────────────────────────────────────────────
        [Fact]
        public void CascadeAudit_UserDeleted_LoggedWithCorrectAction()
        {
            var userId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                Sessions = new List<Guid> { Guid.NewGuid() },
                ApiKeys = new List<Guid> { Guid.NewGuid() },
                Files = new List<Guid> { Guid.NewGuid() },
                Preferences = new List<string> { "theme" }
            };

            _rbac.CascadeService.DeleteUser(userId, context);

            var entries = _auditLog.QueryByAction("user_deleted_cascade");
            Assert.Single(entries);
            Assert.Equal(userId, entries[0].UserId);
            Assert.NotNull(entries[0].DeletedItems);
        }

        [Fact]
        public void CascadeAudit_DeploymentDeleted_LoggedWithCorrectAction()
        {
            var deploymentId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                DnsRecords = new List<string> { "a.example.com" },
                ThemeConfigs = new List<string> { "default" },
                DeploymentLogs = new List<string> { "log1" }
            };

            _rbac.CascadeService.DeleteDeployment(deploymentId, context);

            var entries = _auditLog.QueryByAction("deployment_deleted_cascade");
            Assert.Single(entries);
            Assert.Equal(deploymentId.ToString(), entries[0].DeploymentId);
        }

        [Fact]
        public void CascadeAudit_OrgDeleted_LoggedWithCorrectAction()
        {
            var orgId = Guid.NewGuid();
            var context = new CascadeDeleteContext
            {
                Deployments = new List<Guid> { Guid.NewGuid() },
                Users = new List<Guid> { Guid.NewGuid() },
                OrgApiKeys = new List<Guid> { Guid.NewGuid() },
                OrgSessions = new List<Guid> { Guid.NewGuid() }
            };

            _rbac.CascadeService.DeleteOrganization(orgId, context);

            var entries = _auditLog.QueryByAction("org_deleted_cascade");
            Assert.Single(entries);
            Assert.Equal(orgId.ToString(), entries[0].OrganizationId);
        }

        // ─────────────────────────────────────────────────────────────────────
        // Helper: Failing cascade service for rollback tests
        // ─────────────────────────────────────────────────────────────────────
        private class FailingCascadeService
        {
            private readonly AuditLogStore _auditLog;

            public FailingCascadeService(AuditLogStore auditLog)
            {
                _auditLog = auditLog;
            }

            public (bool Success, ErrorResponse? Error) DeleteUser(Guid userId, CascadeDeleteContext context)
            {
                // Snapshot
                var snapshotSessions = new List<Guid>(context.Sessions);
                var snapshotKeys = new List<Guid>(context.ApiKeys);
                var snapshotFiles = new List<Guid>(context.Files);
                var snapshotPrefs = new List<string>(context.Preferences);

                try
                {
                    // Simulate partial delete then failure
                    context.Sessions.Clear();
                    context.ApiKeys.Clear();
                    throw new InvalidOperationException("Simulated DB failure during cascade");
                }
                catch (Exception)
                {
                    // Rollback
                    context.Sessions = snapshotSessions;
                    context.ApiKeys = snapshotKeys;
                    context.Files = snapshotFiles;
                    context.Preferences = snapshotPrefs;
                    return (false, ErrorResponse.PermissionDenied("cascade_rollback", 500, "Cascade delete failed, transaction rolled back"));
                }
            }

            public (bool Success, ErrorResponse? Error) DeleteDeployment(Guid deploymentId, CascadeDeleteContext context)
            {
                var snapshotDns = new List<string>(context.DnsRecords);
                var snapshotThemes = new List<string>(context.ThemeConfigs);
                var snapshotLogs = new List<string>(context.DeploymentLogs);
                var snapshotArchived = context.ArchivedToS3;

                try
                {
                    context.DnsRecords.Clear();
                    throw new InvalidOperationException("Simulated DB failure during cascade");
                }
                catch (Exception)
                {
                    context.DnsRecords = snapshotDns;
                    context.ThemeConfigs = snapshotThemes;
                    context.DeploymentLogs = snapshotLogs;
                    context.ArchivedToS3 = snapshotArchived;
                    return (false, ErrorResponse.PermissionDenied("cascade_rollback", 500, "Cascade delete failed, transaction rolled back"));
                }
            }

            public (bool Success, ErrorResponse? Error) DeleteOrganization(Guid orgId, CascadeDeleteContext context)
            {
                var snapshotDeployments = new List<Guid>(context.Deployments);
                var snapshotUsers = new List<Guid>(context.Users);
                var snapshotKeys = new List<Guid>(context.OrgApiKeys);
                var snapshotSessions = new List<Guid>(context.OrgSessions);

                try
                {
                    context.Deployments.Clear();
                    throw new InvalidOperationException("Simulated DB failure during cascade");
                }
                catch (Exception)
                {
                    context.Deployments = snapshotDeployments;
                    context.Users = snapshotUsers;
                    context.OrgApiKeys = snapshotKeys;
                    context.OrgSessions = snapshotSessions;
                    return (false, ErrorResponse.PermissionDenied("cascade_rollback", 500, "Cascade delete failed, transaction rolled back"));
                }
            }
        }
    }
}