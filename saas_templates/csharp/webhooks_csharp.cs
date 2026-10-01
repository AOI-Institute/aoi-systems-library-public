using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AOI.Webhooks
{
    // ---------- Store Interfaces ----------
    public interface IStore
    {
        Endpoint AddEndpoint(string orgId, string url, IEnumerable<string> eventTypes);
        Endpoint GetEndpoint(string endpointId);
        IEnumerable<Endpoint> GetActiveEndpoints(string orgId, string eventType);
        void UpdateEndpoint(Endpoint endpoint);

        Message AddMessage(string orgId, string eventType, string payload);
        Message GetMessage(string messageId);

        Delivery AddDelivery(string messageId, string endpointId);
        Delivery GetDelivery(int deliveryId);
        IEnumerable<Delivery> GetPendingDeliveries(DateTimeOffset now);
        void UpdateDelivery(Delivery delivery);
    }

    // ---------- In‑Memory Store ----------
    public class InMemoryStore : IStore
    {
        private readonly Dictionary<string, Endpoint> _endpoints = new();
        private readonly Dictionary<string, Message> _messages = new();
        private readonly Dictionary<int, Delivery> _deliveries = new();
        private int _deliverySeq = 1;

        public Endpoint AddEndpoint(string orgId, string url, IEnumerable<string> eventTypes)
        {
            var secretBytes = new byte[32];
            RandomNumberGenerator.Fill(secretBytes);
            var secret = "whsec_" + Convert.ToBase64String(secretBytes);
            var ep = new Endpoint
            {
                Id = Guid.NewGuid().ToString(),
                OrgId = orgId,
                Url = url,
                Secret = secret,
                EventTypes = new HashSet<string>(eventTypes),
                Active = true,
                FailureCount = 0,
                CreatedAt = DateTimeOffset.UtcNow
            };
            _endpoints[ep.Id] = ep;
            return ep;
        }

        public Endpoint GetEndpoint(string endpointId) => _endpoints[endpointId];

        public IEnumerable<Endpoint> GetActiveEndpoints(string orgId, string eventType) =>
            _endpoints.Values.Where(e => e.Active && e.OrgId == orgId && e.EventTypes.Contains(eventType));

        public void UpdateEndpoint(Endpoint endpoint) => _endpoints[endpoint.Id] = endpoint;

        public Message AddMessage(string orgId, string eventType, string payload)
        {
            var msg = new Message
            {
                Id = "msg_" + Guid.NewGuid().ToString("N"),
                OrgId = orgId,
                EventType = eventType,
                Payload = payload,
                CreatedAt = DateTimeOffset.UtcNow
            };
            _messages[msg.Id] = msg;
            return msg;
        }

        public Message GetMessage(string messageId) => _messages[messageId];

        public Delivery AddDelivery(string messageId, string endpointId)
        {
            var del = new Delivery
            {
                Id = _deliverySeq++,
                MessageId = messageId,
                EndpointId = endpointId,
                Attempt = 0,
                Success = false
            };
            _deliveries[del.Id] = del;
            return del;
        }

        public Delivery GetDelivery(int deliveryId) => _deliveries[deliveryId];

        public IEnumerable<Delivery> GetPendingDeliveries(DateTimeOffset now) =>
            _deliveries.Values.Where(d => !d.Success && (d.NextAttemptAt == null || d.NextAttemptAt <= now));

        public void UpdateDelivery(Delivery delivery) => _deliveries[delivery.Id] = delivery;
    }

    // ---------- Data Models ----------
    public class Endpoint
    {
        public string Id { get; set; }
        public string OrgId { get; set; }
        public string Url { get; set; }
        public string Secret { get; set; }
        public HashSet<string> EventTypes { get; set; }
        public bool Active { get; set; }
        public int FailureCount { get; set; }
        public DateTimeOffset CreatedAt { get; set; }
    }

    public class Message
    {
        public string Id { get; set; }
        public string OrgId { get; set; }
        public string EventType { get; set; }
        public string Payload { get; set; } // raw JSON string
        public DateTimeOffset CreatedAt { get; set; }
    }

    public class Delivery
    {
        public int Id { get; set; }
        public string MessageId { get; set; }
        public string EndpointId { get; set; }
        public int Attempt { get; set; }
        public int? StatusCode { get; set; }
        public bool Success { get; set; }
        public string Error { get; set; }
        public DateTimeOffset? NextAttemptAt { get; set; }
        public DateTimeOffset? DeliveredAt { get; set; }
    }

    // ---------- Core Service ----------
    public static class WebhookService
    {
        // shared store for the whole process
        public static IStore Store { get; } = new InMemoryStore();

        private static readonly TimeSpan[] Backoff = new[]
        {
            TimeSpan.FromSeconds(5),
            TimeSpan.FromMinutes(5),
            TimeSpan.FromMinutes(30),
            TimeSpan.FromHours(2),
            TimeSpan.FromHours(5),
            TimeSpan.FromHours(10),
            TimeSpan.FromHours(10)
        };

        // Create endpoint and generate secret
        public static Endpoint CreateEndpoint(string orgId, string url, IEnumerable<string> eventTypes)
        {
            if (!url.StartsWith("https://") && !(url.StartsWith("http://localhost")))
                throw new ArgumentException("URL must be https:// or http://localhost for dev");
            return Store.AddEndpoint(orgId, url, eventTypes);
        }

        // Send event – creates message and pending deliveries
        public static Message SendEvent(string orgId, string eventType, JsonElement payload)
        {
            var payloadStr = payload.GetRawText();
            var msg = Store.AddMessage(orgId, eventType, payloadStr);
            var endpoints = Store.GetActiveEndpoints(orgId, eventType);
            foreach (var ep in endpoints)
            {
                Store.AddDelivery(msg.Id, ep.Id);
            }
            return msg;
        }

        // Sign according to spec
        public static string Sign(string secret, string msgId, long timestamp, string payload)
        {
            if (!secret.StartsWith("whsec_"))
                throw new ArgumentException("Invalid secret format");
            var keyB64 = secret.Substring("whsec_".Length);
            var key = Convert.FromBase64String(keyB64);
            var content = $"{msgId}.{timestamp}.{payload}";
            using var hmac = new HMACSHA256(key);
            var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(content));
            var sig = Convert.ToBase64String(hash);
            return $"v1,{sig}";
        }

        // Verify incoming webhook
        public static bool Verify(string secret, IDictionary<string, string> headers, string rawBody, int toleranceSeconds = 300)
        {
            if (!headers.TryGetValue("webhook-id", out var msgId) ||
                !headers.TryGetValue("webhook-timestamp", out var tsStr) ||
                !headers.TryGetValue("webhook-signature", out var sigHeader))
                return false;

            if (!long.TryParse(tsStr, out var timestamp))
                return false;

            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (Math.Abs(now - timestamp) > toleranceSeconds)
                return false;

            var signatures = sigHeader.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            foreach (var sig in signatures)
            {
                var expected = Sign(secret, msgId, timestamp, rawBody);
                // expected format is "v1,<base64>"
                var expectedSig = expected.Split(',')[1];
                var providedSig = sig.Split(',')[1];
                var expectedBytes = Encoding.UTF8.GetBytes(expectedSig);
                var providedBytes = Encoding.UTF8.GetBytes(providedSig);
                if (CryptographicOperations.FixedTimeEquals(expectedBytes, providedBytes))
                    return true;
            }
            return false;
        }

        // Deliver a single delivery using injectable sender
        // sender(url, headers, body) => (statusCode, responseBody)
        public static void Deliver(Delivery delivery,
            Func<string, Dictionary<string, string>, string, (int statusCode, string responseBody)> sender)
        {
            var endpoint = Store.GetEndpoint(delivery.EndpointId);
            var message = Store.GetMessage(delivery.MessageId);
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var signature = Sign(endpoint.Secret, message.Id, timestamp, message.Payload);
            var headers = new Dictionary<string, string>
            {
                { "webhook-id", message.Id },
                { "webhook-timestamp", timestamp.ToString() },
                { "webhook-signature", signature }
            };

            (int statusCode, string _) result;
            try
            {
                result = sender(endpoint.Url, headers, message.Payload);
            }
            catch
            {
                // treat exception as failure
                result = (0, null);
            }

            delivery.Attempt += 1;
            delivery.StatusCode = result.statusCode;
            delivery.Success = result.statusCode >= 200 && result.statusCode <= 299;
            delivery.DeliveredAt = DateTimeOffset.UtcNow;

            if (!delivery.Success)
            {
                // schedule retry
                var idx = Math.Min(delivery.Attempt - 1, Backoff.Length - 1);
                delivery.NextAttemptAt = DateTimeOffset.UtcNow.Add(Backoff[idx]);

                // endpoint failure handling
                endpoint.FailureCount += 1;
                if (endpoint.FailureCount >= 5)
                    endpoint.Active = false;
                Store.UpdateEndpoint(endpoint);
            }
            else
            {
                // reset failure count on success
                endpoint.FailureCount = 0;
                Store.UpdateEndpoint(endpoint);
            }

            Store.UpdateDelivery(delivery);
        }

        // Rotate secret for an endpoint
        public static string RotateSecret(string endpointId)
        {
            var endpoint = Store.GetEndpoint(endpointId);
            var secretBytes = new byte[32];
            RandomNumberGenerator.Fill(secretBytes);
            var newSecret = "whsec_" + Convert.ToBase64String(secretBytes);
            endpoint.Secret = newSecret;
            Store.UpdateEndpoint(endpoint);
            return newSecret;
        }
    }
}