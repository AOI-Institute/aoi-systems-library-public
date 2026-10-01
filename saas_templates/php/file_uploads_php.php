<?php

final class FileUploadError extends \RuntimeException {
    public readonly string $error_code;
    public readonly int $status;

    public function __construct(string $error_code, int $status, string $message = '') {
        parent::__construct($message, 0, null);
        $this->error_code = $error_code;
        $this->status = $status;
    }
}

interface FileStore {
    public function insert_file(FileRecord $rec): bool;
    public function find_file(string $id): ?FileRecord;
    public function mark_deleted(string $id, int $at): bool;
}

final class FileRecord {
    public function __construct(
        public readonly string $id,
        public readonly string $org_id,
        public readonly string $owner_user_id,
        public readonly string $stored_name,
        public readonly string $original_name,
        public readonly string $extension,
        public readonly string $mime_type,
        public readonly int $size_bytes,
        public readonly string $sha256,
        public readonly int $created_at,
        public readonly ?int $deleted_at
    ) {}
}

final class FileInfo {
    public function __construct(
        public readonly string $file_id,
        public readonly string $org_id,
        public readonly string $owner_user_id,
        public readonly string $original_name,
        public readonly string $extension,
        public readonly string $mime_type,
        public readonly int $size_bytes,
        public readonly string $sha256,
        public readonly int $created_at
    ) {}
}

final class UploadResult {
    public function __construct(public readonly string $file_id) {}
}

final class DownloadLink {
    public function __construct(public readonly string $token, public readonly int $expires_at) {}
}

final class DownloadResponse {
    public function __construct(public readonly int $status, public readonly string $content_type, public readonly string $body) {}
}

final class InMemoryFileStore implements FileStore {
    private array $files = [];

    public function insert_file(FileRecord $rec): bool {
        if (isset($this->files[$rec->id])) {
            return false;
        }
        $this->files[$rec->id] = $rec;
        return true;
    }

    public function find_file(string $id): ?FileRecord {
        return $this->files[$id] ?? null;
    }

    public function mark_deleted(string $id, int $at): bool {
        if (!isset($this->files[$id])) {
            return false;
        }
        $rec = $this->files[$id];
        if ($rec->deleted_at !== null) {
            return false;
        }
        $this->files[$id] = new FileRecord(
            $rec->id, $rec->org_id, $rec->owner_user_id, $rec->stored_name,
            $rec->original_name, $rec->extension, $rec->mime_type,
            $rec->size_bytes, $rec->sha256, $rec->created_at, $at
        );
        return true;
    }
}

final class SqlFileStore implements FileStore {
    private \PDO $pdo;

    public function __construct(\PDO $pdo) {
        $this->pdo = $pdo;
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
    }

    public function ensure_schema(): void {
        $sql = "CREATE TABLE IF NOT EXISTS files (
            id VARCHAR(32) NOT NULL PRIMARY KEY,
            org_id VARCHAR(255) NOT NULL,
            owner_user_id VARCHAR(255) NOT NULL,
            stored_name VARCHAR(32) NOT NULL UNIQUE,
            original_name VARCHAR(255) NOT NULL,
            extension VARCHAR(10) NOT NULL,
            mime_type VARCHAR(100) NOT NULL,
            size_bytes BIGINT NOT NULL,
            sha256 CHAR(64) NOT NULL,
            created_at BIGINT NOT NULL,
            deleted_at BIGINT NULL
        )";
        $this->pdo->exec($sql);
    }

    public function insert_file(FileRecord $rec): bool {
        $sql = "INSERT INTO files (id, org_id, owner_user_id, stored_name, original_name, extension, mime_type, size_bytes, sha256, created_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try {
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute([
                $rec->id, $rec->org_id, $rec->owner_user_id, $rec->stored_name,
                $rec->original_name, $rec->extension, $rec->mime_type,
                $rec->size_bytes, $rec->sha256, $rec->created_at, $rec->deleted_at
            ]);
            return true;
        } catch (\PDOException $e) {
            $check = $this->pdo->prepare("SELECT 1 FROM files WHERE id = ?");
            $check->execute([$rec->id]);
            if ($check->fetchColumn()) {
                return false;
            }
            throw $e;
        }
    }

    public function find_file(string $id): ?FileRecord {
        $stmt = $this->pdo->prepare("SELECT id, org_id, owner_user_id, stored_name, original_name, extension, mime_type, size_bytes, sha256, created_at, deleted_at FROM files WHERE id = ?");
        $stmt->execute([$id]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        return new FileRecord(
            $row['id'], $row['org_id'], $row['owner_user_id'], $row['stored_name'],
            $row['original_name'], $row['extension'], $row['mime_type'],
            (int)$row['size_bytes'], $row['sha256'], (int)$row['created_at'],
            $row['deleted_at'] !== null ? (int)$row['deleted_at'] : null
        );
    }

    public function mark_deleted(string $id, int $at): bool {
        $stmt = $this->pdo->prepare("UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
        $stmt->execute([$at, $id]);
        return $stmt->rowCount() === 1;
    }
}

final class FileUploads {
    private const DEFAULT_MAX_FILE_SIZE = 10485760;
    private const DEFAULT_LINK_TTL_SECONDS = 300;
    private const MAX_LINK_TTL_SECONDS = 86400;
    private const MAX_FILENAME_BYTES = 255;
    private const SIGN_PREFIX = 'file_uploads.v1.';

    private const MAGIC_SIGNATURES = [
        'png' => "\x89\x50\x4e\x47\x0d\x0a\x1a\x0a",
        'jpg' => "\xff\xd8\xff",
        'jpeg' => "\xff\xd8\xff",
        'gif' => ["GIF87a", "GIF89a"],
        'pdf' => "%PDF-",
        'docx' => "PK\x03\x04",
        'xlsx' => "PK\x03\x04",
        'txt' => null,
        'csv' => null,
    ];

    private const MIME_TYPES = [
        'pdf' => 'application/pdf',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'txt' => 'text/plain',
        'csv' => 'text/csv',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];

    private const BANNED_SEGMENTS = ['public', 'public_html', 'www', 'wwwroot', 'htdocs'];

    private FileStore $store;
    private string $storage_dir;
    private string $signing_key;
    private $is_member;
    private $now;
    private $random_bytes;
    private int $max_file_size;
    private array $allowed_extensions;

    public function __construct(FileStore $store, array $options) {
        $unknown = array_diff(array_keys($options), [
            'storage_dir', 'signing_key', 'is_member', 'now', 'random_bytes',
            'max_file_size', 'allowed_extensions'
        ]);
        if ($unknown) {
            throw new FileUploadError('INVALID_CONFIG', 500, 'Unknown option(s): ' . implode(', ', $unknown));
        }

        $this->store = $store;

        $this->storage_dir = $options['storage_dir'] ?? '';
        if ($this->storage_dir === '') {
            throw new FileUploadError('INVALID_CONFIG', 500, 'storage_dir is required');
        }
        $segments = preg_split('/[\\/\\\\]+/', $this->storage_dir);
        foreach ($segments as $seg) {
            $lower = strtolower($seg);
            if (in_array($lower, self::BANNED_SEGMENTS, true)) {
                throw new FileUploadError('INVALID_CONFIG', 500, 'storage_dir contains banned segment: ' . $seg);
            }
        }

        $this->signing_key = $options['signing_key'] ?? '';
        if (strlen($this->signing_key) < 32) {
            throw new FileUploadError('INVALID_CONFIG', 500, 'signing_key must be at least 32 bytes');
        }

        $this->is_member = $options['is_member'] ?? null;
        if (!$this->is_member) {
            throw new FileUploadError('INVALID_CONFIG', 500, 'is_member is required');
        }

        $this->now = $options['now'] ?? fn() => (int)(time());
        $this->random_bytes = $options['random_bytes'] ?? fn(int $n) => random_bytes($n);

        $this->max_file_size = $options['max_file_size'] ?? self::DEFAULT_MAX_FILE_SIZE;
        if ($this->max_file_size < 1) {
            throw new FileUploadError('INVALID_CONFIG', 500, 'max_file_size must be >= 1');
        }

        $this->allowed_extensions = $options['allowed_extensions'] ?? array_keys(self::MAGIC_SIGNATURES);
        $this->allowed_extensions = array_map('strtolower', $this->allowed_extensions);
        if (empty($this->allowed_extensions)) {
            throw new FileUploadError('INVALID_CONFIG', 500, 'allowed_extensions cannot be empty');
        }
        $known = array_keys(self::MAGIC_SIGNATURES);
        foreach ($this->allowed_extensions as $ext) {
            if (!in_array($ext, $known, true)) {
                throw new FileUploadError('INVALID_CONFIG', 500, 'allowed_extensions contains unknown type: ' . $ext);
            }
        }
    }

    public function upload(string $user_id, string $org_id, string $original_filename, string $data, string $declared_content_type): UploadResult {
        if ($user_id === '' || $org_id === '' || !($this->is_member)($user_id, $org_id)) {
            throw new FileUploadError('FORBIDDEN', 403, 'User not a member of organization');
        }

        if (strlen($original_filename) > self::MAX_FILENAME_BYTES) {
            throw new FileUploadError('FILENAME_TOO_LONG', 400, 'Filename exceeds 255 bytes');
        }

        if (!preg_match('//u', $original_filename)) {
            throw new FileUploadError('INVALID_FILENAME', 400, 'Filename is not valid UTF-8');
        }

        $display = $this->sanitize($original_filename);
        if ($display === '' || $display === '.' || $display === '..') {
            throw new FileUploadError('INVALID_FILENAME', 400, 'Invalid filename after sanitization');
        }

        $ext = $this->ext_of($display);
        $ext = strtolower($ext);
        if (!in_array($ext, $this->allowed_extensions, true)) {
            throw new FileUploadError('EXTENSION_NOT_ALLOWED', 415, 'Extension not allowed: ' . $ext);
        }

        if (strlen($data) > $this->max_file_size) {
            throw new FileUploadError('FILE_TOO_LARGE', 413, 'File exceeds size limit');
        }

        if (!$this->check_magic_bytes($data, $ext)) {
            throw new FileUploadError('CONTENT_MISMATCH', 415, 'File content does not match extension');
        }

        $id_bytes = ($this->random_bytes)(16);
        if (strlen($id_bytes) !== 16) {
            throw new FileUploadError('STORAGE_ERROR', 500, 'random_bytes did not return 16 bytes');
        }
        $file_id = bin2hex($id_bytes);
        $now = ($this->now)();
        $sha256 = hash('sha256', $data);

        if (!is_dir($this->storage_dir)) {
            if (!mkdir($this->storage_dir, 0700, true) && !is_dir($this->storage_dir)) {
                throw new FileUploadError('STORAGE_ERROR', 500, 'Failed to create storage directory');
            }
        }
        $file_path = $this->storage_dir . DIRECTORY_SEPARATOR . $file_id;
        $fp = @fopen($file_path, 'xb');
        if ($fp === false) {
            throw new FileUploadError('STORAGE_ERROR', 500, 'File already exists (id collision)');
        }
        $written = fwrite($fp, $data);
        fclose($fp);
        if ($written !== strlen($data)) {
            @unlink($file_path);
            throw new FileUploadError('STORAGE_ERROR', 500, 'Failed to write file completely');
        }

        $rec = new FileRecord(
            $file_id, $org_id, $user_id, $file_id, $display, $ext,
            self::MIME_TYPES[$ext], strlen($data), $sha256, $now, null
        );

        $inserted = $this->store->insert_file($rec);
        if (!$inserted) {
            @unlink($file_path);
            throw new FileUploadError('STORAGE_ERROR', 500, 'Failed to insert file record (id collision)');
        }

        return new UploadResult($file_id);
    }

    public function create_download_link(string $user_id, string $file_id, int $ttl = self::DEFAULT_LINK_TTL_SECONDS): DownloadLink {
        if (!is_int($ttl) || $ttl < 1 || $ttl > self::MAX_LINK_TTL_SECONDS) {
            throw new FileUploadError('INVALID_TTL', 400, 'TTL must be between 1 and 86400');
        }

        if (!$this->is_hex($file_id, 32)) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        $rec = $this->store->find_file($file_id);
        if (!$rec || $rec->deleted_at !== null) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        if (!($this->is_member)($user_id, $rec->org_id)) {
            throw new FileUploadError('FORBIDDEN', 403, 'User not a member of organization');
        }

        $exp = ($this->now)() + $ttl;
        $exp_str = (string)$exp;
        $sig = $this->sign($file_id, $exp_str);
        $token = $file_id . '.' . $exp_str . '.' . $sig;

        return new DownloadLink($token, $exp);
    }

    public function download(string $user_id, string $token): DownloadResponse {
        $parts = explode('.', $token, 4);
        if (count($parts) !== 3) {
            throw new FileUploadError('INVALID_LINK', 400, 'Malformed token');
        }
        [$fid, $exp_str, $sig] = $parts;

        if (!$this->is_hex($fid, 32) || !$this->is_digits($exp_str) || !$this->is_hex($sig, 64)) {
            throw new FileUploadError('INVALID_LINK', 400, 'Invalid token format');
        }

        $expected_sig = $this->sign($fid, $exp_str);
        if (!hash_equals($expected_sig, $sig)) {
            throw new FileUploadError('INVALID_LINK', 400, 'Invalid signature');
        }

        $exp = (int)$exp_str;
        if (($this->now)() >= $exp) {
            throw new FileUploadError('LINK_EXPIRED', 410, 'Link has expired');
        }

        $rec = $this->store->find_file($fid);
        if (!$rec || $rec->deleted_at !== null) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        if (!($this->is_member)($user_id, $rec->org_id)) {
            throw new FileUploadError('FORBIDDEN', 403, 'User not a member of organization');
        }

        if (!$this->is_hex($rec->stored_name, 32)) {
            throw new FileUploadError('STORAGE_ERROR', 500, 'Corrupted stored name');
        }
        $file_path = $this->storage_dir . DIRECTORY_SEPARATOR . $rec->stored_name;
        $body = @file_get_contents($file_path);
        if ($body === false) {
            throw new FileUploadError('STORAGE_ERROR', 500, 'Failed to read file');
        }
        if (hash('sha256', $body) !== $rec->sha256) {
            throw new FileUploadError('STORAGE_ERROR', 500, 'File integrity check failed');
        }

        return new DownloadResponse(200, $rec->mime_type, $body);
    }

    public function delete_file(string $user_id, string $file_id): void {
        if (!$this->is_hex($file_id, 32)) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        $rec = $this->store->find_file($file_id);
        if (!$rec || $rec->deleted_at !== null) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        if (!($this->is_member)($user_id, $rec->org_id)) {
            throw new FileUploadError('FORBIDDEN', 403, 'User not a member of organization');
        }

        if ($user_id !== $rec->owner_user_id) {
            throw new FileUploadError('FORBIDDEN', 403, 'Only the owner can delete the file');
        }

        $now = ($this->now)();
        if (!$this->store->mark_deleted($file_id, $now)) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found or already deleted');
        }
    }

    public function get_file(string $user_id, string $file_id): FileInfo {
        if (!$this->is_hex($file_id, 32)) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        $rec = $this->store->find_file($file_id);
        if (!$rec || $rec->deleted_at !== null) {
            throw new FileUploadError('NOT_FOUND', 404, 'File not found');
        }

        if (!($this->is_member)($user_id, $rec->org_id)) {
            throw new FileUploadError('FORBIDDEN', 403, 'User not a member of organization');
        }

        return new FileInfo(
            $rec->id, $rec->org_id, $rec->owner_user_id, $rec->original_name,
            $rec->extension, $rec->mime_type, $rec->size_bytes, $rec->sha256, $rec->created_at
        );
    }

    private function sanitize(string $name): string {
        $name = preg_replace('/[\x00-\x1f\x7f]/', '', $name);
        $name = str_replace('\\', '/', $name);
        $parts = explode('/', $name);
        return end($parts);
    }

    private function ext_of(string $display): string {
        $pos = strrpos($display, '.');
        if ($pos === false) {
            return '';
        }
        return strtolower(substr($display, $pos + 1));
    }

    private function check_magic_bytes(string $data, string $ext): bool {
        $sig = self::MAGIC_SIGNATURES[$ext] ?? null;
        if ($sig === null) {
            return !str_contains($data, "\x00");
        }
        if (is_array($sig)) {
            foreach ($sig as $s) {
                if (str_starts_with($data, $s)) {
                    return true;
                }
            }
            return false;
        }
        return str_starts_with($data, $sig);
    }

    private function sign(string $fid, string $exp_str): string {
        $msg = self::SIGN_PREFIX . $fid . '.' . $exp_str;
        return hash_hmac('sha256', $msg, $this->signing_key);
    }

    private function is_hex(string $s, int $len): bool {
        if (strlen($s) !== $len) {
            return false;
        }
        for ($i = 0; $i < $len; $i++) {
            $c = $s[$i];
            if (!($c >= '0' && $c <= '9') && !($c >= 'a' && $c <= 'f')) {
                return false;
            }
        }
        return true;
    }

    private function is_digits(string $s): bool {
        $len = strlen($s);
        if ($len < 1 || $len > 12) {
            return false;
        }
        for ($i = 0; $i < $len; $i++) {
            $c = $s[$i];
            if ($c < '0' || $c > '9') {
                return false;
            }
        }
        return true;
    }
}