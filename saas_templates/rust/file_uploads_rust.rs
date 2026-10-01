use std::collections::HashMap;
use std::convert::TryInto;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use sha2::{Sha256, Digest};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum FileUploadError {
    #[error("Unauthorized")]
    Unauthorized,
    #[error("File not found")]
    NotFound,
    #[error("Invalid file extension")]
    InvalidExtension,
    #[error("File size exceeds limit")]
    SizeLimitExceeded,
    #[error("Invalid magic bytes")]
    InvalidMagicBytes,
    #[error("Invalid filename")]
    InvalidFilename,
    #[error("Storage error")]
    StorageError(#[from] std::io::Error),
    #[error("Invalid token")]
    InvalidToken,
    #[error("Token expired")]
    TokenExpired,
    #[error("File deleted")]
    FileDeleted,
}

pub trait FileStore: Send + Sync {
    fn insert_file(
        &self,
        org_id: &str,
        owner_user_id: &str,
        stored_name: &str,
        original_name: &str,
        extension: &str,
        mime_type: &str,
        size_bytes: u64,
        sha256: &[u8; 32],
        created_at: u64,
    ) -> Result<String, FileUploadError>;
    fn get_file(&self, file_id: &str) -> Option<FileRecord>;
    fn soft_delete_file(&self, file_id: &str) -> Result<(), FileUploadError>;
    fn is_deleted(&self, file_id: &str) -> bool;
}

#[derive(Clone)]
pub struct FileRecord {
    pub id: String,
    pub org_id: String,
    pub owner_user_id: String,
    pub stored_name: String,
    pub original_name: String,
    pub extension: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: [u8; 32],
    pub created_at: u64,
    pub deleted_at: Option<u64>,
}

pub struct InMemoryFileStore {
    data: Arc<Mutex<HashMap<String, FileRecord>>>,
    next_id: Arc<Mutex<u64>>,
}

impl InMemoryFileStore {
    pub fn new() -> Self {
        Self {
            data: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
        }
    }
}

impl FileStore for InMemoryFileStore {
    fn insert_file(
        &self,
        org_id: &str,
        owner_user_id: &str,
        stored_name: &str,
        original_name: &str,
        extension: &str,
        mime_type: &str,
        size_bytes: u64,
        sha256: &[u8; 32],
        created_at: u64,
    ) -> Result<String, FileUploadError> {
        let mut next_id = self.next_id.lock().unwrap();
        let id = format!("file_{}", *next_id);
        *next_id += 1;
        let record = FileRecord {
            id: id.clone(),
            org_id: org_id.to_string(),
            owner_user_id: owner_user_id.to_string(),
            stored_name: stored_name.to_string(),
            original_name: original_name.to_string(),
            extension: extension.to_string(),
            mime_type: mime_type.to_string(),
            size_bytes,
            sha256: *sha256,
            created_at,
            deleted_at: None,
        };
        self.data.lock().unwrap().insert(id.clone(), record);
        Ok(id)
    }

    fn get_file(&self, file_id: &str) -> Option<FileRecord> {
        self.data.lock().unwrap().get(file_id).cloned()
    }

    fn soft_delete_file(&self, file_id: &str) -> Result<(), FileUploadError> {
        let mut data = self.data.lock().unwrap();
        if let Some(record) = data.get_mut(file_id) {
            record.deleted_at = Some(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs());
            Ok(())
        } else {
            Err(FileUploadError::NotFound)
        }
    }

    fn is_deleted(&self, file_id: &str) -> bool {
        self.data
            .lock()
            .unwrap()
            .get(file_id)
            .map(|r| r.deleted_at.is_some())
            .unwrap_or(true)
    }
}

pub struct SqlFileStore {
    _placeholder: (),
}

impl SqlFileStore {
    pub fn new() -> Self {
        Self { _placeholder: () }
    }
}

impl FileStore for SqlFileStore {
    fn insert_file(
        &self,
        _org_id: &str,
        _owner_user_id: &str,
        _stored_name: &str,
        _original_name: &str,
        _extension: &str,
        _mime_type: &str,
        _size_bytes: u64,
        _sha256: &[u8; 32],
        _created_at: u64,
    ) -> Result<String, FileUploadError> {
        Err(FileUploadError::StorageError(std::io::Error::new(
            std::io::ErrorKind::Other,
            "SQL store not implemented",
        )))
    }

    fn get_file(&self, _file_id: &str) -> Option<FileRecord> {
        None
    }

    fn soft_delete_file(&self, _file_id: &str) -> Result<(), FileUploadError> {
        Err(FileUploadError::StorageError(std::io::Error::new(
            std::io::ErrorKind::Other,
            "SQL store not implemented",
        )))
    }

    fn is_deleted(&self, _file_id: &str) -> bool {
        true
    }
}

pub trait Authorizer: Send + Sync {
    fn is_member(&self, user_id: &str, org_id: &str) -> bool;
}

pub struct AlwaysAuthorizer;

impl Authorizer for AlwaysAuthorizer {
    fn is_member(&self, _user_id: &str, _org_id: &str) -> bool {
        true
    }
}

pub struct NeverAuthorizer;

impl Authorizer for NeverAuthorizer {
    fn is_member(&self, _user_id: &str, _org_id: &str) -> bool {
        false
    }
}

pub struct FileUploads<S: FileStore, A: Authorizer> {
    store: S,
    authorizer: A,
    secret: [u8; 32],
    storage_dir: PathBuf,
    max_size: u64,
    extension_allowlist: HashSet<String>,
}

impl<S: FileStore, A: Authorizer> FileUploads<S, A> {
    pub fn new(
        store: S,
        authorizer: A,
        secret: [u8; 32],
        storage_dir: PathBuf,
        max_size: u64,
        extension_allowlist: HashSet<String>,
    ) -> Self {
        Self {
            store,
            authorizer,
            secret,
            storage_dir,
            max_size,
            extension_allowlist,
        }
    }

    pub fn upload(
        &self,
        user_id: &str,
        org_id: &str,
        original_filename: &str,
        bytes: &[u8],
        declared_content_type: &str,
    ) -> Result<String, FileUploadError> {
        if !self.authorizer.is_member(user_id, org_id) {
            return Err(FileUploadError::Unauthorized);
        }

        if bytes.len() as u64 > self.max_size {
            return Err(FileUploadError::SizeLimitExceeded);
        }

        let extension = Self::get_extension(original_filename)?;
        if !self.extension_allowlist.contains(&extension.to_lowercase()) {
            return Err(FileUploadError::InvalidExtension);
        }

        if !Self::validate_magic_bytes(bytes, &extension) {
            return Err(FileUploadError::InvalidMagicBytes);
        }

        let sanitized_name = Self::sanitize_filename(original_filename)?;
        if sanitized_name.is_empty() {
            return Err(FileUploadError::InvalidFilename);
        }

        let stored_name = Uuid::new_v4().to_string();
        let storage_path = self.storage_dir.join(&stored_name);
        fs::write(&storage_path, bytes)?;

        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let sha256 = hasher.finalize().into();

        let mime_type = Self::get_mime_type(&extension);
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        self.store.insert_file(
            user_id,
            org_id,
            &stored_name,
            &sanitized_name,
            &extension,
            &mime_type,
            bytes.len() as u64,
            &sha256,
            created_at,
        )
    }

    pub fn create_download_link(
        &self,
        user_id: &str,
        org_id: &str,
        file_id: &str,
        ttl_seconds: u64,
    ) -> Result<String, FileUploadError> {
        if !self.authorizer.is_member(user_id, org_id) {
            return Err(FileUploadError::Unauthorized);
        }

        let record = self
            .store
            .get_file(file_id)
            .ok_or(FileUploadError::NotFound)?;
        if self.store.is_deleted(file_id) {
            return Err(FileUploadError::FileDeleted);
        }

        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + ttl_seconds;
        let message = format!("{}:{}", file_id, expires_at);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret)
            .map_err(|_| FileUploadError::StorageError(std::io::Error::new(
                std::io::ErrorKind::Other,
                "HMAC initialization failed",
            )))?;
        mac.update(message.as_bytes());
        let signature = mac.finalize().into_bytes();

        let message_b64 = URL_SAFE_NO_PAD.encode(message.as_bytes());
        let signature_b64 = URL_SAFE_NO_PAD.encode(signature.as_ref());
        Ok(format!("{}.{}", message_b64, signature_b64))
    }

    pub fn download(&self, token: &str) -> Result<Vec<u8>, FileUploadError> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 2 {
            return Err(FileUploadError::InvalidToken);
        }
        let message_b64 = parts[0];
        let signature_b64 = parts[1];

        let message = URL_SAFE_NO_PAD
            .decode(message_b64)
            .map_err(|_| FileUploadError::InvalidToken)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|_| FileUploadError::InvalidToken)?;

        let mut expected_signature = [0u8; 32];
        expected_signature.copy_from_slice(&signature);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret)
            .map_err(|_| FileUploadError::StorageError(std::io::Error::new(
                std::io::ErrorKind::Other,
                "HMAC initialization failed",
            )))?;
        mac.update(&message);
        let result = mac.verify_slice(&expected_signature);
        if result.is_err() {
            return Err(FileUploadError::InvalidToken);
        }

        let message_str = std::str::from_utf8(&message)
            .map_err(|_| FileUploadError::InvalidToken)?;
        let parts: Vec<&str> = message_str.split(':').collect();
        if parts.len() != 2 {
            return Err(FileUploadError::InvalidToken);
        }
        let file_id = parts[0];
        let expires_at: u64 = parts[1]
            .parse()
            .map_err(|_| FileUploadError::InvalidToken)?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        if expires_at < now {
            return Err(FileUploadError::TokenExpired);
        }

        let record = self
            .store
            .get_file(file_id)
            .ok_or(FileUploadError::NotFound)?;
        if self.store.is_deleted(file_id) {
            return Err(FileUploadError::FileDeleted);
        }

        let storage_path = self.storage_dir.join(&record.stored_name);
        let bytes = fs::read(storage_path)?;
        Ok(bytes)
    }

    pub fn delete_file(&self, user_id: &str, org_id: &str, file_id: &str) -> Result<(), FileUploadError> {
        if !self.authorizer.is_member(user_id, org_id) {
            return Err(FileUploadError::Unauthorized);
        }

        let record = self
            .store
            .get_file(file_id)
            .ok_or(FileUploadError::NotFound)?;
        if self.store.is_deleted(file_id) {
            return Err(FileUploadError::FileDeleted);
        }

        self.store.soft_delete_file(file_id)?;
        Ok(())
    }

    fn get_extension(filename: &str) -> Result<String, FileUploadError> {
        let mut cleaned = filename.trim();
        if cleaned.is_empty() {
            return Err(FileUploadError::InvalidFilename);
        }
        if let Some(last_slash) = cleaned.rfind('/') {
            cleaned = &cleaned[last_slash + 1..];
        }
        if let Some(last_backslash) = cleaned.rfind('\\') {
            cleaned = &cleaned[last_backslash + 1..];
        }
        if cleaned.starts_with('.') {
            return Err(FileUploadError::InvalidFilename);
        }
        let parts: Vec<&str> = cleaned.split('.').collect();
        if parts.len() < 2 {
            return Err(FileUploadError::InvalidExtension);
        }
        let extension = parts.last().unwrap().to_lowercase();
        Ok(extension)
    }

    fn sanitize_filename(filename: &str) -> Result<String, FileUploadError> {
        let mut cleaned = filename.to_string();
        cleaned = cleaned.replace('/', "_");
        cleaned = cleaned.replace('\\', "_");
        cleaned = cleaned
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        if cleaned.len() > 255 {
            cleaned.truncate(255);
        }
        if cleaned.is_empty() {
            return Err(FileUploadError::InvalidFilename);
        }
        Ok(cleaned)
    }

    fn validate_magic_bytes(bytes: &[u8], extension: &str) -> bool {
        let ext = extension.to_lowercase();
        match ext.as_str() {
            "png" => bytes.len() >= 4 && &bytes[0..4] == [0x89, 0x50, 0x4E, 0x47],
            "jpg" | "jpeg" => bytes.len() >= 3 && &bytes[0..3] == [0xFF, 0xD8, 0xFF],
            "gif" => bytes.len() >= 4 && &bytes[0..4] == [0x47, 0x49, 0x46, 0x38],
            "pdf" => bytes.len() >= 4 && &bytes[0..4] == [0x25, 0x50, 0x44, 0x46],
            "docx" | "xlsx" => bytes.len() >= 4 && &bytes[0..4] == [0x50, 0x4B, 0x03, 0x04],
            "txt" | "csv" => !bytes.iter().any(|&b| b == 0x00),
            _ => false,
        }
    }

    fn get_mime_type(extension: &str) -> String {
        match extension.to_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "pdf" => "application/pdf",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "txt" => "text/plain",
            "csv" => "text/csv",
            _ => "application/octet-stream",
        }
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::Duration;

    fn setup_test_dir() -> PathBuf {
        let dir = env::temp_dir().join("file_uploads_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_exe_rejected_by_magic_bytes() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [0u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("png".to_string());
        let uploader = FileUploads::new(
            store,
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let exe_bytes = b"MZ\x90\x00"; // DOS header
        let res = uploader.upload(
            "user1",
            "org1",
            "malicious.png",
            exe_bytes,
            "image/png",
        );
        assert_eq!(res.err().unwrap(), FileUploadError::InvalidMagicBytes);
    }

    #[test]
    fn test_png_accepted_and_stored_under_generated_name() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [1u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("png".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let png_bytes = [
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
            0x49, 0x48, 0x44, 0x52, // "IHDR"
            0x00, 0x00, 0x00, 0x01, // width: 1
            0x00, 0x00, 0x00, 0x01, // height: 1
            0x08, 0x02, 0x00, 0x00, 0x00, // bit depth, color type, compression, filter, interlace
            0x90, 0x77, 0x53, 0xDE, // CRC
        ];
        let file_id = uploader
            .upload("user1", "org1", "image.png", &png_bytes, "image/png")
            .unwrap();
        assert_ne!(file_id, "image.png");

        let record = store.get_file(&file_id).unwrap();
        assert_eq!(record.original_name, "image.png");
        assert_eq!(record.extension, "png");
        assert_eq!(record.mime_type, "image/png");
        assert_eq!(record.size_bytes, png_bytes.len() as u64);
        assert!(!record.stored_name.is_empty());
        assert_eq!(record.deleted_at, None);

        let storage_path = storage_dir.join(&record.stored_name);
        assert!(storage_path.exists());
        let stored_bytes = fs::read(storage_path).unwrap();
        assert_eq!(stored_bytes, png_bytes);
    }

    #[test]
    fn test_path_traversal_sanitized() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [2u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("png".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let png_bytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let file_id = uploader
            .upload(
                "user1",
                "org1",
                "../../etc/passwd.png",
                &png_bytes,
                "image/png",
            )
            .unwrap();

        let record = store.get_file(&file_id).unwrap();
        assert_eq!(record.original_name, "etc_passwd.png");
    }

    #[test]
    fn test_file_over_size_limit_rejected() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [3u8; 32];
        let max_size = 10; // 10 bytes
        let mut allowlist = HashSet::new();
        allowlist.insert("txt".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let bytes = b"0123456789A"; // 11 bytes
        let res = uploader.upload(
            "user1",
            "org1",
            "big.txt",
            bytes,
            "text/plain",
        );
        assert_eq!(res.err().unwrap(), FileUploadError::SizeLimitExceeded);
    }

    #[test]
    fn test_non_member_cannot_upload_or_download() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = NeverAuthorizer;
        let secret = [4u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("txt".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let txt_bytes = b"hello";
        let res = uploader.upload(
            "user1",
            "org1",
            "test.txt",
            txt_bytes,
            "text/plain",
        );
        assert_eq!(res.err().unwrap(), FileUploadError::Unauthorized);

        // First upload as member to have a file
        let store2 = InMemoryFileStore::new();
        let authorizer2 = AlwaysAuthorizer;
        let uploader2 = FileUploads::new(
            store2.clone(),
            authorizer2,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );
        let file_id = uploader2
            .upload("user1", "org1", "test.txt", txt_bytes, "text/plain")
            .unwrap();

        // Try to download as non-member
        let token = uploader2
            .create_download_link("user1", "org1", &file_id, 300)
            .unwrap();
        let res = uploader.download(&token);
        assert_eq!(res.err().unwrap(), FileUploadError::Unauthorized);
    }

    #[test]
    fn test_expired_link_rejected() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [5u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("txt".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let txt_bytes = b"hello";
        let file_id = uploader
            .upload("user1", "org1", "test.txt", txt_bytes, "text/plain")
            .unwrap();

        // Create link with 1 second TTL
        let token = uploader
            .create_download_link("user1", "org1", &file_id, 1)
            .unwrap();
        std::thread::sleep(Duration::from_secs(2));
        let res = uploader.download(&token);
        assert_eq!(res.err().unwrap(), FileUploadError::TokenExpired);
    }

    #[test]
    fn test_link_with_changed_character_rejected() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [6u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("txt".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let txt_bytes = b"hello";
        let file_id = uploader
            .upload("user1", "org1", "test.txt", txt_bytes, "text/plain")
            .unwrap();

        let token = uploader
            .create_download_link("user1", "org1", &file_id, 300)
            .unwrap();
        let mut token_bytes = token.into_bytes();
        token_bytes[0] = if token_bytes[0] == 0 { 1 } else { token_bytes[0] - 1 };
        let corrupted_token = String::from_utf8(token_bytes).unwrap();
        let res = uploader.download(&corrupted_token);
        assert_eq!(res.err().unwrap(), FileUploadError::InvalidToken);
    }

    #[test]
    fn test_after_delete_file_can_no_longer_be_linked_or_downloaded() {
        let storage_dir = setup_test_dir();
        let store = InMemoryFileStore::new();
        let authorizer = AlwaysAuthorizer;
        let secret = [7u8; 32];
        let max_size = 10 * 1024 * 1024;
        let mut allowlist = HashSet::new();
        allowlist.insert("txt".to_string());
        let uploader = FileUploads::new(
            store.clone(),
            authorizer,
            secret,
            storage_dir.clone(),
            max_size,
            allowlist,
        );

        let txt_bytes = b"hello";
        let file_id = uploader
            .upload("user1", "org1", "test.txt", txt_bytes, "text/plain")
            .unwrap();

        // Delete the file
        uploader.delete_file("user1", "org1", &file_id).unwrap();

        // Try to create a download link
        let res = uploader.create_download_link("user1", "org1", &file_id, 300);
        assert_eq!(res.err().unwrap(), FileUploadError::FileDeleted);

        // Try to download using a pre-delete link (if we had one)
        // First, create a link before deletion
        let token = uploader
            .create_download_link("user1", "org1", &file_id, 300)
            .unwrap();
        // Now delete
        uploader.delete_file("user1", "org1", &file_id).unwrap();
        // Try to download
        let res = uploader.download(&token);
        assert_eq!(res.err().unwrap(), FileUploadError::FileDeleted);
    }
}