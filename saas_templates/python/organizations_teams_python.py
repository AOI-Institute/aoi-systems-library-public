from __future__ import annotations

import hashlib
import secrets
import time
import threading
import sqlite3
import re
from typing import Protocol, runtime_checkable, Optional, List, Callable
from dataclasses import dataclass, field

def trim_ws(s: str) -> str:
    return s.strip(" \t\r\n")

def ascii_lower(s: str) -> str:
    return ''.join(chr(ord(c) + 32) if 'A' <= c <= 'Z' else c for c in s)

def normalize_email(s: str) -> str:
    s = trim_ws(s)
    s = ascii_lower(s)
    if s.count('@') != 1:
        raise ValueError("invalid email")
    local, domain = s.split('@', 1)
    if not local or not domain:
        raise ValueError("invalid email")
    if len(s.encode('utf-8')) > 254:
        raise ValueError("invalid email")
    for ch in s:
        if ord(ch) <= 0x20 or ord(ch) == 0x7F:
            raise ValueError("invalid email")
    return s

def hex_bytes(b: bytes) -> str:
    return b.hex()

def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode('ascii')).hexdigest()

def is_token_shape(s: str) -> bool:
    if len(s) != 64:
        return False
    for ch in s:
        if not ('0' <= ch <= '9' or 'a' <= ch <= 'f'):
            return False
    return True

def slugify(name: str) -> str:
    s = ascii_lower(name)
    s = re.sub(r'[^a-z0-9]+', '-', s)
    s = s.strip('-')
    if len(s) > 48:
        s = s[:48]
    s = s.rstrip('-')
    if not s:
        s = 'org'
    return s

@dataclass(frozen=True)
class User:
    id: str
    email: str

@dataclass(frozen=True)
class Org:
    id: str
    name: str
    slug: str
    created_at: int

@dataclass(frozen=True)
class Membership:
    org_id: str
    user_id: str
    role: str
    created_at: int

@dataclass(frozen=True)
class Invitation:
    id: str
    org_id: str
    email: str
    role: str
    token_hash: str
    expires_at: int
    accepted_at: Optional[int]
    invited_by: str
    created_at: int

@dataclass(frozen=True)
class OrgError(Exception):
    code: str
    status: int
    message: str
    def __str__(self) -> str:
        return self.message

@runtime_checkable
class Store(Protocol):
    def insert_org_with_owner(self, org: Org, owner: Membership) -> bool: ...
    def find_org(self, org_id: str) -> Optional[Org]: ...
    def find_membership(self, org_id: str, user_id: str) -> Optional[Membership]: ...
    def list_memberships(self, org_id: str) -> List[Membership]: ...
    def insert_invitation(self, inv: Invitation) -> None: ...
    def find_invitation_by_hash(self, token_hash: str) -> Optional[Invitation]: ...
    def consume_invitation(self, invitation_id: str, m: Membership, now: int) -> str: ...
    def set_role(self, org_id: str, user_id: str, role: str) -> str: ...
    def delete_membership(self, org_id: str, user_id: str) -> str: ...

@dataclass
class Options:
    clock: Callable[[], int] = field(default_factory=lambda: lambda: int(time.time()))
    random_bytes: Callable[[int], bytes] = field(default_factory=lambda: lambda n: secrets.token_bytes(n))

class InMemoryStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._orgs: dict[str, Org] = {}
        self._slugs: set[str] = set()
        self._memberships: dict[str, dict[str, Membership]] = {}
        self._invitations: dict[str, Invitation] = {}
        self._inv_hash_to_id: dict[str, str] = {}

    def insert_org_with_owner(self, org: Org, owner: Membership) -> bool:
        with self._lock:
            if org.slug in self._slugs:
                return False
            self._orgs[org.id] = org
            self._slugs.add(org.slug)
            if org.id not in self._memberships:
                self._memberships[org.id] = {}
            self._memberships[org.id][owner.user_id] = owner
            return True

    def find_org(self, org_id: str) -> Optional[Org]:
        with self._lock:
            return self._orgs.get(org_id)

    def find_membership(self, org_id: str, user_id: str) -> Optional[Membership]:
        with self._lock:
            org_members = self._memberships.get(org_id)
            if org_members is None:
                return None
            return org_members.get(user_id)

    def list_memberships(self, org_id: str) -> List[Membership]:
        with self._lock:
            org_members = self._memberships.get(org_id)
            if org_members is None:
                return []
            result = list(org_members.values())
            result.sort(key=lambda m: (m.created_at, m.user_id))
            return result

    def insert_invitation(self, inv: Invitation) -> None:
        with self._lock:
            self._invitations[inv.id] = inv
            self._inv_hash_to_id[inv.token_hash] = inv.id

    def find_invitation_by_hash(self, token_hash: str) -> Optional[Invitation]:
        with self._lock:
            inv_id = self._inv_hash_to_id.get(token_hash)
            if inv_id is None:
                return None
            return self._invitations.get(inv_id)

    def consume_invitation(self, invitation_id: str, m: Membership, now: int) -> str:
        with self._lock:
            inv = self._invitations.get(invitation_id)
            if inv is None:
                return "not_found"
            if inv.accepted_at is not None:
                return "used"
            if now >= inv.expires_at:
                return "expired"
            org_members = self._memberships.get(m.org_id)
            if org_members is not None and m.user_id in org_members:
                return "already_member"
            new_inv = Invitation(
                id=inv.id, org_id=inv.org_id, email=inv.email, role=inv.role,
                token_hash=inv.token_hash, expires_at=inv.expires_at,
                accepted_at=now, invited_by=inv.invited_by, created_at=inv.created_at
            )
            self._invitations[invitation_id] = new_inv
            if m.org_id not in self._memberships:
                self._memberships[m.org_id] = {}
            self._memberships[m.org_id][m.user_id] = m
            return "ok"

    def set_role(self, org_id: str, user_id: str, role: str) -> str:
        with self._lock:
            org_members = self._memberships.get(org_id)
            if org_members is None or user_id not in org_members:
                return "not_found"
            current = org_members[user_id]
            if current.role == 'owner' and role != 'owner':
                owner_count = sum(1 for mem in org_members.values() if mem.role == 'owner')
                if owner_count <= 1:
                    return "last_owner"
            org_members[user_id] = Membership(current.org_id, current.user_id, role, current.created_at)
            return "ok"

    def delete_membership(self, org_id: str, user_id: str) -> str:
        with self._lock:
            org_members = self._memberships.get(org_id)
            if org_members is None or user_id not in org_members:
                return "not_found"
            current = org_members[user_id]
            if current.role == 'owner':
                owner_count = sum(1 for mem in org_members.values() if mem.role == 'owner')
                if owner_count <= 1:
                    return "last_owner"
            del org_members[user_id]
            return "ok"

    def debug_dump(self) -> str:
        with self._lock:
            lines = []
            for org in self._orgs.values():
                lines.append(f"id={org.id}")
                lines.append(f"name={org.name}")
                lines.append(f"slug={org.slug}")
                lines.append(f"created_at={org.created_at}")
            for org_id, members in self._memberships.items():
                for mem in members.values():
                    lines.append(f"org_id={mem.org_id}")
                    lines.append(f"user_id={mem.user_id}")
                    lines.append(f"role={mem.role}")
                    lines.append(f"created_at={mem.created_at}")
            for inv in self._invitations.values():
                lines.append(f"id={inv.id}")
                lines.append(f"org_id={inv.org_id}")
                lines.append(f"email={inv.email}")
                lines.append(f"role={inv.role}")
                lines.append(f"token_hash={inv.token_hash}")
                lines.append(f"expires_at={inv.expires_at}")
                lines.append(f"accepted_at={inv.accepted_at if inv.accepted_at is not None else ''}")
                lines.append(f"invited_by={inv.invited_by}")
                lines.append(f"created_at={inv.created_at}")
            return '\n'.join(lines) + '\n'

SCHEMA_SQL = [
    "CREATE TABLE IF NOT EXISTS organizations (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(64) NOT NULL UNIQUE, created_at BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS memberships (org_id VARCHAR(64) NOT NULL REFERENCES organizations(id), user_id VARCHAR(255) NOT NULL, role VARCHAR(16) NOT NULL CHECK (role IN ('owner','admin','member')), created_at BIGINT NOT NULL, UNIQUE (org_id, user_id))",
    "CREATE TABLE IF NOT EXISTS invitations (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64) NOT NULL REFERENCES organizations(id), email VARCHAR(254) NOT NULL, role VARCHAR(16) NOT NULL CHECK (role IN ('owner','admin','member')), token_hash CHAR(64) NOT NULL UNIQUE, expires_at BIGINT NOT NULL, accepted_at BIGINT NULL, invited_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations (org_id)"
]

class SqlStore:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._conn.isolation_level = None
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()

    def create_schema(self) -> None:
        with self._lock:
            for stmt in SCHEMA_SQL:
                self._conn.execute(stmt)

    def insert_org_with_owner(self, org: Org, owner: Membership) -> bool:
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                cur = self._conn.execute("SELECT 1 FROM organizations WHERE slug = ?", (org.slug,))
                if cur.fetchone() is not None:
                    self._conn.execute("ROLLBACK")
                    return False
                self._conn.execute(
                    "INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)",
                    (org.id, org.name, org.slug, org.created_at)
                )
                self._conn.execute(
                    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
                    (owner.org_id, owner.user_id, owner.role, owner.created_at)
                )
                self._conn.execute("COMMIT")
                return True
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def find_org(self, org_id: str) -> Optional[Org]:
        with self._lock:
            cur = self._conn.execute("SELECT id, name, slug, created_at FROM organizations WHERE id = ?", (org_id,))
            row = cur.fetchone()
            if row is None:
                return None
            return Org(row['id'], row['name'], row['slug'], row['created_at'])

    def find_membership(self, org_id: str, user_id: str) -> Optional[Membership]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT org_id, user_id, role, created_at FROM memberships WHERE org_id = ? AND user_id = ?",
                (org_id, user_id)
            )
            row = cur.fetchone()
            if row is None:
                return None
            return Membership(row['org_id'], row['user_id'], row['role'], row['created_at'])

    def list_memberships(self, org_id: str) -> List[Membership]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT org_id, user_id, role, created_at FROM memberships WHERE org_id = ? ORDER BY created_at ASC, user_id ASC",
                (org_id,)
            )
            return [Membership(row['org_id'], row['user_id'], row['role'], row['created_at']) for row in cur.fetchall()]

    def insert_invitation(self, inv: Invitation) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO invitations (id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (inv.id, inv.org_id, inv.email, inv.role, inv.token_hash, inv.expires_at, inv.accepted_at, inv.invited_by, inv.created_at)
            )

    def find_invitation_by_hash(self, token_hash: str) -> Optional[Invitation]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at FROM invitations WHERE token_hash = ?",
                (token_hash,)
            )
            row = cur.fetchone()
            if row is None:
                return None
            return Invitation(
                row['id'], row['org_id'], row['email'], row['role'], row['token_hash'],
                row['expires_at'], row['accepted_at'] if row['accepted_at'] is not None else None,
                row['invited_by'], row['created_at']
            )

    def consume_invitation(self, invitation_id: str, m: Membership, now: int) -> str:
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._conn.execute("UPDATE organizations SET slug = slug WHERE id = ?", (m.org_id,))
                cur = self._conn.execute(
                    "SELECT accepted_at, expires_at FROM invitations WHERE id = ?",
                    (invitation_id,)
                )
                row = cur.fetchone()
                if row is None:
                    self._conn.execute("ROLLBACK")
                    return "not_found"
                if row['accepted_at'] is not None:
                    self._conn.execute("ROLLBACK")
                    return "used"
                if now >= row['expires_at']:
                    self._conn.execute("ROLLBACK")
                    return "expired"
                cur = self._conn.execute(
                    "SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?",
                    (m.org_id, m.user_id)
                )
                if cur.fetchone() is not None:
                    self._conn.execute("ROLLBACK")
                    return "already_member"
                cur = self._conn.execute(
                    "UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?",
                    (now, invitation_id, now)
                )
                if cur.rowcount != 1:
                    self._conn.execute("ROLLBACK")
                    return "used"
                self._conn.execute(
                    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
                    (m.org_id, m.user_id, m.role, m.created_at)
                )
                self._conn.execute("COMMIT")
                return "ok"
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def set_role(self, org_id: str, user_id: str, role: str) -> str:
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._conn.execute("UPDATE organizations SET slug = slug WHERE id = ?", (org_id,))
                cur = self._conn.execute(
                    "SELECT role FROM memberships WHERE org_id = ? AND user_id = ?",
                    (org_id, user_id)
                )
                row = cur.fetchone()
                if row is None:
                    self._conn.execute("ROLLBACK")
                    return "not_found"
                current_role = row['role']
                if current_role == 'owner' and role != 'owner':
                    cur = self._conn.execute(
                        "SELECT COUNT(*) as cnt FROM memberships WHERE org_id = ? AND role = 'owner'",
                        (org_id,)
                    )
                    owner_count = cur.fetchone()['cnt']
                    if owner_count <= 1:
                        self._conn.execute("ROLLBACK")
                        return "last_owner"
                self._conn.execute(
                    "UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?",
                    (role, org_id, user_id)
                )
                self._conn.execute("COMMIT")
                return "ok"
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def delete_membership(self, org_id: str, user_id: str) -> str:
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._conn.execute("UPDATE organizations SET slug = slug WHERE id = ?", (org_id,))
                cur = self._conn.execute(
                    "SELECT role FROM memberships WHERE org_id = ? AND user_id = ?",
                    (org_id, user_id)
                )
                row = cur.fetchone()
                if row is None:
                    self._conn.execute("ROLLBACK")
                    return "not_found"
                current_role = row['role']
                if current_role == 'owner':
                    cur = self._conn.execute(
                        "SELECT COUNT(*) as cnt FROM memberships WHERE org_id = ? AND role = 'owner'",
                        (org_id,)
                    )
                    owner_count = cur.fetchone()['cnt']
                    if owner_count <= 1:
                        self._conn.execute("ROLLBACK")
                        return "last_owner"
                self._conn.execute(
                    "DELETE FROM memberships WHERE org_id = ? AND user_id = ?",
                    (org_id, user_id)
                )
                self._conn.execute("COMMIT")
                return "ok"
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

class OrganizationsTeams:
    def __init__(self, store: Store, options: Optional[Options] = None) -> None:
        self._store = store
        self._options = options or Options()
        self._clock = self._options.clock
        self._random_bytes = self._options.random_bytes

    def _require_membership(self, actor: User, org_id: str) -> Membership:
        if not actor or not actor.id:
            raise OrgError("UNAUTHENTICATED", 401, "authentication required")
        m = self._store.find_membership(org_id, actor.id)
        if m is None:
            raise OrgError("ORG_NOT_FOUND", 404, "organization not found")
        return m

    def create_org(self, user: User, name: str) -> Org:
        if not user or not user.id:
            raise OrgError("UNAUTHENTICATED", 401, "authentication required")
        if not isinstance(name, str):
            raise OrgError("INVALID_NAME", 400, "invalid organization name")
        n = trim_ws(name)
        if not n or len(n.encode('utf-8')) > 200:
            raise OrgError("INVALID_NAME", 400, "invalid organization name")
        now = self._clock()
        org_id = hex_bytes(self._random_bytes(16))
        base_slug = slugify(n)
        for attempt in range(6):
            if attempt == 0:
                slug = base_slug
            else:
                suffix = hex_bytes(self._random_bytes(4))
                slug = f"{base_slug}-{suffix}"
            org = Org(org_id, n, slug, now)
            owner = Membership(org_id, user.id, "owner", now)
            if self._store.insert_org_with_owner(org, owner):
                return org
        raise OrgError("SLUG_CONFLICT", 409, "slug unavailable")

    def invite(self, actor: User, org_id: str, email: str, role: str) -> str:
        m = self._require_membership(actor, org_id)
        if m.role == "member":
            raise OrgError("FORBIDDEN", 403, "forbidden")
        if role not in ("owner", "admin", "member"):
            raise OrgError("INVALID_ROLE", 400, "invalid role")
        if role == "owner" and m.role != "owner":
            raise OrgError("FORBIDDEN", 403, "forbidden")
        try:
            e = normalize_email(email)
        except ValueError:
            raise OrgError("INVALID_EMAIL", 400, "invalid email")
        now = self._clock()
        raw_token = hex_bytes(self._random_bytes(32))
        inv_id = hex_bytes(self._random_bytes(16))
        token_hash = sha256_hex(raw_token)
        inv = Invitation(
            id=inv_id, org_id=org_id, email=e, role=role,
            token_hash=token_hash, expires_at=now + 604800,
            accepted_at=None, invited_by=actor.id, created_at=now
        )
        self._store.insert_invitation(inv)
        return raw_token

    def accept_invitation(self, user: User, raw_token: str) -> Membership:
        if not user or not user.id:
            raise OrgError("UNAUTHENTICATED", 401, "authentication required")
        if not is_token_shape(raw_token):
            raise OrgError("INVITATION_NOT_FOUND", 404, "invitation not found")
        token_hash = sha256_hex(raw_token)
        inv = self._store.find_invitation_by_hash(token_hash)
        if inv is None:
            raise OrgError("INVITATION_NOT_FOUND", 404, "invitation not found")
        try:
            user_email = normalize_email(user.email)
        except ValueError:
            raise OrgError("EMAIL_MISMATCH", 403, "invitation is for a different email")
        if user_email != inv.email:
            raise OrgError("EMAIL_MISMATCH", 403, "invitation is for a different email")
        if inv.accepted_at is not None:
            raise OrgError("INVITATION_USED", 410, "invitation already used")
        now = self._clock()
        if now >= inv.expires_at:
            raise OrgError("INVITATION_EXPIRED", 410, "invitation expired")
        issuer_mem = self._store.find_membership(inv.org_id, inv.invited_by)
        if issuer_mem is None or issuer_mem.role == "member" or (inv.role == "owner" and issuer_mem.role != "owner"):
            raise OrgError("INVITATION_REVOKED", 410, "invitation no longer valid")
        membership = Membership(inv.org_id, user.id, inv.role, now)
        outcome = self._store.consume_invitation(inv.id, membership, now)
        if outcome == "used":
            raise OrgError("INVITATION_USED", 410, "invitation already used")
        if outcome == "expired":
            raise OrgError("INVITATION_EXPIRED", 410, "invitation expired")
        if outcome == "already_member":
            raise OrgError("ALREADY_MEMBER", 409, "already a member")
        if outcome != "ok":
            raise OrgError("STORE_ERROR", 500, "store error")
        return membership

    def change_role(self, actor: User, org_id: str, user_id: str, role: str) -> Membership:
        m = self._require_membership(actor, org_id)
        if m.role == "member":
            raise OrgError("FORBIDDEN", 403, "forbidden")
        if role not in ("owner", "admin", "member"):
            raise OrgError("INVALID_ROLE", 400, "invalid role")
        target = self._store.find_membership(org_id, user_id)
        if target is None:
            raise OrgError("MEMBER_NOT_FOUND", 404, "member not found")
        if m.role == "admin" and (target.role == "owner" or role == "owner"):
            raise OrgError("FORBIDDEN", 403, "forbidden")
        if target.role == role:
            return target
        outcome = self._store.set_role(org_id, user_id, role)
        if outcome == "not_found":
            raise OrgError("MEMBER_NOT_FOUND", 404, "member not found")
        if outcome == "last_owner":
            raise OrgError("LAST_OWNER", 409, "organization must keep at least one owner")
        if outcome != "ok":
            raise OrgError("STORE_ERROR", 500, "store error")
        return Membership(target.org_id, target.user_id, role, target.created_at)

    def remove_member(self, actor: User, org_id: str, user_id: str) -> None:
        m = self._require_membership(actor, org_id)
        if m.role == "member":
            raise OrgError("FORBIDDEN", 403, "forbidden")
        target = self._store.find_membership(org_id, user_id)
        if target is None:
            raise OrgError("MEMBER_NOT_FOUND", 404, "member not found")
        if m.role == "admin" and target.role == "owner":
            raise OrgError("FORBIDDEN", 403, "forbidden")
        outcome = self._store.delete_membership(org_id, user_id)
        if outcome == "not_found":
            raise OrgError("MEMBER_NOT_FOUND", 404, "member not found")
        if outcome == "last_owner":
            raise OrgError("LAST_OWNER", 409, "organization must keep at least one owner")
        if outcome != "ok":
            raise OrgError("STORE_ERROR", 500, "store error")

    def leave_org(self, user: User, org_id: str) -> None:
        m = self._require_membership(user, org_id)
        outcome = self._store.delete_membership(org_id, user.id)
        if outcome == "last_owner":
            raise OrgError("LAST_OWNER", 409, "organization must keep at least one owner")
        if outcome == "not_found":
            raise OrgError("ORG_NOT_FOUND", 404, "organization not found")
        if outcome != "ok":
            raise OrgError("STORE_ERROR", 500, "store error")

    def list_members(self, actor: User, org_id: str) -> List[Membership]:
        self._require_membership(actor, org_id)
        return self._store.list_memberships(org_id)

    def get_org(self, actor: User, org_id: str) -> Org:
        self._require_membership(actor, org_id)
        org = self._store.find_org(org_id)
        if org is None:
            raise OrgError("ORG_NOT_FOUND", 404, "organization not found")
        return org