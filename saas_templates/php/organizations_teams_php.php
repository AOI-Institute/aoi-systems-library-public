<?php
declare(strict_types=1);

namespace Aoi\Orgs;

class OrgError extends \RuntimeException
{
    public readonly string $error_code;
    public readonly int $status;

    public function __construct(string $error_code, int $status, string $message)
    {
        parent::__construct($message, 0, null);
        $this->error_code = $error_code;
        $this->status = $status;
    }
}

interface Store
{
    public function insert_org_with_owner(array $org, array $owner): bool;
    public function find_org(string $org_id): ?array;
    public function find_membership(string $org_id, string $user_id): ?array;
    public function list_memberships(string $org_id): array;
    public function insert_invitation(array $invitation): void;
    public function find_invitation_by_hash(string $token_hash): ?array;
    public function consume_invitation(string $invitation_id, array $membership, int $now): string;
    public function set_role(string $org_id, string $user_id, string $role): string;
    public function delete_membership(string $org_id, string $user_id): string;
}

class InMemoryStore implements Store
{
    private array $orgs = [];
    private array $slugs = [];
    private array $memberships = [];
    private array $invitations = [];
    private array $invitation_by_hash = [];

    public function insert_org_with_owner(array $org, array $owner): bool
    {
        if (isset($this->slugs[$org['slug']])) {
            return false;
        }
        $this->orgs[$org['id']] = $org;
        $this->slugs[$org['slug']] = $org['id'];
        $this->memberships[$org['id']][$owner['user_id']] = $owner;
        return true;
    }

    public function find_org(string $org_id): ?array
    {
        return $this->orgs[$org_id] ?? null;
    }

    public function find_membership(string $org_id, string $user_id): ?array
    {
        return $this->memberships[$org_id][$user_id] ?? null;
    }

    public function list_memberships(string $org_id): array
    {
        $result = $this->memberships[$org_id] ?? [];
        usort($result, function ($a, $b) {
            if ($a['created_at'] !== $b['created_at']) {
                return $a['created_at'] <=> $b['created_at'];
            }
            return strcmp($a['user_id'], $b['user_id']);
        });
        return $result;
    }

    public function insert_invitation(array $invitation): void
    {
        $this->invitations[$invitation['id']] = $invitation;
        $this->invitation_by_hash[$invitation['token_hash']] = $invitation['id'];
    }

    public function find_invitation_by_hash(string $token_hash): ?array
    {
        $id = $this->invitation_by_hash[$token_hash] ?? null;
        if ($id === null) {
            return null;
        }
        return $this->invitations[$id] ?? null;
    }

    public function consume_invitation(string $invitation_id, array $membership, int $now): string
    {
        $inv = $this->invitations[$invitation_id] ?? null;
        if ($inv === null) {
            return 'not_found';
        }
        if ($inv['accepted_at'] !== null) {
            return 'used';
        }
        if ($now >= $inv['expires_at']) {
            return 'expired';
        }
        if (isset($this->memberships[$membership['org_id']][$membership['user_id']])) {
            return 'already_member';
        }
        $inv['accepted_at'] = $now;
        $this->memberships[$membership['org_id']][$membership['user_id']] = $membership;
        return 'ok';
    }

    public function set_role(string $org_id, string $user_id, string $role): string
    {
        $mem = $this->memberships[$org_id][$user_id] ?? null;
        if ($mem === null) {
            return 'not_found';
        }
        if ($mem['role'] === 'owner' && $role !== 'owner') {
            $owner_count = 0;
            foreach ($this->memberships[$org_id] as $m) {
                if ($m['role'] === 'owner') {
                    $owner_count++;
                }
            }
            if ($owner_count <= 1) {
                return 'last_owner';
            }
        }
        $mem['role'] = $role;
        return 'ok';
    }

    public function delete_membership(string $org_id, string $user_id): string
    {
        $mem = $this->memberships[$org_id][$user_id] ?? null;
        if ($mem === null) {
            return 'not_found';
        }
        if ($mem['role'] === 'owner') {
            $owner_count = 0;
            foreach ($this->memberships[$org_id] as $m) {
                if ($m['role'] === 'owner') {
                    $owner_count++;
                }
            }
            if ($owner_count <= 1) {
                return 'last_owner';
            }
        }
        unset($this->memberships[$org_id][$user_id]);
        return 'ok';
    }

    public function debug_dump(): string
    {
        $out = '';
        foreach ($this->orgs as $org) {
            foreach ($org as $v) {
                $out .= $v . "\n";
            }
        }
        foreach ($this->memberships as $org_mems) {
            foreach ($org_mems as $mem) {
                foreach ($mem as $v) {
                    $out .= $v . "\n";
                }
            }
        }
        foreach ($this->invitations as $inv) {
            foreach ($inv as $v) {
                $out .= $v . "\n";
            }
        }
        return $out;
    }
}

class SqlStore implements Store
{
    private \PDO $conn;

    public function __construct(\PDO $conn)
    {
        $this->conn = $conn;
        $this->conn->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
    }

    public static function create_schema(\PDO $conn): void
    {
        $statements = [
            "CREATE TABLE IF NOT EXISTS organizations (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(64) NOT NULL UNIQUE, created_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS memberships (org_id VARCHAR(64) NOT NULL REFERENCES organizations(id), user_id VARCHAR(255) NOT NULL, role VARCHAR(16) NOT NULL CHECK (role IN ('owner','admin','member')), created_at BIGINT NOT NULL, UNIQUE (org_id, user_id))",
            "CREATE TABLE IF NOT EXISTS invitations (id VARCHAR(64) PRIMARY KEY, org_id VARCHAR(64) NOT NULL REFERENCES organizations(id), email VARCHAR(254) NOT NULL, role VARCHAR(16) NOT NULL CHECK (role IN ('owner','admin','member')), token_hash CHAR(64) NOT NULL UNIQUE, expires_at BIGINT NOT NULL, accepted_at BIGINT NULL, invited_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations (org_id)"
        ];
        foreach ($statements as $sql) {
            $conn->exec($sql);
        }
    }

    private function begin_immediate(): void
    {
        $this->conn->exec('BEGIN IMMEDIATE');
    }

    public function insert_org_with_owner(array $org, array $owner): bool
    {
        $this->begin_immediate();
        try {
            $stmt = $this->conn->prepare('SELECT 1 FROM organizations WHERE slug = ?');
            $stmt->execute([$org['slug']]);
            if ($stmt->fetchColumn()) {
                $this->conn->rollBack();
                return false;
            }
            $stmt = $this->conn->prepare('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)');
            $stmt->execute([$org['id'], $org['name'], $org['slug'], $org['created_at']]);
            $stmt = $this->conn->prepare('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
            $stmt->execute([$owner['org_id'], $owner['user_id'], $owner['role'], $owner['created_at']]);
            $this->conn->commit();
            return true;
        } catch (\Throwable $e) {
            $this->conn->rollBack();
            throw $e;
        }
    }

    public function find_org(string $org_id): ?array
    {
        $stmt = $this->conn->prepare('SELECT id, name, slug, created_at FROM organizations WHERE id = ?');
        $stmt->execute([$org_id]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function find_membership(string $org_id, string $user_id): ?array
    {
        $stmt = $this->conn->prepare('SELECT org_id, user_id, role, created_at FROM memberships WHERE org_id = ? AND user_id = ?');
        $stmt->execute([$org_id, $user_id]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function list_memberships(string $org_id): array
    {
        $stmt = $this->conn->prepare('SELECT org_id, user_id, role, created_at FROM memberships WHERE org_id = ? ORDER BY created_at ASC, user_id ASC');
        $stmt->execute([$org_id]);
        return $stmt->fetchAll(\PDO::FETCH_ASSOC);
    }

    public function insert_invitation(array $invitation): void
    {
        $stmt = $this->conn->prepare('INSERT INTO invitations (id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $invitation['id'],
            $invitation['org_id'],
            $invitation['email'],
            $invitation['role'],
            $invitation['token_hash'],
            $invitation['expires_at'],
            $invitation['accepted_at'],
            $invitation['invited_by'],
            $invitation['created_at']
        ]);
    }

    public function find_invitation_by_hash(string $token_hash): ?array
    {
        $stmt = $this->conn->prepare('SELECT id, org_id, email, role, token_hash, expires_at, accepted_at, invited_by, created_at FROM invitations WHERE token_hash = ?');
        $stmt->execute([$token_hash]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function consume_invitation(string $invitation_id, array $membership, int $now): string
    {
        $this->begin_immediate();
        try {
            $stmt = $this->conn->prepare('UPDATE organizations SET slug = slug WHERE id = ?');
            $stmt->execute([$membership['org_id']]);

            $stmt = $this->conn->prepare('SELECT accepted_at, expires_at FROM invitations WHERE id = ?');
            $stmt->execute([$invitation_id]);
            $inv = $stmt->fetch(\PDO::FETCH_ASSOC);
            if ($inv === false) {
                $this->conn->rollBack();
                return 'not_found';
            }
            if ($inv['accepted_at'] !== null) {
                $this->conn->rollBack();
                return 'used';
            }
            if ($now >= (int)$inv['expires_at']) {
                $this->conn->rollBack();
                return 'expired';
            }

            $stmt = $this->conn->prepare('SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?');
            $stmt->execute([$membership['org_id'], $membership['user_id']]);
            if ($stmt->fetchColumn()) {
                $this->conn->rollBack();
                return 'already_member';
            }

            $stmt = $this->conn->prepare('UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND expires_at > ?');
            $stmt->execute([$now, $invitation_id, $now]);
            if ($stmt->rowCount() !== 1) {
                $this->conn->rollBack();
                return 'used';
            }

            $stmt = $this->conn->prepare('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
            $stmt->execute([$membership['org_id'], $membership['user_id'], $membership['role'], $now]);

            $this->conn->commit();
            return 'ok';
        } catch (\Throwable $e) {
            $this->conn->rollBack();
            throw $e;
        }
    }

    public function set_role(string $org_id, string $user_id, string $role): string
    {
        $this->begin_immediate();
        try {
            $stmt = $this->conn->prepare('UPDATE organizations SET slug = slug WHERE id = ?');
            $stmt->execute([$org_id]);

            $stmt = $this->conn->prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?');
            $stmt->execute([$org_id, $user_id]);
            $current = $stmt->fetchColumn();
            if ($current === false) {
                $this->conn->rollBack();
                return 'not_found';
            }

            if ($current === 'owner' && $role !== 'owner') {
                $stmt = $this->conn->prepare('SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = \'owner\'');
                $stmt->execute([$org_id]);
                $owner_count = (int)$stmt->fetchColumn();
                if ($owner_count <= 1) {
                    $this->conn->rollBack();
                    return 'last_owner';
                }
            }

            $stmt = $this->conn->prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?');
            $stmt->execute([$role, $org_id, $user_id]);

            $this->conn->commit();
            return 'ok';
        } catch (\Throwable $e) {
            $this->conn->rollBack();
            throw $e;
        }
    }

    public function delete_membership(string $org_id, string $user_id): string
    {
        $this->begin_immediate();
        try {
            $stmt = $this->conn->prepare('UPDATE organizations SET slug = slug WHERE id = ?');
            $stmt->execute([$org_id]);

            $stmt = $this->conn->prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?');
            $stmt->execute([$org_id, $user_id]);
            $current = $stmt->fetchColumn();
            if ($current === false) {
                $this->conn->rollBack();
                return 'not_found';
            }

            if ($current === 'owner') {
                $stmt = $this->conn->prepare('SELECT COUNT(*) FROM memberships WHERE org_id = ? AND role = \'owner\'');
                $stmt->execute([$org_id]);
                $owner_count = (int)$stmt->fetchColumn();
                if ($owner_count <= 1) {
                    $this->conn->rollBack();
                    return 'last_owner';
                }
            }

            $stmt = $this->conn->prepare('DELETE FROM memberships WHERE org_id = ? AND user_id = ?');
            $stmt->execute([$org_id, $user_id]);

            $this->conn->commit();
            return 'ok';
        } catch (\Throwable $e) {
            $this->conn->rollBack();
            throw $e;
        }
    }
}

class OrganizationsTeams
{
    private Store $store;
    private $clock;
    private $random_bytes;

    public function __construct(Store $store, array $options = [])
    {
        $this->store = $store;
        $this->clock = $options['clock'] ?? fn(): int => time();
        $this->random_bytes = $options['random_bytes'] ?? fn(int $n): string => random_bytes($n);
    }

    private function trim_ws(string $s): string
    {
        return trim($s, " \t\r\n");
    }

    private function ascii_lower(string $s): string
    {
        $out = '';
        for ($i = 0; $i < strlen($s); $i++) {
            $c = $s[$i];
            if ($c >= 'A' && $c <= 'Z') {
                $out .= chr(ord($c) + 32);
            } else {
                $out .= $c;
            }
        }
        return $out;
    }

    private function normalize_email(string $s): string
    {
        return $this->ascii_lower($this->trim_ws($s));
    }

    private function is_valid_email(string $email): bool
    {
        if (strlen($email) > 254) {
            return false;
        }
        $parts = explode('@', $email, 2);
        if (count($parts) !== 2 || $parts[0] === '' || $parts[1] === '') {
            return false;
        }
        for ($i = 0; $i < strlen($email); $i++) {
            $ord = ord($email[$i]);
            if ($ord <= 0x20 || $ord === 0x7F) {
                return false;
            }
        }
        return true;
    }

    private function hex(string $bytes): string
    {
        return bin2hex($bytes);
    }

    private function sha256_hex(string $s): string
    {
        return hash('sha256', $s);
    }

    private function is_token_shape(string $s): bool
    {
        if (strlen($s) !== 64) {
            return false;
        }
        return preg_match('/^[0-9a-f]{64}$/D', $s) === 1;
    }

    private function slugify(string $name): string
    {
        $s = $this->ascii_lower($name);
        $s = preg_replace('/[^a-z0-9]+/', '-', $s);
        $s = trim($s, '-');
        if (strlen($s) > 48) {
            $s = substr($s, 0, 48);
            $s = rtrim($s, '-');
        }
        if ($s === '') {
            $s = 'org';
        }
        return $s;
    }

    private function require_membership(array $actor, string $org_id): array
    {
        if (!isset($actor['id']) || !is_string($actor['id']) || $actor['id'] === '') {
            throw new OrgError('UNAUTHENTICATED', 401, 'authentication required');
        }
        $m = $this->store->find_membership($org_id, $actor['id']);
        if ($m === null) {
            throw new OrgError('ORG_NOT_FOUND', 404, 'organization not found');
        }
        return $m;
    }

    public function create_org(array $user, string $name): array
    {
        if (!isset($user['id']) || !is_string($user['id']) || $user['id'] === '') {
            throw new OrgError('UNAUTHENTICATED', 401, 'authentication required');
        }
        $n = $this->trim_ws($name);
        if (!is_string($name) || $n === '' || strlen($n) > 200) {
            throw new OrgError('INVALID_NAME', 400, 'invalid organization name');
        }
        $now = ($this->clock)();
        $id = $this->hex(($this->random_bytes)(16));
        $base = $this->slugify($n);
        for ($attempt = 0; $attempt < 6; $attempt++) {
            if ($attempt === 0) {
                $slug = $base;
            } else {
                $suffix = $this->hex(($this->random_bytes)(4));
                $slug = $base . '-' . $suffix;
            }
            $org = ['id' => $id, 'name' => $n, 'slug' => $slug, 'created_at' => $now];
            $owner = ['org_id' => $id, 'user_id' => $user['id'], 'role' => 'owner', 'created_at' => $now];
            if ($this->store->insert_org_with_owner($org, $owner)) {
                return $org;
            }
        }
        throw new OrgError('SLUG_CONFLICT', 409, 'slug unavailable');
    }

    public function invite(array $actor, string $org_id, string $email, string $role): string
    {
        $m = $this->require_membership($actor, $org_id);
        if ($m['role'] === 'member') {
            throw new OrgError('FORBIDDEN', 403, 'forbidden');
        }
        if (!in_array($role, ['owner', 'admin', 'member'], true)) {
            throw new OrgError('INVALID_ROLE', 400, 'invalid role');
        }
        if ($role === 'owner' && $m['role'] !== 'owner') {
            throw new OrgError('FORBIDDEN', 403, 'forbidden');
        }
        $e = $this->normalize_email($email);
        if (!$this->is_valid_email($e)) {
            throw new OrgError('INVALID_EMAIL', 400, 'invalid email');
        }
        $now = ($this->clock)();
        $raw = $this->hex(($this->random_bytes)(32));
        $id = $this->hex(($this->random_bytes)(16));
        $invitation = [
            'id' => $id,
            'org_id' => $org_id,
            'email' => $e,
            'role' => $role,
            'token_hash' => $this->sha256_hex($raw),
            'expires_at' => $now + 604800,
            'accepted_at' => null,
            'invited_by' => $actor['id'],
            'created_at' => $now
        ];
        $this->store->insert_invitation($invitation);
        return $raw;
    }

    public function accept_invitation(array $user, string $raw_token): array
    {
        if (!isset($user['id']) || !is_string($user['id']) || $user['id'] === '') {
            throw new OrgError('UNAUTHENTICATED', 401, 'authentication required');
        }
        if (!$this->is_token_shape($raw_token)) {
            throw new OrgError('INVITATION_NOT_FOUND', 404, 'invitation not found');
        }
        $token_hash = $this->sha256_hex($raw_token);
        $inv = $this->store->find_invitation_by_hash($token_hash);
        if ($inv === null) {
            throw new OrgError('INVITATION_NOT_FOUND', 404, 'invitation not found');
        }
        $user_email = $this->normalize_email($user['email'] ?? '');
        if ($user_email !== $inv['email']) {
            throw new OrgError('EMAIL_MISMATCH', 403, 'invitation is for a different email');
        }
        if ($inv['accepted_at'] !== null) {
            throw new OrgError('INVITATION_USED', 410, 'invitation already used');
        }
        $now = ($this->clock)();
        if ($now >= $inv['expires_at']) {
            throw new OrgError('INVITATION_EXPIRED', 410, 'invitation expired');
        }
        $issuer = $this->store->find_membership($inv['org_id'], $inv['invited_by']);
        if ($issuer === null || $issuer['role'] === 'member' || ($inv['role'] === 'owner' && $issuer['role'] !== 'owner')) {
            throw new OrgError('INVITATION_REVOKED', 410, 'invitation no longer valid');
        }
        $membership = [
            'org_id' => $inv['org_id'],
            'user_id' => $user['id'],
            'role' => $inv['role'],
            'created_at' => $now
        ];
        $outcome = $this->store->consume_invitation($inv['id'], $membership, $now);
        if ($outcome === 'used') {
            throw new OrgError('INVITATION_USED', 410, 'invitation already used');
        }
        if ($outcome === 'expired') {
            throw new OrgError('INVITATION_EXPIRED', 410, 'invitation expired');
        }
        if ($outcome === 'already_member') {
            throw new OrgError('ALREADY_MEMBER', 409, 'already a member');
        }
        return $membership;
    }

    public function change_role(array $actor, string $org_id, string $user_id, string $role): array
    {
        $m = $this->require_membership($actor, $org_id);
        if ($m['role'] === 'member') {
            throw new OrgError('FORBIDDEN', 403, 'forbidden');
        }
        if (!in_array($role, ['owner', 'admin', 'member'], true)) {
            throw new OrgError('INVALID_ROLE', 400, 'invalid role');
        }
        $t = $this->store->find_membership($org_id, $user_id);
        if ($t === null) {
            throw new OrgError('MEMBER_NOT_FOUND', 404, 'member not found');
        }
        if ($m['role'] === 'admin' && ($t['role'] === 'owner' || $role === 'owner')) {
            throw new OrgError('FORBIDDEN', 403, 'forbidden');
        }
        if ($t['role'] === $role) {
            return $t;
        }
        $outcome = $this->store->set_role($org_id, $user_id, $role);
        if ($outcome === 'not_found') {
            throw new OrgError('MEMBER_NOT_FOUND', 404, 'member not found');
        }
        if ($outcome === 'last_owner') {
            throw new OrgError('LAST_OWNER', 409, 'organization must keep at least one owner');
        }
        $t['role'] = $role;
        return $t;
    }

    public function remove_member(array $actor, string $org_id, string $user_id): void
    {
        $m = $this->require_membership($actor, $org_id);
        if ($m['role'] === 'member') {
            throw new OrgError('FORBIDDEN', 403, 'forbidden');
        }
        $t = $this->store->find_membership($org_id, $user_id);
        if ($t === null) {
            throw new OrgError('MEMBER_NOT_FOUND', 404, 'member not found');
        }
        if ($m['role'] === 'admin' && $t['role'] === 'owner') {
            throw new OrgError('FORBIDDEN', 403, 'forbidden');
        }
        $outcome = $this->store->delete_membership($org_id, $user_id);
        if ($outcome === 'not_found') {
            throw new OrgError('MEMBER_NOT_FOUND', 404, 'member not found');
        }
        if ($outcome === 'last_owner') {
            throw new OrgError('LAST_OWNER', 409, 'organization must keep at least one owner');
        }
    }

    public function leave_org(array $user, string $org_id): void
    {
        $this->require_membership($user, $org_id);
        $outcome = $this->store->delete_membership($org_id, $user['id']);
        if ($outcome === 'last_owner') {
            throw new OrgError('LAST_OWNER', 409, 'organization must keep at least one owner');
        }
        if ($outcome === 'not_found') {
            throw new OrgError('ORG_NOT_FOUND', 404, 'organization not found');
        }
    }

    public function list_members(array $actor, string $org_id): array
    {
        $this->require_membership($actor, $org_id);
        return $this->store->list_memberships($org_id);
    }

    public function get_org(array $actor, string $org_id): array
    {
        $this->require_membership($actor, $org_id);
        $org = $this->store->find_org($org_id);
        if ($org === null) {
            throw new OrgError('ORG_NOT_FOUND', 404, 'organization not found');
        }
        return $org;
    }
}