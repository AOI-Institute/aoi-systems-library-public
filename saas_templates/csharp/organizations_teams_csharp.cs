using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace AOI.OrganizationsTeams
{
    public enum Role { Owner, Admin, Member }

    public record Organization(string Id, string Name, string Slug, DateTime CreatedAt);
    public record Membership(string OrgId, string UserId, Role Role, DateTime CreatedAt);
    public record Invitation(string Id, string OrgId, string Email, Role Role, string TokenHash, DateTime ExpiresAt, DateTime? AcceptedAt, string InvitedBy, DateTime CreatedAt);

    public record OrgResult(int Status, string ContentType, string Body);
    public record MembershipResult(int Status, string ContentType, string Body);
    public record InviteResult(int Status, string ContentType, string Body, string? RawToken = null);
    public record ListResult(int Status, string ContentType, string Body);

    public interface IStore
    {
        Organization? GetOrg(string orgId);
        Organization? GetOrgBySlug(string slug);
        void CreateOrg(Organization org);
        Membership? GetMembership(string orgId, string userId);
        IEnumerable<Membership> ListMemberships(string orgId);
        void AddMembership(Membership membership);
        void UpdateMembershipRole(string orgId, string userId, Role role);
        void RemoveMembership(string orgId, string userId);
        int CountOwners(string orgId);
        Invitation? GetInvitationByTokenHash(string tokenHash);
        void CreateInvitation(Invitation invitation);
        void MarkInvitationAccepted(string invitationId, DateTime acceptedAt);
    }

    public sealed class InMemoryStore : IStore
    {
        private readonly Dictionary<string, Organization> _orgs = new();
        private readonly Dictionary<string, Organization> _orgsBySlug = new();
        private readonly Dictionary<string, Membership> _memberships = new(); // key: orgId|userId
        private readonly Dictionary<string, Invitation> _invitations = new(); // key: invitationId
        private readonly Dictionary<string, Invitation> _invitationsByTokenHash = new(); // key: tokenHash
        private readonly ReaderWriterLockSlim _lock = new();

        private string MembershipKey(string orgId, string userId) => $"{orgId}|{userId}";

        public Organization? GetOrg(string orgId)
        {
            _lock.EnterReadLock();
            try { return _orgs.TryGetValue(orgId, out var org) ? org : null; }
            finally { _lock.ExitReadLock(); }
        }

        public Organization? GetOrgBySlug(string slug)
        {
            _lock.EnterReadLock();
            try { return _orgsBySlug.TryGetValue(slug, out var org) ? org : null; }
            finally { _lock.ExitReadLock(); }
        }

        public void CreateOrg(Organization org)
        {
            _lock.EnterWriteLock();
            try
            {
                _orgs[org.Id] = org;
                _orgsBySlug[org.Slug] = org;
            }
            finally { _lock.ExitWriteLock(); }
        }

        public Membership? GetMembership(string orgId, string userId)
        {
            _lock.EnterReadLock();
            try { return _memberships.TryGetValue(MembershipKey(orgId, userId), out var m) ? m : null; }
            finally { _lock.ExitReadLock(); }
        }

        public IEnumerable<Membership> ListMemberships(string orgId)
        {
            _lock.EnterReadLock();
            try { return _memberships.Values.Where(m => m.OrgId == orgId).ToList(); }
            finally { _lock.ExitReadLock(); }
        }

        public void AddMembership(Membership membership)
        {
            _lock.EnterWriteLock();
            try { _memberships[MembershipKey(membership.OrgId, membership.UserId)] = membership; }
            finally { _lock.ExitWriteLock(); }
        }

        public void UpdateMembershipRole(string orgId, string userId, Role role)
        {
            _lock.EnterWriteLock();
            try
            {
                var key = MembershipKey(orgId, userId);
                if (_memberships.TryGetValue(key, out var m))
                    _memberships[key] = m with { Role = role };
            }
            finally { _lock.ExitWriteLock(); }
        }

        public void RemoveMembership(string orgId, string userId)
        {
            _lock.EnterWriteLock();
            try { _memberships.Remove(MembershipKey(orgId, userId)); }
            finally { _lock.ExitWriteLock(); }
        }

        public int CountOwners(string orgId)
        {
            _lock.EnterReadLock();
            try { return _memberships.Values.Count(m => m.OrgId == orgId && m.Role == Role.Owner); }
            finally { _lock.ExitReadLock(); }
        }

        public Invitation? GetInvitationByTokenHash(string tokenHash)
        {
            _lock.EnterReadLock();
            try { return _invitationsByTokenHash.TryGetValue(tokenHash, out var inv) ? inv : null; }
            finally { _lock.ExitReadLock(); }
        }

        public void CreateInvitation(Invitation invitation)
        {
            _lock.EnterWriteLock();
            try
            {
                _invitations[invitation.Id] = invitation;
                _invitationsByTokenHash[invitation.TokenHash] = invitation;
            }
            finally { _lock.ExitWriteLock(); }
        }

        public void MarkInvitationAccepted(string invitationId, DateTime acceptedAt)
        {
            _lock.EnterWriteLock();
            try
            {
                if (_invitations.TryGetValue(invitationId, out var inv))
                {
                    var updated = inv with { AcceptedAt = acceptedAt };
                    _invitations[invitationId] = updated;
                    _invitationsByTokenHash[inv.TokenHash] = updated;
                }
            }
            finally { _lock.ExitWriteLock(); }
        }
    }

    public sealed class SqlStore : IStore, IDisposable
    {
        private readonly DbConnection _conn;
        private bool _disposed;

        public SqlStore(DbConnection connection)
        {
            _conn = connection ?? throw new ArgumentNullException(nameof(connection));
            if (_conn.State != System.Data.ConnectionState.Open)
                _conn.Open();
            EnsureSchema();
        }

        private void EnsureSchema()
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"
                CREATE TABLE IF NOT EXISTS organizations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    slug TEXT UNIQUE NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memberships (
                    org_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (org_id, user_id)
                );
                CREATE TABLE IF NOT EXISTS invitations (
                    id TEXT PRIMARY KEY,
                    org_id TEXT NOT NULL,
                    email TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
                    token_hash TEXT NOT NULL UNIQUE,
                    expires_at TEXT NOT NULL,
                    accepted_at TEXT,
                    invited_by TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_invitations_token_hash ON invitations(token_hash);
                CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);
            ";
            cmd.ExecuteNonQuery();
        }

        private static string ToIso(DateTime dt) => dt.ToString("o");
        private static DateTime FromIso(string s) => DateTime.Parse(s, null, System.Globalization.DateTimeStyles.RoundtripKind);
        private static Role ParseRole(string s) => s switch { "owner" => Role.Owner, "admin" => Role.Admin, _ => Role.Member };
        private static string RoleToString(Role r) => r switch { Role.Owner => "owner", Role.Admin => "admin", _ => "member" };

        public Organization? GetOrg(string orgId)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT id, name, slug, created_at FROM organizations WHERE id = @id";
            var p = cmd.CreateParameter(); p.ParameterName = "@id"; p.Value = orgId; cmd.Parameters.Add(p);
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return null;
            return new Organization(r.GetString(0), r.GetString(1), r.GetString(2), FromIso(r.GetString(3)));
        }

        public Organization? GetOrgBySlug(string slug)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT id, name, slug, created_at FROM organizations WHERE slug = @slug";
            var p = cmd.CreateParameter(); p.ParameterName = "@slug"; p.Value = slug; cmd.Parameters.Add(p);
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return null;
            return new Organization(r.GetString(0), r.GetString(1), r.GetString(2), FromIso(r.GetString(3)));
        }

        public void CreateOrg(Organization org)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "INSERT INTO organizations (id, name, slug, created_at) VALUES (@id, @name, @slug, @created_at)";
            AddParam(cmd, "@id", org.Id);
            AddParam(cmd, "@name", org.Name);
            AddParam(cmd, "@slug", org.Slug);
            AddParam(cmd, "@created_at", ToIso(org.CreatedAt));
            cmd.ExecuteNonQuery();
        }

        public Membership? GetMembership(string orgId, string userId)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT org_id, user_id, role, created_at FROM memberships WHERE org_id = @org_id AND user_id = @user_id";
            AddParam(cmd, "@org_id", orgId);
            AddParam(cmd, "@user_id", userId);
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return null;
            return new Membership(r.GetString(0), r.GetString(1), ParseRole(r.GetString(2)), FromIso(r.GetString(3)));
        }

        public IEnumerable<Membership> ListMemberships(string orgId)
        {
            var list = new List<Membership>();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT org_id, user_id, role, created_at FROM memberships WHERE org_id = @org_id";
            AddParam(cmd, "@org_id", orgId);
            using var r = cmd.ExecuteReader();
            while (r.Read())
                list.Add(new Membership(r.GetString(0), r.GetString(1), ParseRole(r.GetString(2)), FromIso(r.GetString(3))));
            return list;
        }

        public void AddMembership(Membership membership)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (@org_id, @user_id, @role, @created_at)";
            AddParam(cmd, "@org_id", membership.OrgId);
            AddParam(cmd, "@user_id", membership.UserId);
            AddParam(cmd, "@role", RoleToString(membership.Role));
            AddParam(cmd, "@created_at", ToIso(membership.CreatedAt));
            cmd.ExecuteNonQuery();
        }

        public void UpdateMembershipRole(string orgId, string userId, Role role)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "UPDATE memberships SET role = @role WHERE org_id = @org_id AND user_id = @user_id";
            AddParam(cmd, "@role", RoleToString(role));
            AddParam(cmd, "@org_id", orgId);
            AddParam(cmd, "@user_id", userId);
            cmd.ExecuteNonQuery();
        }

        public void RemoveMembership(string orgId, string userId)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "DELETE FROM memberships WHERE org_id = @org_id AND user_id = @user_id";
            AddParam(cmd, "@org_id", orgId);
            AddParam(cmd, "@user_id", userId);
            cmd.ExecuteNonQuery();
        }

        public int CountOwners(string orgId)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM memberships WHERE org_id = @org_id AND role = 'owner'";
            AddParam(cmd, "@org_id", orgId);
            return Convert.ToInt32(cmd.ExecuteScalar());
        }

        public Invitation? GetInvitationByTokenHash(string tokenHash)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at FROM invitations WHERE token_hash = @token_hash";
            AddParam(cmd, "@token_hash", tokenHash);
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return null;
            return new Invitation(
                r.GetString(0), r.GetString(1), r.GetString(2), ParseRole(r.GetString(3)),
                r.GetString(4), FromIso(r.GetString(5)),
                r.IsDBNull(6) ? null : FromIso(r.GetString(6)),
                r.GetString(7), FromIso(r.GetString(8)));
        }

        public void CreateInvitation(Invitation invitation)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"INSERT INTO invitations (id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at)
                                VALUES (@id, @org_id, @email, @role, @token_hash, @expires_at, @accepted_at, @invited_by, @created_at)";
            AddParam(cmd, "@id", invitation.Id);
            AddParam(cmd, "@org_id", invitation.OrgId);
            AddParam(cmd, "@email", invitation.Email);
            AddParam(cmd, "@role", RoleToString(invitation.Role));
            AddParam(cmd, "@token_hash", invitation.TokenHash);
            AddParam(cmd, "@expires_at", ToIso(invitation.ExpiresAt));
            AddParam(cmd, "@accepted_at", invitation.AcceptedAt.HasValue ? ToIso(invitation.AcceptedAt.Value) : DBNull.Value);
            AddParam(cmd, "@invited_by", invitation.InvitedBy);
            AddParam(cmd, "@created_at", ToIso(invitation.CreatedAt));
            cmd.ExecuteNonQuery();
        }

        public void MarkInvitationAccepted(string invitationId, DateTime acceptedAt)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "UPDATE invitations SET accepted_at = @accepted_at WHERE id = @id";
            AddParam(cmd, "@accepted_at", ToIso(acceptedAt));
            AddParam(cmd, "@id", invitationId);
            cmd.ExecuteNonQuery();
        }

        private static void AddParam(DbCommand cmd, string name, object value)
        {
            var p = cmd.CreateParameter();
            p.ParameterName = name;
            p.Value = value;
            cmd.Parameters.Add(p);
        }

        public void Dispose()
        {
            if (!_disposed)
            {
                _conn?.Dispose();
                _disposed = true;
            }
        }
    }

    public sealed class OrganizationsService
    {
        private readonly IStore _store;
        private readonly Func<string> _generateId;
        private readonly Func<byte[]> _generateToken;

        public OrganizationsService(IStore store, Func<string>? generateId = null, Func<byte[]>? generateToken = null)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _generateId = generateId ?? (() => Guid.NewGuid().ToString("N"));
            _generateToken = generateToken ?? (() => { var b = new byte[32]; RandomNumberGenerator.Fill(b); return b; });
        }

        private static string HashToken(byte[] token) => Convert.ToHexString(SHA256.HashData(token)).ToLowerInvariant();
        private static string Slugify(string name) => name.ToLowerInvariant().Replace(" ", "-").Replace("_", "-");

        private Membership? RequireMembership(string actorId, string orgId, out Organization? org)
        {
            org = _store.GetOrg(orgId);
            if (org == null) return null;
            return _store.GetMembership(orgId, actorId);
        }

        private bool IsOwner(Membership? m) => m?.Role == Role.Owner;
        private bool IsAdmin(Membership? m) => m?.Role == Role.Admin || m?.Role == Role.Owner;
        private bool IsMember(Membership? m) => m != null;

        public OrgResult CreateOrg(string userId, string name)
        {
            if (string.IsNullOrWhiteSpace(userId)) return new OrgResult(400, "application/json", """{"error":"user_id required"}""");
            if (string.IsNullOrWhiteSpace(name)) return new OrgResult(400, "application/json", """{"error":"name required"}""");

            var slug = Slugify(name);
            var existing = _store.GetOrgBySlug(slug);
            if (existing != null) return new OrgResult(409, "application/json", """{"error":"slug already exists"}""");

            var now = DateTime.UtcNow;
            var org = new Organization(_generateId(), name, slug, now);
            var membership = new Membership(org.Id, userId, Role.Owner, now);

            _store.CreateOrg(org);
            _store.AddMembership(membership);

            var json = $"{{\"id\":\"{org.Id}\",\"name\":\"{org.Name}\",\"slug\":\"{org.Slug}\",\"created_at\":\"{org.CreatedAt:o}\"}}";
            return new OrgResult(201, "application/json", json);
        }

        public OrgResult GetOrg(string actorId, string orgId)
        {
            var membership = RequireMembership(actorId, orgId, out var org);
            if (membership == null || org == null)
                return new OrgResult(404, "application/json", """{"error":"not found"}""");

            var json = $"{{\"id\":\"{org.Id}\",\"name\":\"{org.Name}\",\"slug\":\"{org.Slug}\",\"created_at\":\"{org.CreatedAt:o}\"}}";
            return new OrgResult(200, "application/json", json);
        }

        public ListResult ListMembers(string actorId, string orgId)
        {
            var membership = RequireMembership(actorId, orgId, out var org);
            if (membership == null || org == null)
                return new ListResult(404, "application/json", """{"error":"not found"}""");

            var members = _store.ListMemberships(orgId).Select(m =>
                $"{{\"user_id\":\"{m.UserId}\",\"role\":\"{m.Role.ToString().ToLower()}\",\"created_at\":\"{m.CreatedAt:o}\"}}");
            var json = "[" + string.Join(",", members) + "]";
            return new ListResult(200, "application/json", json);
        }

        public InviteResult Invite(string actorId, string orgId, string email, Role role)
        {
            if (string.IsNullOrWhiteSpace(email)) return new InviteResult(400, "application/json", """{"error":"email required"}""", null);
            if (role == Role.Owner) return new InviteResult(400, "application/json", """{"error":"cannot invite as owner"}""", null);

            var actorMembership = RequireMembership(actorId, orgId, out var org);
            if (actorMembership == null || org == null)
                return new InviteResult(404, "application/json", """{"error":"not found"}""", null);

            if (!IsAdmin(actorMembership))
                return new InviteResult(403, "application/json", """{"error":"forbidden: admin or owner required"}""", null);

            var rawToken = _generateToken();
            var tokenHash = HashToken(rawToken);
            var now = DateTime.UtcNow;
            var invitation = new Invitation(
                _generateId(), orgId, email.ToLowerInvariant(), role, tokenHash,
                now.AddDays(7), null, actorId, now);

            _store.CreateInvitation(invitation);

            var rawTokenStr = Convert.ToBase64String(rawToken);
            var json = $"{{\"invitation_id\":\"{invitation.Id}\",\"email\":\"{invitation.Email}\",\"role\":\"{invitation.Role.ToString().ToLower()}\",\"expires_at\":\"{invitation.ExpiresAt:o}\"}}";
            return new InviteResult(201, "application/json", json, rawTokenStr);
        }

        public MembershipResult AcceptInvitation(string userId, string email, string rawToken)
        {
            if (string.IsNullOrWhiteSpace(rawToken)) return new MembershipResult(400, "application/json", """{"error":"token required"}""");
            if (string.IsNullOrWhiteSpace(email)) return new MembershipResult(400, "application/json", """{"error":"email required"}""");

            byte[] tokenBytes;
            try { tokenBytes = Convert.FromBase64String(rawToken); }
            catch { return new MembershipResult(400, "application/json", """{"error":"invalid token format"}"""); }

            var tokenHash = HashToken(tokenBytes);
            var invitation = _store.GetInvitationByTokenHash(tokenHash);

            if (invitation == null)
                return new MembershipResult(404, "application/json", """{"error":"invalid or expired invitation"}""");

            if (invitation.AcceptedAt.HasValue)
                return new MembershipResult(409, "application/json", """{"error":"invitation already used"}""");

            if (invitation.ExpiresAt < DateTime.UtcNow)
                return new MembershipResult(410, "application/json", """{"error":"invitation expired"}""");

            if (!invitation.Email.Equals(email, StringComparison.OrdinalIgnoreCase))
                return new MembershipResult(403, "application/json", """{"error":"email mismatch"}""");

            var org = _store.GetOrg(invitation.OrgId);
            if (org == null)
                return new MembershipResult(404, "application/json", """{"error":"organization not found"}""");

            var existing = _store.GetMembership(org.Id, userId);
            if (existing != null)
                return new MembershipResult(409, "application/json", """{"error":"already a member"}""");

            var now = DateTime.UtcNow;
            var membership = new Membership(org.Id, userId, invitation.Role, now);
            _store.AddMembership(membership);
            _store.MarkInvitationAccepted(invitation.Id, now);

            var json = $"{{\"org_id\":\"{membership.OrgId}\",\"user_id\":\"{membership.UserId}\",\"role\":\"{membership.Role.ToString().ToLower()}\",\"created_at\":\"{membership.CreatedAt:o}\"}}";
            return new MembershipResult(200, "application/json", json);
        }

        public MembershipResult ChangeRole(string actorId, string orgId, string targetUserId, Role newRole)
        {
            if (newRole == Role.Owner) return new MembershipResult(400, "application/json", """{"error":"cannot change role to owner"}""");

            var actorMembership = RequireMembership(actorId, orgId, out var org);
            if (actorMembership == null || org == null)
                return new MembershipResult(404, "application/json", """{"error":"not found"}""");

            if (!IsAdmin(actorMembership))
                return new MembershipResult(403, "application/json", """{"error":"forbidden: admin or owner required"}""");

            var targetMembership = _store.GetMembership(orgId, targetUserId);
            if (targetMembership == null)
                return new MembershipResult(404, "application/json", """{"error":"member not found"}""");

            if (targetMembership.Role == Role.Owner)
                return new MembershipResult(403, "application/json", """{"error":"cannot change owner role"}""");

            if (actorMembership.Role == Role.Admin && targetMembership.Role == Role.Admin)
                return new MembershipResult(403, "application/json", """{"error":"admin cannot change admin role"}""");

            _store.UpdateMembershipRole(orgId, targetUserId, newRole);
            var updated = _store.GetMembership(orgId, targetUserId)!;
            var json = $"{{\"org_id\":\"{updated.OrgId}\",\"user_id\":\"{updated.UserId}\",\"role\":\"{updated.Role.ToString().ToLower()}\",\"created_at\":\"{updated.CreatedAt:o}\"}}";
            return new MembershipResult(200, "application/json", json);
        }

        public MembershipResult RemoveMember(string actorId, string orgId, string targetUserId)
        {
            var actorMembership = RequireMembership(actorId, orgId, out var org);
            if (actorMembership == null || org == null)
                return new MembershipResult(404, "application/json", """{"error":"not found"}""");

            if (!IsOwner(actorMembership))
                return new MembershipResult(403, "application/json", """{"error":"forbidden: owner required"}""");

            var targetMembership = _store.GetMembership(orgId, targetUserId);
            if (targetMembership == null)
                return new MembershipResult(404, "application/json", """{"error":"member not found"}""");

            if (targetMembership.Role == Role.Owner)
                return new MembershipResult(403, "application/json", """{"error":"cannot remove owner"}""");

            _store.RemoveMembership(orgId, targetUserId);
            return new MembershipResult(200, "application/json", """{"status":"removed"}""");
        }

        public MembershipResult LeaveOrg(string userId, string orgId)
        {
            var membership = RequireMembership(userId, orgId, out var org);
            if (membership == null || org == null)
                return new MembershipResult(404, "application/json", """{"error":"not found"}""");

            if (membership.Role == Role.Owner)
            {
                var ownerCount = _store.CountOwners(orgId);
                if (ownerCount <= 1)
                    return new MembershipResult(403, "application/json", """{"error":"last owner cannot leave"}""");
            }

            _store.RemoveMembership(orgId, userId);
            return new MembershipResult(200, "application/json", """{"status":"left"}""");
        }
    }
}