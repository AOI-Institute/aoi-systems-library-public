import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class QuotaManager {
    private static final String DB_URL = "jdbc:h2:mem:test;DB_CLOSE_DELAY=-1";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final Connection conn;
    private final Clock clock;

    public QuotaManager() throws SQLException {
        this(Clock.systemUTC());
    }

    public QuotaManager(Clock clock) throws SQLException {
        this.clock = clock;
        this.conn = DriverManager.getConnection(DB_URL);
        initSchema();
    }

    private void initSchema() throws SQLException {
        try (Statement stmt = conn.createStatement()) {
            stmt.execute("CREATE TABLE IF NOT EXISTS usage_metrics (" +
                    "user_id VARCHAR(255), month VARCHAR(7), call_count INT, storage_bytes BIGINT, updated_at TIMESTAMP)");
            stmt.execute("CREATE TABLE IF NOT EXISTS api_calls (" +
                    "id IDENTITY PRIMARY KEY, user_id VARCHAR(255), ip VARCHAR(45), endpoint VARCHAR(255), " +
                    "timestamp TIMESTAMP, status_code INT, response_time_ms INT)");
            stmt.execute("CREATE TABLE IF NOT EXISTS user_files (" +
                    "id IDENTITY PRIMARY KEY, user_id VARCHAR(255), file_size BIGINT, uploaded_at TIMESTAMP)");
        }
    }

    public Response handleApiCall(User user, String endpoint, String ip, byte[] incomingFile, String feature) throws SQLException {
        // Rate limit per IP
        if (rateLimitPerIp(ip)) {
            return errorResponse(429, "ip_rate_limit_exceeded", Map.of("reset_seconds", 1));
        }

        // Rate limit per user
        if (rateLimitPerUser(user.getId())) {
            return errorResponse(429, "rate_limit_exceeded", Map.of("reset_seconds", 60));
        }

        // Feature gate
        if (!featureGate(user, feature)) {
            return errorResponse(403, "feature_not_available", Map.of(
                    "tier", user.getTier().name().toLowerCase(),
                    "minimum_tier", "team"
            ));
        }

        // API quota
        if (!apiQuotaCheck(user)) {
            return errorResponse(429, "quota_exceeded", Map.of(
                    "current", getCurrentApiUsage(user),
                    "limit", getApiLimit(user),
                    "reset_date", getResetDate()
            ));
        }

        // Storage quota if file upload
        if (incomingFile != null) {
            if (!storageQuotaCheck(user, incomingFile.length)) {
                return errorResponse(413, "storage_quota_exceeded", Map.of(
                        "usage", getCurrentStorageUsage(user),
                        "limit", getStorageLimit(user)
                ));
            }
            storeFile(user, incomingFile.length);
        }

        // Record API call
        recordApiCall(user, ip, endpoint, 200);

        // Increment usage
        incrementApiUsage(user);

        return successResponse(200, Map.of("message", "call succeeded"));
    }

    private boolean rateLimitPerUser(String userId) throws SQLException {
        String sql = "SELECT COUNT(*) FROM api_calls WHERE user_id = ? AND timestamp > ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, userId);
            ps.setTimestamp(2, Timestamp.from(clock.instant().minus(Duration.ofMinutes(1))));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1) >= 100;
            }
        }
    }

    private boolean rateLimitPerIp(String ip) throws SQLException {
        String sql = "SELECT COUNT(*) FROM api_calls WHERE ip = ? AND timestamp > ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, ip);
            ps.setTimestamp(2, Timestamp.from(clock.instant().minus(Duration.ofSeconds(1))));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1) >= 10;
            }
        }
    }

    private boolean featureGate(User user, String feature) {
        Map<String, Set<Tier>> features = Map.of(
                "feature_a", Set.of(Tier.TEAM, Tier.ENTERPRISE),
                "feature_b", Set.of(Tier.ENTERPRISE),
                "feature_c", Set.of(Tier.SOLO, Tier.TEAM, Tier.ENTERPRISE)
        );
        Set<Tier> allowed = features.getOrDefault(feature, Set.of());
        return allowed.contains(user.getTier());
    }

    private boolean apiQuotaCheck(User user) throws SQLException {
        int current = getCurrentApiUsage(user);
        int limit = getApiLimit(user);
        return limit < 0 || (current + 1) <= limit;
    }

    private int getCurrentApiUsage(User user) throws SQLException {
        String sql = "SELECT SUM(call_count) FROM usage_metrics WHERE user_id = ? AND month = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, user.getId());
            ps.setString(2, currentMonth());
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    private int getApiLimit(User user) {
        return switch (user.getTier()) {
            case SOLO -> 1000;
            case TEAM -> 10000;
            case ENTERPRISE -> -1;
        };
    }

    private boolean storageQuotaCheck(User user, long incomingSize) throws SQLException {
        long current = getCurrentStorageUsage(user);
        long limit = getStorageLimit(user);
        return limit < 0 || (current + incomingSize) <= limit;
    }

    private long getCurrentStorageUsage(User user) throws SQLException {
        String sql = "SELECT SUM(file_size) FROM user_files WHERE user_id = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, user.getId());
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private long getStorageLimit(User user) {
        return switch (user.getTier()) {
            case SOLO -> 1_000_000_000L;
            case TEAM -> 100_000_000_000L;
            case ENTERPRISE -> -1;
        };
    }

    private void incrementApiUsage(User user) throws SQLException {
        String sql = "MERGE INTO usage_metrics KEY(user_id, month) VALUES (?, ?, 1, 0, ?)";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, user.getId());
            ps.setString(2, currentMonth());
            ps.setTimestamp(3, Timestamp.from(clock.instant()));
            ps.executeUpdate();
        }
    }

    private void storeFile(User user, long size) throws SQLException {
        String sql = "INSERT INTO user_files (user_id, file_size, uploaded_at) VALUES (?, ?, ?)";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, user.getId());
            ps.setLong(2, size);
            ps.setTimestamp(3, Timestamp.from(clock.instant()));
            ps.executeUpdate();
        }
    }

    private void recordApiCall(User user, String ip, String endpoint, int statusCode) throws SQLException {
        String sql = "INSERT INTO api_calls (user_id, ip, endpoint, timestamp, status_code, response_time_ms) VALUES (?, ?, ?, ?, ?, ?)";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, user.getId());
            ps.setString(2, ip);
            ps.setString(3, endpoint);
            ps.setTimestamp(4, Timestamp.from(clock.instant()));
            ps.setInt(5, statusCode);
            ps.setInt(6, 0);
            ps.executeUpdate();
        }
    }

    private String currentMonth() {
        return YearMonth.from(clock.instant().atZone(ZoneOffset.UTC)).toString();
    }

    private String getResetDate() {
        LocalDate nextMonth = YearMonth.from(clock.instant().atZone(ZoneOffset.UTC)).plusMonths(1).atDay(1);
        return nextMonth.atStartOfDay(ZoneOffset.UTC).toString();
    }

    private Response errorResponse(int status, String error, Map<String, Object> details) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("error", error);
        details.forEach((k, v) -> node.putPOJO(k, v));
        return new Response(status, node.toString());
    }

    private Response successResponse(int status, Map<String, Object> details) {
        ObjectNode node = MAPPER.createObjectNode();
        details.forEach((k, v) -> node.putPOJO(k, v));
        return new Response(status, node.toString());
    }

    public static class User {
        private final String id;
        private Tier tier;

        public User(String id, Tier tier) {
            this.id = id;
            this.tier = tier;
        }

        public String getId() { return id; }
        public Tier getTier() { return tier; }
        public void setTier(Tier tier) { this.tier = tier; }
    }

    public enum Tier { SOLO, TEAM, ENTERPRISE }

    public static class Response {
        private final int statusCode;
        private final String body;

        public Response(int statusCode, String body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        public int getStatusCode() { return statusCode; }
        public String getBody() { return body; }
    }
}