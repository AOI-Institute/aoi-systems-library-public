import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.logging.*;

public class NotificationService {
    private static final Logger logger = Logger.getLogger(NotificationService.class.getName());
    private final Connection conn;
    private final EmailSender emailSender;
    private final SmsSender smsSender;
    private final InAppSender inAppSender;

    public NotificationService() throws SQLException {
        this.conn = DriverManager.getConnection("jdbc:h2:mem:test;DB_CLOSE_DELAY=-1");
        this.emailSender = new SimpleEmailSender();
        this.smsSender = new SimpleSmsSender();
        this.inAppSender = new SimpleInAppSender();
        initDatabase();
        seedTemplates();
    }

    public NotificationService(EmailSender emailSender, SmsSender smsSender, InAppSender inAppSender) throws SQLException {
        this.conn = DriverManager.getConnection("jdbc:h2:mem:test;DB_CLOSE_DELAY=-1");
        this.emailSender = emailSender;
        this.smsSender = smsSender;
        this.inAppSender = inAppSender;
        initDatabase();
        seedTemplates();
    }

    private void initDatabase() throws SQLException {
        try (Statement stmt = conn.createStatement()) {
            stmt.execute("CREATE TABLE IF NOT EXISTS notification_templates (" +
                    "key VARCHAR(255) PRIMARY KEY," +
                    "subject VARCHAR(255)," +
                    "body_text TEXT," +
                    "body_html TEXT," +
                    "channels_default VARCHAR(255)," +
                    "variables TEXT" +
                    ")");
            stmt.execute("CREATE TABLE IF NOT EXISTS notification_logs (" +
                    "id VARCHAR(36) PRIMARY KEY," +
                    "user_id BIGINT," +
                    "template_key VARCHAR(255)," +
                    "channel VARCHAR(20)," +
                    "vars_used TEXT," +
                    "sent_at TIMESTAMP," +
                    "opened_at TIMESTAMP," +
                    "clicked_at TIMESTAMP," +
                    "bounced BOOLEAN," +
                    "error TEXT" +
                    ")");
            stmt.execute("CREATE TABLE IF NOT EXISTS user_notification_preferences (" +
                    "user_id BIGINT PRIMARY KEY," +
                    "do_not_disturb BOOLEAN," +
                    "quiet_hours_start VARCHAR(5)," +
                    "quiet_hours_end VARCHAR(5)," +
                    "channels_enabled TEXT" +
                    ")");
        }
    }

    private void seedTemplates() throws SQLException {
        addTemplate(new NotificationTemplate("welcome_email",
                "Welcome to {app_name}!",
                "Welcome to {app_name}! Here's your first step.",
                null,
                "email",
                "[\"app_name\"]"));
        addTemplate(new NotificationTemplate("trial_starting",
                null,
                "Your free trial is starting. You have {trial_days} days.",
                null,
                "email",
                "[\"trial_days\"]"));
        addTemplate(new NotificationTemplate("trial_ending_soon",
                null,
                "Your trial ends in {days_left} days. Add payment method to continue.",
                null,
                "email",
                "[\"days_left\"]"));
        addTemplate(new NotificationTemplate("subscription_changed",
                null,
                "Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.",
                null,
                "email",
                "[\"old_tier\",\"new_tier\",\"effective_date\"]"));
        addTemplate(new NotificationTemplate("payment_failed",
                null,
                "Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.",
                null,
                "email",
                "[\"invoice_id\",\"retry_date\"]"));
        addTemplate(new NotificationTemplate("deployment_live",
                null,
                "Your deployment {deployment_name} is now live at {url}.",
                null,
                "email",
                "[\"deployment_name\",\"url\"]"));
        addTemplate(new NotificationTemplate("user_invited",
                null,
                "You've been invited to {workspace}. Click here to join.",
                null,
                "email",
                "[\"workspace\"]"));
        addTemplate(new NotificationTemplate("invoice_ready",
                null,
                "Your invoice for {month} is ready. Download here.",
                null,
                "email",
                "[\"month\"]"));
        addTemplate(new NotificationTemplate("admin_alert",
                null,
                "{actor} performed {action} on {resource}.",
                null,
                "email",
                "[\"actor\",\"action\",\"resource\"]"));
    }

    public void addTemplate(NotificationTemplate template) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO notification_templates (key, subject, body_text, body_html, channels_default, variables) VALUES (?,?,?,?,?,?)")) {
            ps.setString(1, template.key);
            ps.setString(2, template.subject);
            ps.setString(3, template.bodyText);
            ps.setString(4, template.bodyHtml);
            ps.setString(5, template.channelsDefault);
            ps.setString(6, template.variables);
            ps.executeUpdate();
        }
    }

    public SendResponse sendSingle(NotificationRequest request) {
        String messageId = UUID.randomUUID().toString();
        LocalDateTime now = LocalDateTime.now();
        UserNotificationPreferences prefs = getUserPreferences(request.userId);
        if (prefs == null) {
            prefs = new UserNotificationPreferences(request.userId, false, "00:00", "00:00",
                    Map.of("email", true, "sms", true, "in_app", true));
        }
        if (prefs.doNotDisturb) {
            logMessage(messageId, request, "skipped", null, null, null, true, "Do-not-disturb");
            return new SendResponse(true, messageId, "skipped");
        }
        if (isInQuietHours(prefs, now.toLocalTime())) {
            logMessage(messageId, request, "queued", null, null, null, false, null);
            return new SendResponse(true, messageId, "queued");
        }
        String channel = request.channel;
        if (channel == null) {
            channel = selectChannel(prefs, null);
        }
        if (channel == null || !isChannelEnabled(prefs, channel)) {
            logMessage(messageId, request, "skipped", null, null, null, true, "Channel disabled");
            return new SendResponse(true, messageId, "skipped");
        }
        if (request.scheduledAt != null && request.scheduledAt.isAfter(now)) {
            logMessage(messageId, request, "queued", null, null, null, false, null);
            return new SendResponse(true, messageId, "queued");
        }
        NotificationTemplate template = getTemplate(request.templateKey);
        if (template == null) {
            logMessage(messageId, request, "failed", null, null, null, true, "Template not found");
            return new SendResponse(false, messageId, "failed");
        }
        String body = renderTemplate(template.bodyText, request.vars);
        String subject = template.subject != null ? renderTemplate(template.subject, request.vars) : null;
        boolean success = false;
        String error = null;
        boolean bounced = false;
        int attempts = 0;
        while (attempts < 3 && !success) {
            try {
                attempts++;
                if (channel.equals("email")) {
                    emailSender.send(request.userId + "@example.com", subject, body);
                } else if (channel.equals("sms")) {
                    smsSender.send(request.userId + "@example.com", body);
                } else if (channel.equals("in_app")) {
                    inAppSender.send(request.userId, body);
                }
                success = true;
            } catch (BounceException be) {
                bounced = true;
                error = be.getMessage();
                break;
            } catch (Exception e) {
                error = e.getMessage();
                if (attempts < 3) {
                    try { Thread.sleep((long) Math.pow(2, attempts - 1) * 1000); } catch (InterruptedException ie) {}
                }
            }
        }
        if (success) {
            logMessage(messageId, request, "sent", now, null, null, bounced, error);
            return new SendResponse(true, messageId, "sent");
        } else {
            logMessage(messageId, request, "failed", now, null, null, bounced, error);
            return new SendResponse(false, messageId, "failed");
        }
    }

    public BatchSendResponse sendBatch(List<NotificationRequest> requests) {
        int sent = 0;
        int failed = 0;
        List<String> messageIds = new ArrayList<>();
        for (NotificationRequest req : requests) {
            SendResponse resp = sendSingle(req);
            messageIds.add(resp.messageId);
            if (resp.status.equals("sent") || resp.status.equals("queued")) {
                sent++;
            } else {
                failed++;
            }
        }
        return new BatchSendResponse(true, sent, failed, messageIds);
    }

    public TrackResponse track(String messageId) {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT * FROM notification_logs WHERE id = ?")) {
            ps.setString(1, messageId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return new TrackResponse(
                            rs.getString("id"),
                            rs.getLong("user_id"),
                            rs.getString("template_key"),
                            rs.getString("channel"),
                            rs.getString("status"),
                            rs.getTimestamp("sent_at") != null ? rs.getTimestamp("sent_at").toLocalDateTime() : null,
                            rs.getTimestamp("opened_at") != null ? rs.getTimestamp("opened_at").toLocalDateTime() : null,
                            rs.getTimestamp("clicked_at") != null ? rs.getTimestamp("clicked_at").toLocalDateTime() : null
                    );
                }
            }
        } catch (SQLException e) {
            logger.severe("Track error: " + e.getMessage());
        }
        return null;
    }

    public UserNotificationPreferences getUserPreferences(long userId) {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT * FROM user_notification_preferences WHERE user_id = ?")) {
            ps.setLong(1, userId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    Map<String, Boolean> channels = parseChannelsEnabled(rs.getString("channels_enabled"));
                    return new UserNotificationPreferences(
                            rs.getLong("user_id"),
                            rs.getBoolean("do_not_disturb"),
                            rs.getString("quiet_hours_start"),
                            rs.getString("quiet_hours_end"),
                            channels
                    );
                }
            }
        } catch (SQLException e) {
            logger.severe("Get prefs error: " + e.getMessage());
        }
        return null;
    }

    public boolean updateUserPreferences(long userId, UserNotificationPreferences prefs) {
        try (PreparedStatement ps = conn.prepareStatement(
                "MERGE INTO user_notification_preferences KEY(user_id) VALUES (?,?,?,?,?)")) {
            ps.setLong(1, userId);
            ps.setBoolean(2, prefs.doNotDisturb);
            ps.setString(3, prefs.quietHoursStart);
            ps.setString(4, prefs.quietHoursEnd);
            ps.setString(5, toJson(prefs.channelsEnabled));
            return ps.executeUpdate() > 0;
        } catch (SQLException e) {
            logger.severe("Update prefs error: " + e.getMessage());
            return false;
        }
    }

    public void openMessage(String messageId) {
        try (PreparedStatement ps = conn.prepareStatement(
                "UPDATE notification_logs SET opened_at = ? WHERE id = ?")) {
            ps.setTimestamp(1, Timestamp.valueOf(LocalDateTime.now()));
            ps.setString(2, messageId);
            ps.executeUpdate();
        } catch (SQLException e) {
            logger.severe("Open error: " + e.getMessage());
        }
    }

    public void clickMessage(String messageId) {
        try (PreparedStatement ps = conn.prepareStatement(
                "UPDATE notification_logs SET clicked_at = ? WHERE id = ?")) {
            ps.setTimestamp(1, Timestamp.valueOf(LocalDateTime.now()));
            ps.setString(2, messageId);
            ps.executeUpdate();
        } catch (SQLException e) {
            logger.severe("Click error: " + e.getMessage());
        }
    }

    public void unsubscribeEmail(long userId) {
        UserNotificationPreferences prefs = getUserPreferences(userId);
        if (prefs != null) {
            prefs.channelsEnabled.put("email", false);
            updateUserPreferences(userId, prefs);
        }
    }

    private NotificationTemplate getTemplate(String key) {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT * FROM notification_templates WHERE key = ?")) {
            ps.setString(1, key);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return new NotificationTemplate(
                            rs.getString("key"),
                            rs.getString("subject"),
                            rs.getString("body_text"),
                            rs.getString("body_html"),
                            rs.getString("channels_default"),
                            rs.getString("variables")
                    );
                }
            }
        } catch (SQLException e) {
            logger.severe("Get template error: " + e.getMessage());
        }
        return null;
    }

    private void logMessage(String messageId, NotificationRequest request, String status,
                            LocalDateTime sentAt, LocalDateTime openedAt, LocalDateTime clickedAt,
                            boolean bounced, String error) {
        try (PreparedStatement ps = conn.prepareStatement(
                "INSERT INTO notification_logs (id, user_id, template_key, channel, vars_used, sent_at, opened_at, clicked_at, bounced, error, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)")) {
            ps.setString(1, messageId);
            ps.setLong(2, request.userId);
            ps.setString(3, request.templateKey);
            ps.setString(4, request.channel);
            ps.setString(5, toJson(request.vars));
            ps.setTimestamp(6, sentAt != null ? Timestamp.valueOf(sentAt) : null);
            ps.setTimestamp(7, openedAt != null ? Timestamp.valueOf(openedAt) : null);
            ps.setTimestamp(8, clickedAt != null ? Timestamp.valueOf(clickedAt) : null);
            ps.setBoolean(9, bounced);
            ps.setString(10, error);
            ps.setString(11, status);
            ps.executeUpdate();
        } catch (SQLException e) {
            logger.severe("Log error: " + e.getMessage());
        }
    }

    private boolean isInQuietHours(UserNotificationPreferences prefs, LocalTime now) {
        LocalTime start = LocalTime.parse(prefs.quietHoursStart);
        LocalTime end = LocalTime.parse(prefs.quietHoursEnd);
        if (start.equals(end)) return false;
        if (start.isBefore(end)) {
            return !now.isBefore(start) && !now.isAfter(end);
        } else {
            return !now.isBefore(start) || !now.isAfter(end);
        }
    }

    private boolean isChannelEnabled(UserNotificationPreferences prefs, String channel) {
        return prefs.channelsEnabled.getOrDefault(channel, false);
    }

    private String selectChannel(UserNotificationPreferences prefs, String requested) {
        if (requested != null) return requested;
        if (prefs.channelsEnabled.getOrDefault("email", false)) return "email";
        if (prefs.channelsEnabled.getOrDefault("sms", false)) return "sms";
        if (prefs.channelsEnabled.getOrDefault("in_app", false)) return "in_app";
        return null;
    }

    private String renderTemplate(String template, Map<String, Object> vars) {
        if (template == null) return null;
        String result = template;
        for (Map.Entry<String, Object> e : vars.entrySet()) {
            result = result.replace("{" + e.getKey() + "}", e.getValue().toString());
        }
        return result;
    }

    private Map<String, Boolean> parseChannelsEnabled(String json) {
        Map<String, Boolean> map = new HashMap<>();
        if (json == null || json.isEmpty()) return map;
        json = json.trim();
        if (json.startsWith("{") && json.endsWith("}")) {
            json = json.substring(1, json.length() - 1);
            String[] pairs = json.split(",");
            for (String pair : pairs) {
                String[] kv = pair.split(":");
                if (kv.length == 2) {
                    String key = kv[0].trim().replaceAll("\"", "");
                    String val = kv[1].trim();
                    boolean boolVal = val.equalsIgnoreCase("true");
                    map.put(key, boolVal);
                }
            }
        }
        return map;
    }

    private String toJson(Map<String, Boolean> map) {
        StringBuilder sb = new StringBuilder();
        sb.append("{");
        boolean first = true;
        for (Map.Entry<String, Boolean> e : map.entrySet()) {
            if (!first) sb.append(",");
            sb.append("\"").append(e.getKey()).append("\":").append(e.getValue());
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }

    private String toJson(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder();
        sb.append("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) sb.append(",");
            sb.append("\"").append(e.getKey()).append("\":");
            Object val = e.getValue();
            if (val instanceof Number || val instanceof Boolean) {
                sb.append(val.toString());
            } else {
                sb.append("\"").append(val.toString()).append("\"");
            }
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }

    // Data classes
    public static class NotificationRequest {
        public long userId;
        public String templateKey;
        public String channel; // email, sms, in_app, or null
        public Map<String, Object> vars;
        public LocalDateTime scheduledAt; // null or future

        public NotificationRequest(long userId, String templateKey, String channel,
                                   Map<String, Object> vars, LocalDateTime scheduledAt) {
            this.userId = userId;
            this.templateKey = templateKey;
            this.channel = channel;
            this.vars = vars;
            this.scheduledAt = scheduledAt;
        }
    }

    public static class SendResponse {
        public boolean success;
        public String messageId;
        public String status; // sent|queued|failed|skipped

        public SendResponse(boolean success, String messageId, String status) {
            this.success = success;
            this.messageId = messageId;
            this.status = status;
        }
    }

    public static class BatchSendResponse {
        public boolean success;
        public int sent;
        public int failed;
        public List<String> messageIds;

        public BatchSendResponse(boolean success, int sent, int failed, List<String> messageIds) {
            this.success = success;
            this.sent = sent;
            this.failed = failed;
            this.messageIds = messageIds;
        }
    }

    public static class TrackResponse {
        public String messageId;
        public long userId;
        public String templateKey;
        public String channel;
        public String status;
        public LocalDateTime sentAt;
        public LocalDateTime openedAt;
        public LocalDateTime clickedAt;

        public TrackResponse(String messageId, long userId, String templateKey, String channel,
                             String status, LocalDateTime sentAt, LocalDateTime openedAt, LocalDateTime clickedAt) {
            this.messageId = messageId;
            this.userId = userId;
            this.templateKey = templateKey;
            this.channel = channel;
            this.status = status;
            this.sentAt = sentAt;
            this.openedAt = openedAt;
            this.clickedAt = clickedAt;
        }
    }

    public static class UserNotificationPreferences {
        public long userId;
        public boolean doNotDisturb;
        public String quietHoursStart; // HH:mm
        public String quietHoursEnd;   // HH:mm
        public Map<String, Boolean> channelsEnabled; // email, sms, in_app

        public UserNotificationPreferences(long userId, boolean doNotDisturb,
                                           String quietHoursStart, String quietHoursEnd,
                                           Map<String, Boolean> channelsEnabled) {
            this.userId = userId;
            this.doNotDisturb = doNotDisturb;
            this.quietHoursStart = quietHoursStart;
            this.quietHoursEnd = quietHoursEnd;
            this.channelsEnabled = channelsEnabled;
        }
    }

    public static class NotificationTemplate {
        public String key;
        public String subject;
        public String bodyText;
        public String bodyHtml;
        public String channelsDefault;
        public String variables; // JSON array

        public NotificationTemplate(String key, String subject, String bodyText,
                                    String bodyHtml, String channelsDefault, String variables) {
            this.key = key;
            this.subject = subject;
            this.bodyText = bodyText;
            this.bodyHtml = bodyHtml;
            this.channelsDefault = channelsDefault;
            this.variables = variables;
        }
    }

    // Sender interfaces
    public interface EmailSender {
        void send(String to, String subject, String body) throws Exception;
    }

    public interface SmsSender {
        void send(String to, String body) throws Exception;
    }

    public interface InAppSender {
        void send(long userId, String body);
    }

    // Simple implementations
    public static class SimpleEmailSender implements EmailSender {
        @Override
        public void send(String to, String subject, String body) throws Exception {
            // Simulate sending
            logger.info("Email sent to " + to + " subject: " + subject);
        }
    }

    public static class SimpleSmsSender implements SmsSender {
        @Override
        public void send(String to, String body) throws Exception {
            // Simulate sending
            logger.info("SMS sent to " + to + " body: " + body);
        }
    }

    public static class SimpleInAppSender implements InAppSender {
        @Override
        public void send(long userId, String body) {
            // Simulate in-app notification
            logger.info("In-app notification sent to user " + userId + " body: " + body);
        }
    }

    // Custom exception for bounce
    public static class BounceException extends Exception {
        public BounceException(String message) {
            super(message);
        }
    }
}