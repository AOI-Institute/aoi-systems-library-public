package com.saas.billing;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.stripe.Stripe;
import com.stripe.exception.StripeException;
import com.stripe.model.Invoice;
import com.stripe.model.Subscription;
import com.stripe.model.SubscriptionItem;
import com.stripe.model.Customer;
import com.stripe.param.InvoiceRetrieveParams;
import com.stripe.param.SubscriptionCreateParams;
import com.stripe.param.SubscriptionUpdateParams;
import com.stripe.net.Webhook;

import java.sql.*;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;

public class BillingService {

    private static final Gson gson = new Gson();
    private static final DateTimeFormatter ISO_FORMATTER = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC);
    private static final Map<String, String> PRICE_IDS = new HashMap<>();
    private static final Map<String, String> TIER_NAMES = new HashMap<>();

    static {
        // Initialize Stripe API key from environment
        String stripeKey = System.getenv("STRIPE_SECRET_KEY");
        if (stripeKey != null && !stripeKey.isEmpty()) {
            Stripe.apiKey = stripeKey;
        }

        // Initialize Price IDs (using placeholders as per spec, in production these would be loaded from config)
        PRICE_IDS.put("solo", "price_1UI_solo_placeholder");
        PRICE_IDS.put("team", "price_1UI_team_placeholder");
        PRICE_IDS.put("enterprise", "price_1UI_enterprise_placeholder");

        TIER_NAMES.put("solo", "Solo");
        TIER_NAMES.put("team", "Team");
        TIER_NAMES.put("enterprise", "Enterprise");
    }

    private final Connection connection;

    public BillingService(Connection connection) {
        this.connection = connection;
    }

    /**
     * Executes the database schema.
     */
    public static void initializeSchema(Connection conn) throws SQLException {
        String ddl = "CREATE TABLE IF NOT EXISTS subscriptions (\n" +
                "    id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
                "    stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,\n" +
                "    customer_id VARCHAR(255) NOT NULL,\n" +
                "    tier VARCHAR(50) NOT NULL,\n" +
                "    status VARCHAR(50) NOT NULL DEFAULT 'active',\n" +
                "    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n" +
                "    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n" +
                "    cancelled_at TIMESTAMP NULL\n" +
                ");\n" +
                "CREATE TABLE IF NOT EXISTS invoices (\n" +
                "    id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
                "    stripe_invoice_id VARCHAR(255) UNIQUE NOT NULL,\n" +
                "    customer_id VARCHAR(255) NOT NULL,\n" +
                "    amount BIGINT NOT NULL,\n" +
                "    status VARCHAR(50) NOT NULL,\n" +
                "    paid_at TIMESTAMP NULL\n" +
                ");\n" +
                "CREATE TABLE IF NOT EXISTS refunds (\n" +
                "    id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
                "    invoice_id BIGINT NOT NULL,\n" +
                "    amount BIGINT NOT NULL,\n" +
                "    status VARCHAR(50) NOT NULL DEFAULT 'queued',\n" +
                "    reason VARCHAR(255) NOT NULL,\n" +
                "    created_by VARCHAR(255) NOT NULL,\n" +
                "    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n" +
                "    executed_at TIMESTAMP NULL,\n" +
                "    FOREIGN KEY (invoice_id) REFERENCES invoices(id)\n" +
                ");\n" +
                "CREATE TABLE IF NOT EXISTS events (\n" +
                "    id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
                "    stripe_event_id VARCHAR(255) UNIQUE NOT NULL,\n" +
                "    event_type VARCHAR(255) NOT NULL,\n" +
                "    processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n" +
                ");\n" +
                "CREATE TABLE IF NOT EXISTS audit_log (\n" +
                "    id BIGINT AUTO_INCREMENT PRIMARY KEY,\n" +
                "    action VARCHAR(255) NOT NULL,\n" +
                "    customer_id VARCHAR(255),\n" +
                "    subscription_id VARCHAR(255),\n" +
                "    invoice_id VARCHAR(255),\n" +
                "    tier VARCHAR(50),\n" +
                "    old_tier VARCHAR(50),\n" +
                "    new_tier VARCHAR(50),\n" +
                "    amount BIGINT,\n" +
                "    reason VARCHAR(255),\n" +
                "    proration_credits BIGINT,\n" +
                "    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n" +
                ");";

        try (Statement stmt = conn.createStatement()) {
            for (String sql : ddl.split(";")) {
                if (!sql.trim().isEmpty()) {
                    stmt.execute(sql.trim());
                }
            }
        }
    }

    /**
     * Flow 1: Create Subscription
     */
    public JsonObject createSubscription(String customerId, String tier) {
        // Validate tier
        if (!PRICE_IDS.containsKey(tier)) {
            return errorResponse("invalid_tier", "Invalid tier: " + tier);
        }

        try {
            // Call Stripe
            SubscriptionCreateParams params = SubscriptionCreateParams.builder()
                    .setCustomer(customerId)
                    .addItems(SubscriptionCreateParams.Item.builder()
                            .setPrice(PRICE_IDS.get(tier))
                            .build())
                    .build();

            Subscription subscription = Subscription.create(params);

            // DB: Insert subscription
            String sql = "INSERT INTO subscriptions (stripe_subscription_id, customer_id, tier, status, created_at) VALUES (?, ?, ?, 'active', ?)";
            try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
                pstmt.setString(1, subscription.getId());
                pstmt.setString(2, customerId);
                pstmt.setString(3, tier);
                pstmt.setTimestamp(4, Timestamp.from(Instant.now()));
                pstmt.executeUpdate();
            }

            // Log: Audit
            logAudit("subscription_created", customerId, subscription.getId(), null, tier, null, null, null, null, null);

            // Return
            JsonObject response = new JsonObject();
            response.addProperty("success", true);
            response.addProperty("subscription_id", subscription.getId());
            response.addProperty("tier", tier);
            response.addProperty("status", "active");
            response.addProperty("next_billing_date", ISO_FORMATTER.format(Instant.ofEpochSecond(subscription.getCurrentPeriodEnd())));
            return response;

        } catch (StripeException e) {
            return errorResponse("stripe_error", e.getMessage());
        } catch (SQLException e) {
            return errorResponse("db_error", e.getMessage());
        }
    }

    /**
     * Flow 2: Change Plan
     */
    public JsonObject changePlan(String subscriptionId, String newTier) {
        // Validate tier
        if (!PRICE_IDS.containsKey(newTier)) {
            return errorResponse("invalid_tier", "Invalid tier: " + newTier);
        }

        try {
            // Fetch existing subscription from DB to get stripe_id and old_tier
            String oldTier = null;
            String stripeSubId = null;
            String customerId = null;
            String sql = "SELECT stripe_subscription_id, tier, customer_id FROM subscriptions WHERE stripe_subscription_id = ?";
            try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
                pstmt.setString(1, subscriptionId);
                ResultSet rs = pstmt.executeQuery();
                if (rs.next()) {
                    stripeSubId = rs.getString("stripe_subscription_id");
                    oldTier = rs.getString("tier");
                    customerId = rs.getString("customer_id");
                } else {
                    return errorResponse("not_found", "Subscription not found");
                }
            }

            // Call Stripe
            SubscriptionUpdateParams params = SubscriptionUpdateParams.builder()
                    .setSubscription(stripeSubId)
                    .addItems(SubscriptionUpdateParams.Item.builder()
                            .setPrice(PRICE_IDS.get(newTier))
                            .build())
                    .build();

            Subscription updatedSub = Subscription.update(params);

            // Calculate proration credit (simplified: 0 for this implementation, real logic would compare dates)
            long prorationCredit = 0;

            // DB: Update subscription
            String updateSql = "UPDATE subscriptions SET tier = ?, updated_at = ? WHERE stripe_subscription_id = ?";
            try (PreparedStatement pstmt = connection.prepareStatement(updateSql)) {
                pstmt.setString(1, newTier);
                pstmt.setTimestamp(2, Timestamp.from(Instant.now()));
                pstmt.setString(3, stripeSubId);
                pstmt.executeUpdate();
            }

            // Log: Audit
            logAudit("plan_changed", customerId, stripeSubId, null, null, oldTier, newTier, null, null, prorationCredit);

            // Return
            JsonObject response = new JsonObject();
            response.addProperty("success", true);
            response.addProperty("subscription_id", stripeSubId);
            response.addProperty("old_tier", oldTier);
            response.addProperty("new_tier", newTier);
            response.addProperty("effective_date", ISO_FORMATTER.format(Instant.now()));
            response.addProperty("proration_credit", prorationCredit);
            return response;

        } catch (StripeException e) {
            return errorResponse("stripe_error", e.getMessage());
        } catch (SQLException e) {
            return errorResponse("db_error", e.getMessage());
        }
    }

    /**
     * Flow 3: Queue Refund
     */
    public JsonObject queueRefund(String invoiceId, long amount, String reason, String createdBy) {
        try {
            // Check: Invoice exists and status
            String sql = "SELECT id, amount, status FROM invoices WHERE stripe_invoice_id = ?";
            long invoiceDbId = 0;
            long invoiceAmount = 0;
            String invoiceStatus = null;
            try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
                pstmt.setString(1, invoiceId);
                ResultSet rs = pstmt.executeQuery();
                if (rs.next()) {
                    invoiceDbId = rs.getLong("id");
                    invoiceAmount = rs.getLong("amount");
                    invoiceStatus = rs.getString("status");
                } else {
                    return errorResponse("not_found", "Invoice not found");
                }
            }

            if (!"succeeded".equals(invoiceStatus)) {
                return errorResponse("invalid_invoice_status", "Invoice is not in succeeded status");
            }

            if (amount > invoiceAmount) {
                return errorResponse("refund_exceeds_invoice", "Refund amount exceeds invoice amount");
            }

            // DB: Insert refund
            String insertSql = "INSERT INTO refunds (invoice_id, amount, reason, status, created_by, created_at) VALUES (?, ?, ?, 'queued', ?, ?)";
            long refundId = 0;
            try (PreparedStatement pstmt = connection.prepareStatement(insertSql, Statement.RETURN_GENERATED_KEYS)) {
                pstmt.setLong(1, invoiceDbId);
                pstmt.setLong(2, amount);
                pstmt.setString(3, reason);
                pstmt.setString(4, createdBy);
                pstmt.setTimestamp(5, Timestamp.from(Instant.now()));
                pstmt.executeUpdate();
                ResultSet keys = pstmt.getGeneratedKeys();
                if (keys.next()) {
                    refundId = keys.getLong(1);
                }
            }

            // Log: Audit
            logAudit("refund_queued", null, null, invoiceId, null, null, null, amount, reason, null);

            // Return
            JsonObject response = new JsonObject();
            response.addProperty("success", true);
            response.addProperty("refund_id", refundId);
            response.addProperty("status", "queued");
            response.addProperty("amount", amount);
            response.addProperty("reason", reason);
            return response;

        } catch (SQLException e) {
            return errorResponse("db_error", e.getMessage());
        }
    }

    /**
     * Flow 4: Handle Stripe Webhook
     */
    public JsonObject handleStripeWebhook(String payload, String signature) {
        // Verify signature
        String webhookSecret = System.getenv("STRIPE_WEBHOOK_SECRET");
        if (webhookSecret == null || webhookSecret.isEmpty()) {
            return errorResponse("config_error", "Webhook secret not configured");
        }

        JsonObject event;
        try {
            event = Webhook.constructEvent(payload, signature, webhookSecret);
        } catch (Exception e) {
            return errorResponse("invalid_signature", "Invalid webhook signature");
        }

        String eventId = event.get("id").getAsString();
        String eventType = event.get("type").getAsString();

        // Idempotency check
        try {
            String checkSql = "SELECT id FROM events WHERE stripe_event_id = ?";
            try (PreparedStatement pstmt = connection.prepareStatement(checkSql)) {
                pstmt.setString(1, eventId);
                ResultSet rs = pstmt.executeQuery();
                if (rs.next()) {
                    // Already processed
                    JsonObject response = new JsonObject();
                    response.addProperty("received", true);
                    return response;
                }
            }
        } catch (SQLException e) {
            return errorResponse("db_error", e.getMessage());
        }

        // Process event
        try {
            if ("invoice.payment_succeeded".equals(eventType)) {
                processPaymentSucceeded(event);
            } else if ("invoice.payment_failed".equals(eventType)) {
                processPaymentFailed(event);
            } else if ("customer.subscription.updated".equals(eventType)) {
                processSubscriptionUpdated(event);
            } else if ("customer.subscription.deleted".equals(eventType)) {
                processSubscriptionDeleted(event);
            }

            // Log event as processed
            String insertEventSql = "INSERT INTO events (stripe_event_id, event_type, processed_at) VALUES (?, ?, ?)";
            try (PreparedStatement pstmt = connection.prepareStatement(insertEventSql)) {
                pstmt.setString(1, eventId);
                pstmt.setString(2, eventType);
                pstmt.setTimestamp(3, Timestamp.from(Instant.now()));
                pstmt.executeUpdate();
            }

        } catch (SQLException e) {
            return errorResponse("db_error", e.getMessage());
        }

        JsonObject response = new JsonObject();
        response.addProperty("received", true);
        return response;
    }

    private void processPaymentSucceeded(JsonObject event) throws SQLException {
        JsonObject data = event.getAsJsonObject("data");
        JsonObject invoiceObj = data.getAsJsonObject("object");
        String stripeInvoiceId = invoiceObj.get("id").getAsString();
        String customerId = invoiceObj.get("customer").getAsString();
        long amount = invoiceObj.get("amount_paid").getAsLong();

        // DB: Insert/Update invoice
        String sql = "INSERT INTO invoices (stripe_invoice_id, customer_id, amount, status, paid_at) VALUES (?, ?, ?, 'succeeded', ?) " +
                "ON DUPLICATE KEY UPDATE status = 'succeeded', paid_at = ?";
        try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
            pstmt.setString(1, stripeInvoiceId);
            pstmt.setString(2, customerId);
            pstmt.setLong(3, amount);
            pstmt.setTimestamp(4, Timestamp.from(Instant.now()));
            pstmt.setTimestamp(5, Timestamp.from(Instant.now()));
            pstmt.executeUpdate();
        }

        // Log: Audit
        logAudit("payment_succeeded", customerId, null, stripeInvoiceId, null, null, null, amount, null, null);
    }

    private void processPaymentFailed(JsonObject event) throws SQLException {
        JsonObject data = event.getAsJsonObject("data");
        JsonObject invoiceObj = data.getAsJsonObject("object");
        String stripeInvoiceId = invoiceObj.get("id").getAsString();
        String customerId = invoiceObj.get("customer").getAsString();
        String reason = invoiceObj.has("failure_reason") ? invoiceObj.get("failure_reason").getAsString() : "unknown";

        // DB: Update subscription status to past_due
        String sql = "UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE customer_id = ? AND status != 'cancelled'";
        try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
            pstmt.setTimestamp(1, Timestamp.from(Instant.now()));
            pstmt.setString(2, customerId);
            pstmt.executeUpdate();
        }

        // Log: Audit
        logAudit("payment_failed", customerId, null, stripeInvoiceId, null, null, null, null, reason, null);
    }

    private void processSubscriptionUpdated(JsonObject event) throws SQLException {
        JsonObject data = event.getAsJsonObject("data");
        JsonObject subObj = data.getAsJsonObject("object");
        String stripeSubId = subObj.get("id").getAsString();
        String customerId = subObj.get("customer").getAsString();
        String status = subObj.get("status").getAsString();

        // Get new tier from items
        String newTier = null;
        if (subObj.has("items") && subObj.getAsJsonArray("items").size() > 0) {
            JsonObject item = subObj.getAsJsonArray("items").get(0).getAsJsonObject();
            if (item.has("price")) {
                JsonObject price = item.getAsJsonObject("price");
                if (price.has("lookup_key")) {
                    newTier = price.get("lookup_key").getAsString();
                }
            }
        }

        // Get old tier
        String oldTier = null;
        String checkSql = "SELECT tier FROM subscriptions WHERE stripe_subscription_id = ?";
        try (PreparedStatement pstmt = connection.prepareStatement(checkSql)) {
            pstmt.setString(1, stripeSubId);
            ResultSet rs = pstmt.executeQuery();
            if (rs.next()) {
                oldTier = rs.getString("tier");
            }
        }

        // DB: Update subscription
        String updateSql = "UPDATE subscriptions SET tier = ?, status = ?, updated_at = ? WHERE stripe_subscription_id = ?";
        try (PreparedStatement pstmt = connection.prepareStatement(updateSql)) {
            pstmt.setString(1, newTier);
            pstmt.setString(2, status);
            pstmt.setTimestamp(3, Timestamp.from(Instant.now()));
            pstmt.setString(4, stripeSubId);
            pstmt.executeUpdate();
        }

        // Log: Audit
        logAudit("subscription_updated", customerId, stripeSubId, null, null, oldTier, newTier, null, null, null);
    }

    private void processSubscriptionDeleted(JsonObject event) throws SQLException {
        JsonObject data = event.getAsJsonObject("data");
        JsonObject subObj = data.getAsJsonObject("object");
        String stripeSubId = subObj.get("id").getAsString();
        String customerId = subObj.get("customer").getAsString();

        // DB: Update subscription status to cancelled
        String sql = "UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE stripe_subscription_id = ?";
        try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
            pstmt.setTimestamp(1, Timestamp.from(Instant.now()));
            pstmt.setTimestamp(2, Timestamp.from(Instant.now()));
            pstmt.setString(3, stripeSubId);
            pstmt.executeUpdate();
        }

        // Log: Audit
        logAudit("subscription_cancelled", customerId, stripeSubId, null, null, null, null, null, null, null);
    }

    private void logAudit(String action, String customerId, String subscriptionId, String invoiceId,
                          String tier, String oldTier, String newTier, Long amount, String reason, Long prorationCredits) throws SQLException {
        String sql = "INSERT INTO audit_log (action, customer_id, subscription_id, invoice_id, tier, old_tier, new_tier, amount, reason, proration_credits, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        try (PreparedStatement pstmt = connection.prepareStatement(sql)) {
            pstmt.setString(1, action);
            pstmt.setString(2, customerId);
            pstmt.setString(3, subscriptionId);
            pstmt.setString(4, invoiceId);
            pstmt.setString(5, tier);
            pstmt.setString(6, oldTier);
            pstmt.setString(7, newTier);
            if (amount != null) pstmt.setLong(8, amount); else pstmt.setNull(8, Types.BIGINT);
            pstmt.setString(9, reason);
            if (prorationCredits != null) pstmt.setLong(10, prorationCredits); else pstmt.setNull(10, Types.BIGINT);
            pstmt.setTimestamp(11, Timestamp.from(Instant.now()));
            pstmt.executeUpdate();
        }
    }

    private JsonObject errorResponse(String code, String message) {
        JsonObject response = new JsonObject();
        response.addProperty("error", code);
        response.addProperty("message", message);
        return response;
    }
}