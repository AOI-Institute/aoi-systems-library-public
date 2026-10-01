import java.sql.*;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.Base64;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public class TrialAbusePrevention {
    private final DataSource dataSource;

    public TrialAbusePrevention(DataSource dataSource) {
        this.dataSource = dataSource;
    }

    public enum GateDecision { PASS, CHALLENGE, FAIL }

    public GateDecision checkEmailTrialHistory(String email) throws SQLException {
        String sql = "SELECT COUNT(*) FROM trial_abuse_ledger WHERE email = ? AND subscription_status IN ('completed', 'chargebacked')";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, email);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    int count = rs.getInt(1);
                    if (count == 0) return GateDecision.PASS;
                    if (count == 1) return GateDecision.CHALLENGE;
                    return GateDecision.FAIL;
                }
            }
        }
        throw new SQLException("No result returned");
    }

    public GateDecision checkIpSignupRateLimit(String ip) throws SQLException {
        String sql = "SELECT COUNT(*) FROM signups WHERE ip = ? AND created_at > NOW() - INTERVAL 24 HOURS";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, ip);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    int count = rs.getInt(1);
                    if (count < 5) return GateDecision.PASS;
                    if (count < 10) return GateDecision.CHALLENGE;
                    return GateDecision.FAIL;
                }
            }
        }
        throw new SQLException("No result returned");
    }

    public GateDecision checkPaymentMethodHistory(String stripePaymentMethodId) throws SQLException {
        String sql = "SELECT COUNT(*) FROM trial_abuse_ledger WHERE stripe_payment_method_id = ? AND subscription_status IN ('completed', 'chargebacked')";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, stripePaymentMethodId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    int count = rs.getInt(1);
                    if (count < 2) return GateDecision.PASS;
                    if (count == 2) return GateDecision.CHALLENGE;
                    return GateDecision.FAIL;
                }
            }
        }
        throw new SQLException("No result returned");
    }

    public GateDecision checkDeviceFingerprint(String userAgent, String screenResolution, String timezone, String browserLanguage) throws SQLException, NoSuchAlgorithmException {
        Map<String, String> device = new HashMap<>();
        device.put("user_agent", userAgent);
        device.put("screen_resolution", screenResolution);
        device.put("timezone", timezone);
        device.put("browser_language", browserLanguage);
        String deviceJson = device.toString(); // Simplified for example; in practice use proper JSON
        String deviceHash = sha256(deviceJson);

        String sql = "SELECT COUNT(DISTINCT user_id) FROM device_fingerprints WHERE device_hash = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, deviceHash);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    int count = rs.getInt(1);
                    // In a real system, we would also check if this device matches user's known devices
                    // For simplicity, we skip that check as it requires user_id which we don't have here
                    if (count < 2) return GateDecision.PASS;
                    if (count <= 5) return GateDecision.CHALLENGE;
                    return GateDecision.FAIL;
                }
            }
        }
        throw new SQLException("No result returned");
    }

    public GateDecision checkTrialPaymentTiming(Long userId, int trialDays) throws SQLException {
        String sql = "SELECT created_at FROM users WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    Timestamp trialStartTs = rs.getTimestamp("created_at");
                    Instant trialStart = trialStartTs.toInstant();
                    Instant now = Instant.now();
                    long daysElapsed = ChronoUnit.DAYS.between(trialStart, now);

                    // PASS condition
                    if (daysElapsed < trialDays + 5) {
                        return GateDecision.PASS;
                    }
                    // CHALLENGE condition
                    if (daysElapsed > trialDays + 30) {
                        return GateDecision.CHALLENGE;
                    }
                    // FAIL condition: trial ended, never added payment, trying to re-add after 90+ days
                    boolean trialEnded = daysElapsed > trialDays;
                    boolean neverAddedPayment = !hasPriorSuccessfulSubscription(userId);
                    Instant trialEnd = trialStart.plus(trialDays, ChronoUnit.DAYS);
                    boolean reAddingAfter90Days = ChronoUnit.DAYS.between(trialEnd, now) > 90;
                    if (trialEnded && neverAddedPayment && reAddingAfter90Days) {
                        return GateDecision.FAIL;
                    }
                    return GateDecision.PASS; // Default to PASS for middle ground
                }
            }
        }
        throw new SQLException("User not found: " + userId);
    }

    private boolean hasPriorSuccessfulSubscription(Long userId) throws SQLException {
        String sql = "SELECT COUNT(*) FROM trial_abuse_ledger WHERE user_id = ? AND subscription_status = 'completed'";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getInt(1) > 0;
                }
            }
        }
        return false;
    }

    public GateDecision checkChargebackHistory(Long userId) throws SQLException {
        String stripeCustomerId = getStripeCustomerId(userId);
        int stripeChargebacks = 0;
        int refundChargebacks = 0;

        String sql1 = "SELECT COUNT(*) FROM stripe_events WHERE customer = ? AND type LIKE '%chargeback%'";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql1)) {
            ps.setString(1, stripeCustomerId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    stripeChargebacks = rs.getInt(1);
                }
            }
        }

        String sql2 = "SELECT COUNT(*) FROM refunds WHERE user_id = ? AND status = 'chargebacked'";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql2)) {
            ps.setLong(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    refundChargebacks = rs.getInt(1);
                }
            }
        }

        int totalChargebacks = stripeChargebacks + refundChargebacks;
        if (totalChargebacks == 0) return GateDecision.PASS;
        if (totalChargebacks == 1) return GateDecision.CHALLENGE;
        return GateDecision.FAIL;
    }

    private String getStripeCustomerId(Long userId) throws SQLException {
        String sql = "SELECT stripe_customer_id FROM users WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getString("stripe_customer_id");
                }
            }
        }
        throw new SQLException("Stripe customer ID not found for user: " + userId);
    }

    public void logGateDecision(Long userId, String gateName, GateDecision decision, Map<String, Object> ruleInputs, Map<String, Object> ruleOutputs) throws SQLException {
        String sql = "INSERT INTO gate_decisions (user_id, gate_name, decision, rule_inputs, rule_outputs, created_at) VALUES (?, ?, ?, ?, ?, NOW())";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, userId);
            ps.setString(2, gateName);
            ps.setString(3, decision.name());
            ps.setString(4, toJson(ruleInputs));
            ps.setString(5, toJson(ruleOutputs));
            ps.executeUpdate();
        }
    }

    public void createAbuseLedgerEntry(Long userId, String email, String ip, String deviceHash) throws SQLException {
        String sql = "INSERT INTO trial_abuse_ledger (user_id, email, ip, device_fingerprint, signup_date, trial_started_at, gate_flags, created_at) VALUES (?, ?, ?, ?, NOW(), NOW(), '{}', NOW())";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) {
            ps.setLong(1, userId);
            ps.setString(2, email);
            ps.setString(3, ip);
            ps.setString(4, deviceHash);
            ps.executeUpdate();
        }
    }

    public void updateAbuseLedgerPayment(Long abuseLedgerId, String stripePaymentMethodId) throws SQLException {
        String sql = "UPDATE trial_abuse_ledger SET payment_added_date = NOW(), stripe_payment_method_id = ? WHERE id = ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, stripePaymentMethodId);
            ps.setLong(2, abuseLedgerId);
            ps.executeUpdate();
        }
    }

    public void insertDeviceFingerprint(Long userId, String deviceHash, String userAgent, String screenResolution, String timezone) throws SQLException {
        String sql = "INSERT INTO device_fingerprints (user_id, device_hash, user_agent, screen_resolution, timezone, created_at) VALUES (?, ?, ?, ?, ?, NOW())";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, userId);
            ps.setString(2, deviceHash);
            ps.setString(3, userAgent);
            ps.setString(4, screenResolution);
            ps.setString(5, timezone);
            ps.executeUpdate();
        }
    }

    private String toJson(Map<String, Object> map) {
        if (map == null || map.isEmpty()) return "{}";
        StringBuilder sb = new StringBuilder();
        sb.append("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            if (!first) sb.append(", ");
            first = false;
            sb.append('"').append(entry.getKey()).append('"');
            sb.append(':');
            Object value = entry.getValue();
            if (value == null) {
                sb.append("null");
            } else if (value instanceof String) {
                sb.append('"').append(escapeJson((String) value)).append('"');
            } else if (value instanceof Number || value instanceof Boolean) {
                sb.append(value);
            } else {
                sb.append('"').append(value.toString()).append('"');
            }
        }
        sb.append("}");
        return sb.toString();
    }

    private String escapeJson(String s) {
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\\"); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    private String sha256(String input) throws NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(hash);
    }

    // DDL for tables as executable SQL
    public static final String[] DDL_STATEMENTS = {
        "CREATE TABLE IF NOT EXISTS trial_abuse_ledger (" +
                "id BIGINT AUTO_INCREMENT PRIMARY KEY," +
                "user_id BIGINT NOT NULL," +
                "email VARCHAR(255) NOT NULL," +
                "stripe_payment_method_id VARCHAR(255)," +
                "ip VARCHAR(45) NOT NULL," +
                "device_fingerprint VARCHAR(64)," +
                "signup_date TIMESTAMP NOT NULL," +
                "trial_started_at TIMESTAMP NOT NULL," +
                "payment_added_date TIMESTAMP," +
                "subscription_status VARCHAR(20)," +
                "chargeback_count INT DEFAULT 0," +
                "refund_count INT DEFAULT 0," +
                "gate_flags JSON," +
                "alert_reason TEXT," +
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" +
        ");",
        "CREATE TABLE IF NOT EXISTS device_fingerprints (" +
                "id BIGINT AUTO_INCREMENT PRIMARY KEY," +
                "user_id BIGINT NOT NULL," +
                "device_hash VARCHAR(64) NOT NULL," +
                "user_agent TEXT," +
                "screen_resolution VARCHAR(20)," +
                "timezone VARCHAR(50)," +
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" +
        ");",
        "CREATE TABLE IF NOT EXISTS gate_decisions (" +
                "id BIGINT AUTO_INCREMENT PRIMARY KEY," +
                "user_id BIGINT NOT NULL," +
                "gate_name VARCHAR(50) NOT NULL," +
                "decision VARCHAR(20) NOT NULL," +
                "rule_inputs JSON," +
                "rule_outputs JSON," +
                "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" +
        ");"
    };
}