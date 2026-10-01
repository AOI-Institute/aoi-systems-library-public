import java.util.*;
import java.time.Instant;
import java.util.Base64;

public class webhooks_java_tests {
    public static void main(String[] args) {
        try {
            testSignVerifyRoundTrip();
            testChangedBodyFailsVerify();
            testChangedTimestampFailsVerify();
            testTimestampOlderThanTolerance();
            testSpaceSeparatedSignatures();
            testDeliverySuccessAndRetry();
            testWebhookIdAcrossRetries();
            testGeneratedSecretFormat();
            System.out.println("All tests passed");
        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }

    /* ---------- Test Helpers ---------- */

    private static Webhooks createWebhooksWithFakeSender() {
        Webhooks.InMemoryStorage storage = new Webhooks.InMemoryStorage();
        Webhooks.Sender fakeSender = new Webhooks.Sender() {
            @Override
            public int send(String url, Map<String, String> headers, String body) throws Exception {
                return 200;
            }
        };
        return new Webhooks(storage, fakeSender);
    }

    /* ---------- Tests ---------- */

    private static void testSignVerifyRoundTrip() {
        Webhooks webhooks = createWebhooksWithFakeSender();
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String secret = ep.get("secret");
        String msgId = "msg_abcdef";
        long ts = Instant.now().getEpochSecond();
        String body = "{\"order_id\":123}";
        String signature = webhooks.sign(secret, msgId, ts, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("webhook-id", msgId);
        headers.put("webhook-timestamp", Long.toString(ts));
        headers.put("webhook-signature", signature);
        boolean ok = webhooks.verify(secret, headers, body, 300);
        assert ok : "Sign/verify round-trip failed";
    }

    private static void testChangedBodyFailsVerify() {
        Webhooks webhooks = createWebhooksWithFakeSender();
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String secret = ep.get("secret");
        String msgId = "msg_abcdef";
        long ts = Instant.now().getEpochSecond();
        String body = "{\"order_id\":123}";
        String signature = webhooks.sign(secret, msgId, ts, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("webhook-id", msgId);
        headers.put("webhook-timestamp", Long.toString(ts));
        headers.put("webhook-signature", signature);
        boolean ok = webhooks.verify(secret, headers, body + "x", 300);
        assert !ok : "Changed body should fail verification";
    }

    private static void testChangedTimestampFailsVerify() {
        Webhooks webhooks = createWebhooksWithFakeSender();
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String secret = ep.get("secret");
        String msgId = "msg_abcdef";
        long ts = Instant.now().getEpochSecond();
        String body = "{\"order_id\":123}";
        String signature = webhooks.sign(secret, msgId, ts, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("webhook-id", msgId);
        headers.put("webhook-timestamp", Long.toString(ts + 1000));
        headers.put("webhook-signature", signature);
        boolean ok = webhooks.verify(secret, headers, body, 300);
        assert !ok : "Changed timestamp should fail verification";
    }

    private static void testTimestampOlderThanTolerance() {
        Webhooks webhooks = createWebhooksWithFakeSender();
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String secret = ep.get("secret");
        String msgId = "msg_abcdef";
        long ts = Instant.now().getEpochSecond() - 1000;
        String body = "{\"order_id\":123}";
        String signature = webhooks.sign(secret, msgId, ts, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("webhook-id", msgId);
        headers.put("webhook-timestamp", Long.toString(ts));
        headers.put("webhook-signature", signature);
        boolean ok = webhooks.verify(secret, headers, body, 300);
        assert !ok : "Timestamp older than tolerance should fail";
    }

    private static void testSpaceSeparatedSignatures() {
        Webhooks webhooks = createWebhooksWithFakeSender();
        Map<String, String> ep1 = webhooks.createEndpoint("org1", "https://example.com/webhook1", Arrays.asList("order.created"));
        Map<String, String> ep2 = webhooks.createEndpoint("org1", "https://example.com/webhook2", Arrays.asList("order.created"));
        String secret1 = ep1.get("secret");
        String secret2 = ep2.get("secret");
        String msgId = "msg_abcdef";
        long ts = Instant.now().getEpochSecond();
        String body = "{\"order_id\":123}";
        String sig1 = webhooks.sign(secret1, msgId, ts, body);
        String sig2 = webhooks.sign(secret2, msgId, ts, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("webhook-id", msgId);
        headers.put("webhook-timestamp", Long.toString(ts));
        headers.put("webhook-signature", sig1 + " " + sig2);
        boolean ok = webhooks.verify(secret1, headers, body, 300);
        assert ok : "Should accept if any signature matches";
    }

    private static void testDeliverySuccessAndRetry() {
        Webhooks.InMemoryStorage storage = new Webhooks.InMemoryStorage();
        Webhooks.Sender fakeSender = new Webhooks.Sender() {
            private int callCount = 0;
            @Override
            public int send(String url, Map<String, String> headers, String body) throws Exception {
                callCount++;
                if (callCount == 1) return 400;
                if (callCount == 2) return 301;
                if (callCount == 3) return 500;
                return 200;
            }
        };
        Webhooks webhooks = new Webhooks(storage, fakeSender);
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String msgId = webhooks.sendEvent("order.created", "{\"order_id\":123}");
        List<Webhooks.WebhookDelivery> deliveries = storage.listDeliveriesByMessage(msgId);
        assert deliveries.size() == 1 : "One delivery should be created";
        Webhooks.WebhookDelivery delivery = deliveries.get(0);

        // First attempt: 400 -> failure, retry scheduled
        webhooks.deliver(delivery);
        assert !delivery.success : "First attempt (400) should fail";
        assert delivery.statusCode == 400 : "Status code should be 400";
        assert delivery.nextAttemptAt != null : "Next attempt should be scheduled";

        // Second attempt: 301 -> failure, retry scheduled
        webhooks.deliver(delivery);
        assert !delivery.success : "Second attempt (301) should fail";
        assert delivery.statusCode == 301 : "Status code should be 301";
        assert delivery.nextAttemptAt != null : "Next attempt should be scheduled";

        // Third attempt: 500 -> failure, retry scheduled
        webhooks.deliver(delivery);
        assert !delivery.success : "Third attempt (500) should fail";
        assert delivery.statusCode == 500 : "Status code should be 500";
        assert delivery.nextAttemptAt != null : "Next attempt should be scheduled";

        // Fourth attempt: 200 -> success
        webhooks.deliver(delivery);
        assert delivery.success : "Fourth attempt (200) should succeed";
        assert delivery.statusCode == 200 : "Status code should be 200";
        assert delivery.deliveredAt != null : "DeliveredAt should be set";
    }

    private static void testWebhookIdAcrossRetries() {
        Webhooks.InMemoryStorage storage = new Webhooks.InMemoryStorage();
        Webhooks.Sender fakeSender = new Webhooks.Sender() {
            @Override
            public int send(String url, Map<String, String> headers, String body) throws Exception {
                return 200;
            }
        };
        Webhooks webhooks = new Webhooks(storage, fakeSender);
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String msgId = webhooks.sendEvent("order.created", "{\"order_id\":123}");
        List<Webhooks.WebhookDelivery> deliveries = storage.listDeliveriesByMessage(msgId);
        Webhooks.WebhookDelivery delivery = deliveries.get(0);
        String originalDeliveryId = delivery.id;

        // First delivery
        webhooks.deliver(delivery);
        assert delivery.id.equals(originalDeliveryId) : "Delivery ID should remain the same";

        // Simulate retry by incrementing attempt on same delivery object
        delivery.attempt = 2;
        webhooks.deliver(delivery);
        assert delivery.id.equals(originalDeliveryId) : "Webhook-id should be identical across retries";

        // Another retry
        delivery.attempt = 3;
        webhooks.deliver(delivery);
        assert delivery.id.equals(originalDeliveryId) : "Webhook-id should be identical across retries";
    }

    private static void testGeneratedSecretFormat() {
        Webhooks webhooks = createWebhooksWithFakeSender();
        Map<String, String> ep = webhooks.createEndpoint("org1", "https://example.com/webhook", Arrays.asList("order.created"));
        String secret = ep.get("secret");
        assert secret.startsWith("whsec_") : "Secret should start with whsec_";
        String b64 = secret.substring(6);
        byte[] decoded = Base64.getDecoder().decode(b64);
        assert decoded.length >= 24 && decoded.length <= 64 : "Secret length should be 24-64 bytes, got " + decoded.length;
    }
}