package fileuploads

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidExtension     = errors.New("invalid file extension")
	ErrInvalidMagicBytes    = errors.New("file content does not match extension")
	ErrFileTooLarge         = errors.New("file exceeds size limit")
	ErrUnauthorized         = errors.New("user not authorized for organization")
	ErrFileNotFound         = errors.New("file not found")
	ErrFileDeleted          = errors.New("file has been deleted")
	ErrInvalidToken         = errors.New("invalid download link")
	ErrTokenExpired         = errors.New("download link has expired")
	ErrInvalidFilename      = errors.New("invalid filename")
	ErrStorageError         = errors.New("storage error")
)

type Config struct {
	StorageDir        string
	MaxFileSize       int64
	AllowedExtensions map[string]bool
	HMACKey           []byte
	DefaultLinkTTL    int
}

func DefaultConfig(storageDir string, hmacKey []byte) Config {
	return Config{
		StorageDir:     storageDir,
		MaxFileSize:    10 * 1024 * 1024,
		AllowedExtensions: map[string]bool{
			"pdf": true, "png": true, "jpg": true, "jpeg": true,
			"gif": true, "txt": true, "csv": true, "docx": true, "xlsx": true,
		},
		HMACKey:        hmacKey,
		DefaultLinkTTL: 300,
	}
}

type FileRecord struct {
	ID            string
	OrgID         string
	OwnerUserID   string
	StoredName    string
	OriginalName  string
	Extension     string
	MimeType      string
	SizeBytes     int64
	SHA256        string
	CreatedAt     time.Time
	DeletedAt     *time.Time
}

type Store interface {
	CreateFile(record *FileRecord) error
	GetFileByID(id string) (*FileRecord, error)
	GetFileByIDAndOrg(id, orgID string) (*FileRecord, error)
	SoftDeleteFile(id, userID string) error
	IsUserMemberOfOrg(userID, orgID string) (bool, error)
	AddOrgMember(orgID, userID string) error
}

type InMemoryStore struct {
	mu          sync.RWMutex
	files       map[string]*FileRecord
	orgMembers  map[string]map[string]bool
}

func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{
		files:      make(map[string]*FileRecord),
		orgMembers: make(map[string]map[string]bool),
	}
}

func (s *InMemoryStore) CreateFile(record *FileRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[record.ID] = record
	return nil
}

func (s *InMemoryStore) GetFileByID(id string) (*FileRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.files[id]
	if !ok {
		return nil, ErrFileNotFound
	}
	return f, nil
}

func (s *InMemoryStore) GetFileByIDAndOrg(id, orgID string) (*FileRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.files[id]
	if !ok {
		return nil, ErrFileNotFound
	}
	if f.OrgID != orgID {
		return nil, ErrFileNotFound
	}
	return f, nil
}

func (s *InMemoryStore) SoftDeleteFile(id, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.files[id]
	if !ok {
		return ErrFileNotFound
	}
	if f.OwnerUserID != userID {
		return ErrUnauthorized
	}
	now := time.Now()
	f.DeletedAt = &now
	return nil
}

func (s *InMemoryStore) IsUserMemberOfOrg(userID, orgID string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	members, ok := s.orgMembers[orgID]
	if !ok {
		return false, nil
	}
	return members[userID], nil
}

func (s *InMemoryStore) AddOrgMember(orgID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.orgMembers[orgID] == nil {
		s.orgMembers[orgID] = make(map[string]bool)
	}
	s.orgMembers[orgID][userID] = true
	return nil
}

var schemaSQL = `
CREATE TABLE IF NOT EXISTS files (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	stored_name TEXT NOT NULL,
	original_name TEXT NOT NULL,
	extension TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	created_at TEXT NOT NULL,
	deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS org_members (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id)
);
`

type SQLStore struct {
	db *sql.DB
}

func NewSQLStore(db *sql.DB) (*SQLStore, error) {
	if _, err := db.Exec(schemaSQL); err != nil {
		return nil, err
	}
	return &SQLStore{db: db}, nil
}

func (s *SQLStore) CreateFile(record *FileRecord) error {
	_, err := s.db.Exec(
		`INSERT INTO files (id, org_id, owner_user_id, stored_name, original_name, extension, mime_type, size_bytes, sha256, created_at, deleted_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.ID, record.OrgID, record.OwnerUserID, record.StoredName, record.OriginalName,
		record.Extension, record.MimeType, record.SizeBytes, record.SHA256,
		record.CreatedAt.Format(time.RFC3339), nilTime(record.DeletedAt),
	)
	return err
}

func (s *SQLStore) GetFileByID(id string) (*FileRecord, error) {
	return s.queryFile(`SELECT id, org_id, owner_user_id, stored_name, original_name, extension, mime_type, size_bytes, sha256, created_at, deleted_at FROM files WHERE id = ?`, id)
}

func (s *SQLStore) GetFileByIDAndOrg(id, orgID string) (*FileRecord, error) {
	return s.queryFile(`SELECT id, org_id, owner_user_id, stored_name, original_name, extension, mime_type, size_bytes, sha256, created_at, deleted_at FROM files WHERE id = ? AND org_id = ?`, id, orgID)
}

func (s *SQLStore) queryFile(query string, args ...interface{}) (*FileRecord, error) {
	row := s.db.QueryRow(query, args...)
	var f FileRecord
	var deletedAt sql.NullString
	var createdAtStr string
	err := row.Scan(&f.ID, &f.OrgID, &f.OwnerUserID, &f.StoredName, &f.OriginalName,
		&f.Extension, &f.MimeType, &f.SizeBytes, &f.SHA256, &createdAtStr, &deletedAt)
	if err == sql.ErrNoRows {
		return nil, ErrFileNotFound
	}
	if err != nil {
		return nil, err
	}
	f.CreatedAt, _ = time.Parse(time.RFC3339, createdAtStr)
	if deletedAt.Valid {
		t, _ := time.Parse(time.RFC3339, deletedAt.String)
		f.DeletedAt = &t
	}
	return &f, nil
}

func (s *SQLStore) SoftDeleteFile(id, userID string) error {
	res, err := s.db.Exec(`UPDATE files SET deleted_at = ? WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
		time.Now().Format(time.RFC3339), id, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrFileNotFound
	}
	return nil
}

func (s *SQLStore) IsUserMemberOfOrg(userID, orgID string) (bool, error) {
	var exists int
	err := s.db.QueryRow(`SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?`, orgID, userID).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (s *SQLStore) AddOrgMember(orgID, userID string) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO org_members (org_id, user_id) VALUES (?, ?)`, orgID, userID)
	return err
}

func nilTime(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return t.Format(time.RFC3339)
}

type FileUploads struct {
	config Config
	store  Store
}

func NewFileUploads(config Config, store Store) *FileUploads {
	return &FileUploads{config: config, store: store}
}

func (fu *FileUploads) Upload(userID, orgID, originalFilename string, data []byte, declaredContentType string) (string, error) {
	isMember, err := fu.store.IsUserMemberOfOrg(userID, orgID)
	if err != nil {
		return "", err
	}
	if !isMember {
		return "", ErrUnauthorized
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(originalFilename), "."))
	if ext == "" || !fu.config.AllowedExtensions[ext] {
		return "", ErrInvalidExtension
	}

	if int64(len(data)) > fu.config.MaxFileSize {
		return "", ErrFileTooLarge
	}

	if err := validateMagicBytes(ext, data); err != nil {
		return "", err
	}

	sanitizedOriginal := sanitizeFilename(originalFilename)
	storedName := generateStoredName(ext)
	sha256Hash := sha256.Sum256(data)

	storagePath := filepath.Join(fu.config.StorageDir, storedName)
	if err := os.WriteFile(storagePath, data, 0600); err != nil {
		return "", ErrStorageError
	}

	record := &FileRecord{
		ID:           generateID(),
		OrgID:        orgID,
		OwnerUserID:  userID,
		StoredName:   storedName,
		OriginalName: sanitizedOriginal,
		Extension:    ext,
		MimeType:     declaredContentType,
		SizeBytes:    int64(len(data)),
		SHA256:       hex.EncodeToString(sha256Hash[:]),
		CreatedAt:    time.Now(),
	}

	if err := fu.store.CreateFile(record); err != nil {
		os.Remove(storagePath)
		return "", err
	}

	return record.ID, nil
}

func (fu *FileUploads) CreateDownloadLink(userID, fileID string, ttlSeconds int) (string, error) {
	if ttlSeconds <= 0 {
		ttlSeconds = fu.config.DefaultLinkTTL
	}

	file, err := fu.store.GetFileByID(fileID)
	if err != nil {
		return "", err
	}
	if file.DeletedAt != nil {
		return "", ErrFileNotFound
	}

	isMember, err := fu.store.IsUserMemberOfOrg(userID, file.OrgID)
	if err != nil {
		return "", err
	}
	if !isMember {
		return "", ErrUnauthorized
	}

	expiresAt := time.Now().Add(time.Duration(ttlSeconds) * time.Second).Unix()
	expiresAtStr := strconv.FormatInt(expiresAt, 10)
	payload := fileID + "." + expiresAtStr
	sig := hmac.New(sha256.New, fu.config.HMACKey)
	sig.Write([]byte(payload))
	signature := sig.Sum(nil)

	token := base64.RawURLEncoding.EncodeToString([]byte(payload + "." + base64.RawURLEncoding.EncodeToString(signature)))
	return token, nil
}

func (fu *FileUploads) Download(token string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, ErrInvalidToken
	}

	parts := strings.Split(string(decoded), ".")
	if len(parts) != 3 {
		return nil, ErrInvalidToken
	}

	fileID := parts[0]
	expiresAtStr := parts[1]
	sigProvided, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, ErrInvalidToken
	}

	expiresAt, err := parseInt64(expiresAtStr)
	if err != nil {
		return nil, ErrInvalidToken
	}

	if time.Now().Unix() > expiresAt {
		return nil, ErrTokenExpired
	}

	payload := fileID + "." + expiresAtStr
	sigExpected := hmac.New(sha256.New, fu.config.HMACKey)
	sigExpected.Write([]byte(payload))
	expected := sigExpected.Sum(nil)

	if !hmac.Equal(sigProvided, expected) {
		return nil, ErrInvalidToken
	}

	file, err := fu.store.GetFileByID(fileID)
	if err != nil {
		return nil, err
	}
	if file.DeletedAt != nil {
		return nil, ErrFileNotFound
	}

	storagePath := filepath.Join(fu.config.StorageDir, file.StoredName)
	data, err := os.ReadFile(storagePath)
	if err != nil {
		return nil, ErrStorageError
	}

	return data, nil
}

func (fu *FileUploads) DeleteFile(userID, fileID string) error {
	file, err := fu.store.GetFileByID(fileID)
	if err != nil {
		return err
	}
	if file.OwnerUserID != userID {
		return ErrUnauthorized
	}
	if file.DeletedAt != nil {
		return ErrFileNotFound
	}

	if err := fu.store.SoftDeleteFile(fileID, userID); err != nil {
		return err
	}

	storagePath := filepath.Join(fu.config.StorageDir, file.StoredName)
	os.Remove(storagePath)
	return nil
}

func validateMagicBytes(ext string, data []byte) error {
	if len(data) < 4 {
		return ErrInvalidMagicBytes
	}

	switch ext {
	case "png":
		if !bytesEqual(data[:4], []byte{0x89, 0x50, 0x4E, 0x47}) {
			return ErrInvalidMagicBytes
		}
	case "jpg", "jpeg":
		if !bytesEqual(data[:3], []byte{0xFF, 0xD8, 0xFF}) {
			return ErrInvalidMagicBytes
		}
	case "gif":
		if !bytesEqual(data[:4], []byte{0x47, 0x49, 0x46, 0x38}) {
			return ErrInvalidMagicBytes
		}
	case "pdf":
		if !bytesEqual(data[:4], []byte{0x25, 0x50, 0x44, 0x46}) {
			return ErrInvalidMagicBytes
		}
	case "docx", "xlsx":
		if !bytesEqual(data[:4], []byte{0x50, 0x4B, 0x03, 0x04}) {
			return ErrInvalidMagicBytes
		}
	case "txt", "csv":
		for _, b := range data {
			if b == 0x00 {
				return ErrInvalidMagicBytes
			}
		}
	}
	return nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sanitizeFilename(name string) string {
	name = filepath.Base(name)
	name = strings.ReplaceAll(name, "..", "")
	var b strings.Builder
	for _, r := range name {
		if r >= 32 && r != 127 {
			b.WriteRune(r)
		}
	}
	result := b.String()
	if len(result) > 255 {
		result = result[:255]
	}
	if result == "" {
		result = "unnamed"
	}
	return result
}

func generateStoredName(ext string) string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b) + "." + ext
}

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func parseInt64(s string) (int64, error) {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		n = n*10 + int64(c-'0')
	}
	return n, nil
}