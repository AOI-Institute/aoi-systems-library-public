import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

public final class IdempotencyKeys {
    private IdempotencyKeys() {}

    public interface Store {
        boolean tryClaim(IdempotencyRecord record, long now);
        IdempotencyRecord get(String scope, String idemKey);
        void complete(String scope, String idemKey, long createdAt, int responseStatus, String responseBody);
        void delete(String scope, String idemKey, long createdAt);
        int purgeExpired(long now);
    }

    public static final class InMemoryStore implements Store {
        private final Map<Key, IdempotencyRecord> rows = new HashMap<>();

        private record Key(String scope, String idemKey) {}

        @Override
        public synchronized boolean tryClaim(IdempotencyRecord record, long now) {
            Key key = new Key(record.scope(), record.idemKey());
            IdempotencyRecord existing = rows.get(key);
            if (existing == null || existing.expiresAt() <= now) {
                rows.put(key, record);
                return true;
            }
            return false;
        }

        @Override
        public synchronized IdempotencyRecord get(String scope, String idemKey) {
            return rows.get(new Key(scope, idemKey));
        }

        @Override
        public synchronized void complete(String scope, String idemKey, long createdAt, int responseStatus, String responseBody) {
            Key key = new Key(scope, idemKey);
            IdempotencyRecord existing = rows.get(key);
            if (existing != null && "in_progress".equals(existing.status()) && existing.createdAt() == createdAt) {
                rows.put(key, new IdempotencyRecord(
                    scope, idemKey, existing.requestFingerprint(), "completed",
                    responseStatus, responseBody, createdAt, existing.expiresAt()
                ));
            }
        }

        @Override
        public synchronized void delete(String scope, String idemKey, long createdAt) {
            Key key = new Key(scope, idemKey);
            IdempotencyRecord existing = rows.get(key);
            if (existing != null && "in_progress".equals(existing.status()) && existing.createdAt() == createdAt) {
                rows.remove(key);
            }
        }

        @Override
        public synchronized int purgeExpired(long now) {
            int count = 0;
            Iterator<Map.Entry<Key, IdempotencyRecord>> it = rows.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<Key, IdempotencyRecord> entry = it.next();
                if (entry.getValue().expiresAt() <= now) {
                    it.remove();
                    count++;
                }
            }
            return count;
        }
    }

    public static final class SqlStore implements Store {
        private final Connection conn;

        public SqlStore(Connection conn) {
            this.conn = conn;
        }

        public void migrate() {
            try (Statement stmt = conn.createStatement()) {
                stmt.execute("CREATE TABLE IF NOT EXISTS idempotency_records (scope TEXT NOT NULL, idem_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')), response_status INTEGER NULL, response_body TEXT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, PRIMARY KEY (scope, idem_key))");
                stmt.execute("CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records (expires_at)");
            } catch (SQLException e) {
                throw new IdempotencyError("STORE_ERROR", 500, e.getMessage());
            }
        }

        @Override
        public synchronized boolean tryClaim(IdempotencyRecord record, long now) {
            String sql = "INSERT INTO idempotency_records (scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at) VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?) ON CONFLICT (scope, idem_key) DO UPDATE SET request_fingerprint = excluded.request_fingerprint, status = 'in_progress', response_status = NULL, response_body = NULL, created_at = excluded.created_at, expires_at = excluded.expires_at WHERE idempotency_records.expires_at <= ?";
            try (PreparedStatement pstmt = conn.prepareStatement(sql)) {
                pstmt.setString(1, record.scope());
                pstmt.setString(2, record.idemKey());
                pstmt.setString(3, record.requestFingerprint());
                pstmt.setLong(4, record.createdAt());
                pstmt.setLong(5, record.expiresAt());
                pstmt.setLong(6, now);
                int affected = pstmt.executeUpdate();
                return affected == 1;
            } catch (SQLException e) {
                throw new IdempotencyError("STORE_ERROR", 500, e.getMessage());
            }
        }

        @Override
        public synchronized IdempotencyRecord get(String scope, String idemKey) {
            String sql = "SELECT scope, idem_key, request_fingerprint, status, response_status, response_body, created_at, expires_at FROM idempotency_records WHERE scope = ? AND idem_key = ?";
            try (PreparedStatement pstmt = conn.prepareStatement(sql)) {
                pstmt.setString(1, scope);
                pstmt.setString(2, idemKey);
                try (ResultSet rs = pstmt.executeQuery()) {
                    if (rs.next()) {
                        String rScope = rs.getString(1);
                        String rIdemKey = rs.getString(2);
                        String rFp = rs.getString(3);
                        String rStatus = rs.getString(4);
                        int rRespStatusVal = rs.getInt(5);
                        Integer rRespStatus = rs.wasNull() ? null : rRespStatusVal;
                        String rRespBody = rs.getString(6);
                        long rCreatedAt = rs.getLong(7);
                        long rExpiresAt = rs.getLong(8);
                        return new IdempotencyRecord(rScope, rIdemKey, rFp, rStatus, rRespStatus, rRespBody, rCreatedAt, rExpiresAt);
                    }
                    return null;
                }
            } catch (SQLException e) {
                throw new IdempotencyError("STORE_ERROR", 500, e.getMessage());
            }
        }

        @Override
        public synchronized void complete(String scope, String idemKey, long createdAt, int responseStatus, String responseBody) {
            String sql = "UPDATE idempotency_records SET status = 'completed', response_status = ?, response_body = ? WHERE scope = ? AND idem_key = ? AND created_at = ? AND status = 'in_progress'";
            try (PreparedStatement pstmt = conn.prepareStatement(sql)) {
                pstmt.setInt(1, responseStatus);
                pstmt.setString(2, responseBody);
                pstmt.setString(3, scope);
                pstmt.setString(4, idemKey);
                pstmt.setLong(5, createdAt);
                pstmt.executeUpdate();
            } catch (SQLException e) {
                throw new IdempotencyError("STORE_ERROR", 500, e.getMessage());
            }
        }

        @Override
        public synchronized void delete(String scope, String idemKey, long createdAt) {
            String sql = "DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ? AND created_at = ? AND status = 'in_progress'";
            try (PreparedStatement pstmt = conn.prepareStatement(sql)) {
                pstmt.setString(1, scope);
                pstmt.setString(2, idemKey);
                pstmt.setLong(3, createdAt);
                pstmt.executeUpdate();
            } catch (SQLException e) {
                throw new IdempotencyError("STORE_ERROR", 500, e.getMessage());
            }
        }

        @Override
        public synchronized int purgeExpired(long now) {
            String sql = "DELETE FROM idempotency_records WHERE expires_at <= ?";
            try (PreparedStatement pstmt = conn.prepareStatement(sql)) {
                pstmt.setLong(1, now);
                return pstmt.executeUpdate();
            } catch (SQLException e) {
                throw new IdempotencyError("STORE_ERROR", 500, e.getMessage());
            }
        }
    }

    public record IdempotencyRecord(
        String scope,
        String idemKey,
        String requestFingerprint,
        String status,
        Integer responseStatus,
        String responseBody,
        long createdAt,
        long expiresAt
    ) {}

    public record HttpResponse(int status, String contentType, String body) {}

    public record OperationResult(int status, String body) {}

    public static final class IdempotencyError extends RuntimeException {
        public final String code;
        public final int status;

        public IdempotencyError(String code, int status, String message) {
            super(message);
            this.code = code;
            this.status = status;
        }
    }

    public static final class IdempotencyOptions {
        public LongSupplier clock = null;
        public long ttlSeconds = 86400;
        public Set<String> requiredMethods = Set.of("POST", "PATCH");
    }

    public static final class IdempotencyService {
        private final Store store;
        private final LongSupplier clock;
        private final long ttlSeconds;
        private final Set<String> requiredMethods;

        private static final String PROBLEM_KEY_MISSING = "{\"type\":\"https://developer.example.com/problems/idempotency-key-missing\",\"title\":\"Idempotency-Key is missing\",\"detail\":\"This operation requires an Idempotency-Key request header.\"}";
        private static final String PROBLEM_KEY_INVALID = "{\"type\":\"https://developer.example.com/problems/idempotency-key-invalid\",\"title\":\"Idempotency-Key is invalid\",\"detail\":\"An Idempotency-Key must be 1 to 255 printable ASCII characters.\"}";
        private static final String PROBLEM_KEY_REUSED = "{\"type\":\"https://developer.example.com/problems/idempotency-key-reused\",\"title\":\"Idempotency-Key is already used\",\"detail\":\"This Idempotency-Key was already used with a different request payload.\"}";
        private static final String PROBLEM_REQUEST_IN_PROGRESS = "{\"type\":\"https://developer.example.com/problems/idempotency-request-outstanding\",\"title\":\"A request is outstanding for this Idempotency-Key\",\"detail\":\"A request with the same Idempotency-Key is still being processed. Retry later.\"}";

        public IdempotencyService(Store store, IdempotencyOptions options) {
            if (store == null) {
                throw new IllegalArgumentException("Store cannot be null");
            }
            this.store = store;
            IdempotencyOptions opts = options != null ? options : new IdempotencyOptions();
            if (opts.ttlSeconds < 1) {
                throw new IdempotencyError("INVALID_OPTIONS", 500, "ttl_seconds must be >= 1");
            }
            this.ttlSeconds = opts.ttlSeconds;
            this.clock = opts.clock != null ? opts.clock : () -> java.time.Instant.now().getEpochSecond();
            
            Set<String> methods = new HashSet<>();
            if (opts.requiredMethods != null) {
                for (String m : opts.requiredMethods) {
                    methods.add(asciiUpper(m));
                }
            }
            this.requiredMethods = Collections.unmodifiableSet(methods);
        }

        public HttpResponse handle(String scope, String idempotencyKey, String method, String path, String body, Supplier<OperationResult> operation) {
            String m = asciiUpper(method != null ? method : "");
            String p = path != null ? path : "";
            String b = body != null ? body : "";

            if (!requiredMethods.contains(m)) {
                OperationResult r = operation.get();
                checkResult(r);
                return new HttpResponse(r.status(), "application/json", r.body());
            }

            if (scope == null || scope.isEmpty()) {
                throw new IdempotencyError("SCOPE_REQUIRED", 500, "scope is required");
            }

            if (idempotencyKey == null || idempotencyKey.isEmpty()) {
                return new HttpResponse(400, "application/problem+json", PROBLEM_KEY_MISSING);
            }

            if (!validKey(idempotencyKey)) {
                return new HttpResponse(400, "application/problem+json", PROBLEM_KEY_INVALID);
            }

            String fp = computeFingerprint(m, p, b);
            long now = clock.getAsLong();

            IdempotencyRecord rec = new IdempotencyRecord(
                scope, idempotencyKey, fp, "in_progress", null, null, now, now + ttlSeconds
            );

            for (int attempt = 0; attempt < 2; attempt++) {
                if (store.tryClaim(rec, now)) {
                    return runClaimed(rec, operation);
                }
                IdempotencyRecord ex = store.get(scope, idempotencyKey);
                if (ex == null || ex.expiresAt() <= now) {
                    continue;
                }
                if (!ex.requestFingerprint().equals(fp)) {
                    return new HttpResponse(422, "application/problem+json", PROBLEM_KEY_REUSED);
                }
                if ("in_progress".equals(ex.status())) {
                    return new HttpResponse(409, "application/problem+json", PROBLEM_REQUEST_IN_PROGRESS);
                }
                return new HttpResponse(ex.responseStatus(), "application/json", ex.responseBody());
            }

            return new HttpResponse(409, "application/problem+json", PROBLEM_REQUEST_IN_PROGRESS);
        }

        private HttpResponse runClaimed(IdempotencyRecord rec, Supplier<OperationResult> operation) {
            OperationResult r;
            try {
                r = operation.get();
            } catch (Throwable t) {
                try {
                    store.delete(rec.scope(), rec.idemKey(), rec.createdAt());
                } catch (Throwable ignored) {}
                throw t;
            }

            checkResult(r);
            store.complete(rec.scope(), rec.idemKey(), rec.createdAt(), r.status(), r.body());
            return new HttpResponse(r.status(), "application/json", r.body());
        }

        public boolean isRequired(String method, String path) {
            return requiredMethods.contains(asciiUpper(method));
        }

        public int purgeExpired() {
            return store.purgeExpired(clock.getAsLong());
        }

        private static boolean validKey(String k) {
            if (k == null || k.isEmpty() || k.length() > 255) {
                return false;
            }
            for (int i = 0; i < k.length(); i++) {
                char c = k.charAt(i);
                if (c < 0x20 || c > 0x7E) {
                    return false;
                }
            }
            return true;
        }

        private static void checkResult(OperationResult r) {
            if (r == null || r.body() == null || r.status() < 100 || r.status() > 599) {
                throw new IdempotencyError("INVALID_OPERATION_RESULT", 500, "Invalid operation result");
            }
        }
    }

    public static String asciiUpper(String s) {
        if (s == null) return "";
        char[] chars = s.toCharArray();
        for (int i = 0; i < chars.length; i++) {
            if (chars[i] >= 'a' && chars[i] <= 'z') {
                chars[i] = (char) (chars[i] - 32);
            }
        }
        return new String(chars);
    }

    public static String computeFingerprint(String method, String path, String body) {
        String m = asciiUpper(method != null ? method : "");
        String p = path != null ? path : "";
        String b = body != null ? body : "";
        String input = m + " " + p + "\n" + b;
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(hash);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}