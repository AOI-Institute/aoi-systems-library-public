import dataclasses
import hashlib
import hmac
import os
import sqlite3
import threading
from typing import Callable, Optional, Tuple

DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024
DEFAULT_LINK_TTL_SECONDS = 300
MAX_LINK_TTL_SECONDS = 86400
MAX_FILENAME_BYTES = 255

MAGIC_SIGNATURES = {
    'png': [b'\x89PNG\r\n\x1a\n'],
    'jpg': [b'\xff\xd8\xff'],
    'jpeg': [b'\xff\xd8\xff'],
    'gif': [b'GIF87a', b'GIF89a'],
    'pdf': [b'%PDF-'],
    'docx': [b'PK\x03\x04'],
    'xlsx': [b'PK\x03\x04'],
}

MIME_TYPES = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'txt': 'text/plain',
    'csv': 'text/csv',
}

@dataclasses.dataclass(frozen=True)
class FileRecord:
    id: str
    org_id: str
    owner_user_id: str
    stored_name: str
    original_name: str
    extension: str
    mime_type: str
    size_bytes: int
    sha256: str
    created_at: int
    deleted_at: Optional[int] = None

@dataclasses.dataclass(frozen=True)
class FileInfo:
    file_id: str
    org_id: str
    owner_user_id: str
    original_name: str
    extension: str
    mime_type: str
    size_bytes: int
    sha256: str
    created_at: int

@dataclasses.dataclass(frozen=True)
class UploadResult:
    file_id: str

@dataclasses.dataclass(frozen=True)
class DownloadLink:
    token: str
    expires_at: int

@dataclasses.dataclass(frozen=True)
class DownloadResponse:
    status: int
    content_type: str
    body: bytes

class FileUploadError(Exception):
    def __init__(self, code: str, status: int, message: str):
        self.code = code
        self.status = status
        self.message = message
        super().__init__(message)

@dataclasses.dataclass
class FileUploadsOptions:
    storage_dir: str
    signing_key: bytes
    is_member: Callable[[str, str], bool]
    now: Callable[[], int] = lambda: int(__import__('time').time())
    random_bytes: Callable[[int], bytes] = os.urandom
    max_file_size: int = DEFAULT_MAX_FILE_SIZE
    allowed_extensions: Tuple[str, ...] = ('pdf', 'png', 'jpg', 'jpeg', 'gif', 'txt', 'csv', 'docx', 'xlsx')

class FileStore:
    def insert_file(self, rec: FileRecord) -> bool:
        raise NotImplementedError()
    def find_file(self, file_id: str) -> Optional[FileRecord]:
        raise NotImplementedError()
    def mark_deleted(self, file_id: str, at: int) -> bool:
        raise NotImplementedError()

class InMemoryFileStore(FileStore):
    def __init__(self):
        self._lock = threading.Lock()
        self._map: dict[str, FileRecord] = {}

    def insert_file(self, rec: FileRecord) -> bool:
        with self._lock:
            if rec.id in self._map:
                return False
            self._map[rec.id] = dataclasses.replace(rec)
            return True

    def find_file(self, file_id: str) -> Optional[FileRecord]:
        with self._lock:
            rec = self._map.get(file_id)
            if rec is None:
                return None
            return dataclasses.replace(rec)

    def mark_deleted(self, file_id: str, at: int) -> bool:
        with self._lock:
            rec = self._map.get(file_id)
            if rec is None or rec.deleted_at is not None:
                return False
            self._map[file_id] = dataclasses.replace(rec, deleted_at=at)
            return True

class SqlFileStore(FileStore):
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.conn.row_factory = sqlite3.Row

    def ensure_schema(self):
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS files (
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
            )
        ''')
        self.conn.commit()

    def insert_file(self, rec: FileRecord) -> bool:
        try:
            self.conn.execute('''
                INSERT INTO files (id, org_id, owner_user_id, stored_name, original_name, extension, mime_type,
                                   size_bytes, sha256, created_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                rec.id, rec.org_id, rec.owner_user_id, rec.stored_name, rec.original_name, rec.extension,
                rec.mime_type, rec.size_bytes, rec.sha256, rec.created_at, rec.deleted_at
            ))
            self.conn.commit()
            return True
        except Exception:
            cur = self.conn.execute('SELECT 1 FROM files WHERE id = ?', (rec.id,))
            if cur.fetchone() is not None:
                return False
            raise

    def find_file(self, file_id: str) -> Optional[FileRecord]:
        cur = self.conn.execute('''
            SELECT id, org_id, owner_user_id, stored_name, original_name, extension, mime_type,
                   size_bytes, sha256, created_at, deleted_at
            FROM files WHERE id = ?
        ''', (file_id,))
        row = cur.fetchone()
        if row is None:
            return None
        return FileRecord(
            id=row[0], org_id=row[1], owner_user_id=row[2], stored_name=row[3],
            original_name=row[4], extension=row[5], mime_type=row[6], size_bytes=row[7],
            sha256=row[8], created_at=row[9], deleted_at=row[10]
        )

    def mark_deleted(self, file_id: str, at: int) -> bool:
        cur = self.conn.execute(
            'UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
            (at, file_id)
        )
        self.conn.commit()
        return cur.rowcount == 1

class FileUploads:
    def __init__(self, store: FileStore, options: FileUploadsOptions):
        if not options.storage_dir:
            raise FileUploadError('INVALID_CONFIG', 500, 'storage_dir is empty')
        banned = ("public", "public_html", "www", "wwwroot", "htdocs")
        normalized_path = options.storage_dir.replace('\\', '/')
        for segment in normalized_path.split('/'):
            if segment.lower() in banned:
                raise FileUploadError('INVALID_CONFIG', 500, 'storage_dir contains a banned segment')
        if len(options.signing_key) < 32:
            raise FileUploadError('INVALID_CONFIG', 500, 'signing_key too short')
        if options.is_member is None:
            raise FileUploadError('INVALID_CONFIG', 500, 'is_member is missing')
        if options.max_file_size < 1:
            raise FileUploadError('INVALID_CONFIG', 500, 'max_file_size < 1')
        if not options.allowed_extensions:
            raise FileUploadError('INVALID_CONFIG', 500, 'allowed_extensions is empty')
        for ext in options.allowed_extensions:
            ext_lower = ext.lower()
            if ext_lower not in MAGIC_SIGNATURES and ext_lower not in ('txt', 'csv'):
                raise FileUploadError('INVALID_CONFIG', 500, f'unsupported extension: {ext}')
        self.store = store
        self.options = options

    def _is_hex(self, s: str, n: int) -> bool:
        return len(s) == n and all(c in '0123456789abcdef' for c in s)

    def _is_digits(self, s: str) -> bool:
        return 1 <= len(s) <= 12 and all(c in '0123456789' for c in s)

    def _sanitize(self, name: str) -> str:
        cleaned = ''.join(c for c in name if not (ord(c) <= 0x1F or ord(c) == 0x7F))
        cleaned = cleaned.replace('\\', '/')
        if '/' in cleaned:
            cleaned = cleaned.split('/')[-1]
        return cleaned

    def _ext_of(self, display: str) -> str:
        if '.' not in display:
            return ''
        return display.split('.')[-1].lower()

    def _content_matches(self, ext: str, data: bytes) -> bool:
        ext_lower = ext.lower()
        if ext_lower in ('txt', 'csv'):
            return b'\x00' not in data
        sigs = MAGIC_SIGNATURES.get(ext_lower, [])
        for sig in sigs:
            if len(data) >= len(sig) and data.startswith(sig):
                return True
        return False

    def _sign(self, file_id: str, exp_str: str) -> str:
        msg = f"file_uploads.v1.{file_id}.{exp_str}"
        return hmac.new(self.options.signing_key, msg.encode('ascii'), hashlib.sha256).hexdigest()

    def upload(self, user_id: str, org_id: str, original_filename: str, data: bytes, _declared_content_type: str = "") -> UploadResult:
        if not user_id or not org_id or not self.options.is_member(user_id, org_id):
            raise FileUploadError('FORBIDDEN', 403, 'Forbidden')
        try:
            raw_bytes = original_filename.encode('utf-8')
            if len(raw_bytes) > 255:
                raise FileUploadError('FILENAME_TOO_LONG', 400, 'Filename too long')
        except UnicodeEncodeError:
            raise FileUploadError('INVALID_FILENAME', 400, 'Invalid filename')
        display = self._sanitize(original_filename)
        if display in ("", ".", ".."):
            raise FileUploadError('INVALID_FILENAME', 400, 'Invalid filename')
        ext = self._ext_of(display)
        if ext not in self.options.allowed_extensions:
            raise FileUploadError('EXTENSION_NOT_ALLOWED', 415, 'Extension not allowed')
        if len(data) > self.options.max_file_size:
            raise FileUploadError('FILE_TOO_LARGE', 413, 'File too large')
        if not self._content_matches(ext, data):
            raise FileUploadError('CONTENT_MISMATCH', 415, 'Content mismatch')
        id_bytes = self.options.random_bytes(16)
        if len(id_bytes) != 16:
            raise FileUploadError('STORAGE_ERROR', 500, 'Storage error')
        file_id = id_bytes.hex()
        now = self.options.now()
        sha = hashlib.sha256(data).hexdigest()
        os.makedirs(self.options.storage_dir, exist_ok=True)
        path = os.path.join(self.options.storage_dir, file_id)
        try:
            with open(path, 'xb') as f:
                f.write(data)
        except FileExistsError:
            raise FileUploadError('STORAGE_ERROR', 500, 'Storage error')
        rec = FileRecord(
            id=file_id, org_id=org_id, owner_user_id=user_id, stored_name=file_id,
            original_name=display, extension=ext, mime_type=MIME_TYPES[ext],
            size_bytes=len(data), sha256=sha, created_at=now, deleted_at=None
        )
        try:
            inserted = self.store.insert_file(rec)
        except Exception:
            inserted = False
        if not inserted:
            try:
                os.remove(path)
            except OSError:
                pass
            raise FileUploadError('STORAGE_ERROR', 500, 'Storage error')
        return UploadResult(file_id=file_id)

    def create_download_link(self, user_id: str, file_id: str, ttl_seconds: int = 300) -> DownloadLink:
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or not (1 <= ttl_seconds <= 86400):
            raise FileUploadError('INVALID_TTL', 400, 'Invalid TTL')
        if not self._is_hex(file_id, 32):
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        rec = self.store.find_file(file_id)
        if rec is None or rec.deleted_at is not None:
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        if not self.options.is_member(user_id, rec.org_id):
            raise FileUploadError('FORBIDDEN', 403, 'Forbidden')
        exp = self.options.now() + ttl_seconds
        exp_str = str(exp)
        token = f"{file_id}.{exp_str}.{self._sign(file_id, exp_str)}"
        return DownloadLink(token=token, expires_at=exp)

    def download(self, user_id: str, token: str) -> DownloadResponse:
        if not isinstance(token, str):
            raise FileUploadError('INVALID_LINK', 400, 'Invalid link')
        parts = token.split('.')
        if len(parts) != 3:
            raise FileUploadError('INVALID_LINK', 400, 'Invalid link')
        p0, p1, p2 = parts
        if not self._is_hex(p0, 32) or not self._is_digits(p1) or not self._is_hex(p2, 64):
            raise FileUploadError('INVALID_LINK', 400, 'Invalid link')
        expected_sig = self._sign(p0, p1)
        if not hmac.compare_digest(expected_sig.encode('ascii'), p2.encode('ascii')):
            raise FileUploadError('INVALID_LINK', 400, 'Invalid link')
        exp = int(p1)
        if self.options.now() >= exp:
            raise FileUploadError('LINK_EXPIRED', 410, 'Link expired')
        rec = self.store.find_file(p0)
        if rec is None or rec.deleted_at is not None:
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        if not self.options.is_member(user_id, rec.org_id):
            raise FileUploadError('FORBIDDEN', 403, 'Forbidden')
        if not self._is_hex(rec.stored_name, 32):
            raise FileUploadError('STORAGE_ERROR', 500, 'Storage error')
        path = os.path.join(self.options.storage_dir, rec.stored_name)
        try:
            with open(path, 'rb') as f:
                body = f.read()
        except OSError:
            raise FileUploadError('STORAGE_ERROR', 500, 'Storage error')
        if hashlib.sha256(body).hexdigest() != rec.sha256:
            raise FileUploadError('STORAGE_ERROR', 500, 'Storage error')
        return DownloadResponse(status=200, content_type=rec.mime_type, body=body)

    def delete_file(self, user_id: str, file_id: str) -> None:
        if not self._is_hex(file_id, 32):
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        rec = self.store.find_file(file_id)
        if rec is None or rec.deleted_at is not None:
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        if not self.options.is_member(user_id, rec.org_id):
            raise FileUploadError('FORBIDDEN', 403, 'Forbidden')
        if user_id != rec.owner_user_id:
            raise FileUploadError('FORBIDDEN', 403, 'Forbidden')
        if not self.store.mark_deleted(file_id, self.options.now()):
            raise FileUploadError('NOT_FOUND', 404, 'File not found')

    def get_file(self, user_id: str, file_id: str) -> FileInfo:
        if not self._is_hex(file_id, 32):
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        rec = self.store.find_file(file_id)
        if rec is None or rec.deleted_at is not None:
            raise FileUploadError('NOT_FOUND', 404, 'File not found')
        if not self.options.is_member(user_id, rec.org_id):
            raise FileUploadError('FORBIDDEN', 403, 'Forbidden')
        return FileInfo(
            file_id=rec.id, org_id=rec.org_id, owner_user_id=rec.owner_user_id,
            original_name=rec.original_name, extension=rec.extension,
            mime_type=rec.mime_type, size_bytes=rec.size_bytes,
            sha256=rec.sha256, created_at=rec.created_at
        )