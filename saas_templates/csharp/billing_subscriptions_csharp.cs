using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Stripe;
using Stripe.Checkout;

namespace BillingSubscriptions
{
    // ---------- Database Models ----------
    public class Subscription
    {
        public int Id { get; set; }
        public string StripeSubscriptionId { get; set; }
        public string CustomerId { get; set; }
        public string Tier { get; set; }
        public string Status { get; set; } // active, suspended, cancelled, past_due
        public DateTime CreatedAt { get; set; }
        public DateTime? UpdatedAt { get; set; }
        public DateTime? CancelledAt { get; set; }
    }

    public class Invoice
    {
        public int Id { get; set; }
        public string StripeInvoiceId { get; set; }
        public string CustomerId { get; set; }
        public long Amount { get; set; } // amount in cents
        public string Status { get; set; } // succeeded, failed, pending
        public DateTime? PaidAt { get; set; }
    }

    public class Refund
    {
        public int Id { get; set; }
        public string InvoiceId { get; set; }
        public long Amount { get; set; }
        public string Status { get; set; } // queued, processed
        public string Reason { get; set; }
        public string CreatedBy { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? ExecutedAt { get; set; }
    }

    public class EventRecord
    {
        public int Id { get; set; }
        public string StripeEventId { get; set; }
        public string EventType { get; set; }
        public DateTime ProcessedAt { get; set; }
    }

    public class AuditLog
    {
        public int Id { get; set; }
        public string Action { get; set; }
        public string Details { get; set; }
        public DateTime LoggedAt { get; set; }
    }

    // ---------- DbContext ----------
    public class BillingContext : DbContext
    {
        public DbSet<Subscription> Subscriptions => Set<Subscription>();
        public DbSet<Invoice> Invoices => Set<Invoice>();
        public DbSet<Refund> Refunds => Set<Refund>();
        public DbSet<EventRecord> Events => Set<EventRecord>();
        public DbSet<AuditLog> AuditLogs => Set<AuditLog>();

        public BillingContext(DbContextOptions<BillingContext> options) : base(options) { }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Subscription>()
                .HasIndex(s => s.StripeSubscriptionId)
                .IsUnique();

            modelBuilder.Entity<Invoice>()
                .HasIndex(i => i.StripeInvoiceId)
                .IsUnique();

            modelBuilder.Entity<EventRecord>()
                .HasIndex(e => e.StripeEventId)
                .IsUnique();

            // DDL for reference (executed via EnsureCreated if needed)
            // CREATE TABLE subscriptions (...);
            // CREATE TABLE invoices (...);
            // CREATE TABLE refunds (...);
            // CREATE TABLE events (...);
            // CREATE TABLE audit_logs (...);
        }
    }

    // ---------- Stripe Wrapper ----------
    public interface IStripeService
    {
        Task<Subscription> CreateSubscriptionAsync(string customerId, string priceId);
        Task<Subscription> UpdateSubscriptionAsync(string subscriptionId, string newPriceId);
        Task<Invoice> RetrieveInvoiceAsync(string invoiceId);
    }

    public class StripeService : IStripeService
    {
        private readonly StripeClient _client;

        public StripeService()
        {
            var secretKey = Environment.GetEnvironmentVariable("STRIPE_SECRET_KEY")
                ?? throw new InvalidOperationException("STRIPE_SECRET_KEY not set");
            _client = new StripeClient(secretKey);
        }

        public async Task<Subscription> CreateSubscriptionAsync(string customerId, string priceId)
        {
            var options = new SubscriptionCreateOptions
            {
                Customer = customerId,
                Items = new List<SubscriptionItemOptions>
                {
                    new SubscriptionItemOptions { Price = priceId }
                }
            };
            var service = new SubscriptionService(_client);
            var stripeSub = await service.CreateAsync(options);
            return stripeSub;
        }

        public async Task<Subscription> UpdateSubscriptionAsync(string subscriptionId, string newPriceId)
        {
            var options = new SubscriptionUpdateOptions
            {
                Items = new List<SubscriptionItemOptions>
                {
                    new SubscriptionItemOptions { Price = newPriceId }
                }
            };
            var service = new SubscriptionService(_client);
            var stripeSub = await service.UpdateAsync(subscriptionId, options);
            return stripeSub;
        }

        public async Task<Invoice> RetrieveInvoiceAsync(string invoiceId)
        {
            var service = new InvoiceService(_client);
            var stripeInvoice = await service.GetAsync(invoiceId);
            return stripeInvoice;
        }
    }

    // ---------- Response DTOs ----------
    public class ApiResponse
    {
        public bool Success { get; set; }
        public object Data { get; set; }
        public ApiError Error { get; set; }
    }

    public class ApiError
    {
        public string Code { get; set; }
        public string Message { get; set; }
    }

    public class CreateSubscriptionResult
    {
        public string SubscriptionId { get; set; }
        public string Tier { get; set; }
        public string Status { get; set; }
        public string NextBillingDate { get; set; }
    }

    public class ChangePlanResult
    {
        public string SubscriptionId { get; set; }
        public string OldTier { get; set; }
        public string NewTier { get; set; }
        public string EffectiveDate { get; set; }
        public long ProrationCredit { get; set; }
    }

    public class QueueRefundResult
    {
        public int RefundId { get; set; }
        public string Status { get; set; }
        public long Amount { get; set; }
        public string Reason { get; set; }
    }

    public class WebhookResponse
    {
        public bool Received { get; set; } = true;
    }

    // ---------- Billing Service ----------
    public class BillingService
    {
        private readonly BillingContext _db;
        private readonly IStripeService _stripe;
        private readonly ILogger<BillingService> _logger;
        private readonly Dictionary<string, string> _priceIds = new Dictionary<string, string>
        {
            { "solo", "price_1UI_solo" },
            { "team", "price_1UI_team" },
            { "enterprise", "price_1UI_enterprise" }
        };
        private readonly string _webhookSecret;

        public BillingService(BillingContext db, IStripeService stripe, ILogger<BillingService> logger)
        {
            _db = db;
            _stripe = stripe;
            _logger = logger;
            _webhookSecret = Environment.GetEnvironmentVariable("STRIPE_WEBHOOK_SECRET")
                ?? throw new InvalidOperationException("STRIPE_WEBHOOK_SECRET not set");
        }

        // ---------- Helper ----------
        private void LogAudit(string action, string details)
        {
            _db.AuditLogs.Add(new AuditLog
            {
                Action = action,
                Details = details,
                LoggedAt = DateTime.UtcNow
            });
            _db.SaveChanges();
        }

        // ---------- 1. create_subscription ----------
        public async Task<ApiResponse> CreateSubscriptionAsync(string customerId, string tier)
        {
            if (!_priceIds.ContainsKey(tier))
            {
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "invalid_tier", Message = "Tier not recognized" }
                };
            }

            var priceId = _priceIds[tier];
            try
            {
                var stripeSub = await _stripe.CreateSubscriptionAsync(customerId, priceId);
                var subscription = new Subscription
                {
                    StripeSubscriptionId = stripeSub.Id,
                    CustomerId = customerId,
                    Tier = tier,
                    Status = "active",
                    CreatedAt = DateTime.UtcNow
                };
                _db.Subscriptions.Add(subscription);
                await _db.SaveChangesAsync();

                LogAudit("subscription_created",
                    JsonSerializer.Serialize(new { customerId, tier, stripe_sub_id = stripeSub.Id }));

                var result = new CreateSubscriptionResult
                {
                    SubscriptionId = stripeSub.Id,
                    Tier = tier,
                    Status = "active",
                    NextBillingDate = DateTimeOffset.FromUnixTimeSeconds(stripeSub.CurrentPeriodEnd).UtcDateTime.ToString("o")
                };

                return new ApiResponse { Success = true, Data = result };
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error creating subscription");
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "stripe_error", Message = ex.Message }
                };
            }
        }

        // ---------- 2. change_plan ----------
        public async Task<ApiResponse> ChangePlanAsync(string subscriptionId, string newTier)
        {
            if (!_priceIds.ContainsKey(newTier))
            {
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "invalid_tier", Message = "Tier not recognized" }
                };
            }

            var subscription = await _db.Subscriptions.FirstOrDefaultAsync(s => s.StripeSubscriptionId == subscriptionId);
            if (subscription == null)
            {
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "not_found", Message = "Subscription not found" }
                };
            }

            var oldTier = subscription.Tier;
            var newPriceId = _priceIds[newTier];
            try
            {
                var stripeSub = await _stripe.UpdateSubscriptionAsync(subscriptionId, newPriceId);
                subscription.Tier = newTier;
                subscription.UpdatedAt = DateTime.UtcNow;
                await _db.SaveChangesAsync();

                // Proration credit calculation (simplified: use stripe's latest_invoice)
                long prorationCredit = 0;
                if (stripeSub.LatestInvoice?.AmountRefunded != null)
                {
                    prorationCredit = stripeSub.LatestInvoice.AmountRefunded.Value;
                }

                LogAudit("plan_changed",
                    JsonSerializer.Serialize(new { subscription_id = subscriptionId, old_tier = oldTier, new_tier = newTier, proration_credits = prorationCredit }));

                var result = new ChangePlanResult
                {
                    SubscriptionId = subscriptionId,
                    OldTier = oldTier,
                    NewTier = newTier,
                    EffectiveDate = DateTimeOffset.FromUnixTimeSeconds(stripeSub.CurrentPeriodStart).UtcDateTime.ToString("o"),
                    ProrationCredit = prorationCredit
                };

                return new ApiResponse { Success = true, Data = result };
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error changing plan");
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "stripe_error", Message = ex.Message }
                };
            }
        }

        // ---------- 3. queue_refund ----------
        public async Task<ApiResponse> QueueRefundAsync(string invoiceId, long amount, string reason, string createdBy)
        {
            var stripeInvoice = await _stripe.RetrieveInvoiceAsync(invoiceId);
            if (stripeInvoice == null || stripeInvoice.Status != "paid")
            {
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "invalid_invoice", Message = "Invoice not found or not succeeded" }
                };
            }

            if (amount > stripeInvoice.AmountPaid)
            {
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "refund_exceeds_invoice", Message = "Refund amount exceeds invoice total" }
                };
            }

            var refund = new Refund
            {
                InvoiceId = invoiceId,
                Amount = amount,
                Reason = reason,
                Status = "queued",
                CreatedBy = createdBy,
                CreatedAt = DateTime.UtcNow
            };
            _db.Refunds.Add(refund);
            await _db.SaveChangesAsync();

            LogAudit("refund_queued",
                JsonSerializer.Serialize(new { invoice_id = invoiceId, amount, reason }));

            var result = new QueueRefundResult
            {
                RefundId = refund.Id,
                Status = "queued",
                Amount = amount,
                Reason = reason
            };

            return new ApiResponse { Success = true, Data = result };
        }

        // ---------- 4. handle_stripe_webhook ----------
        public async Task<ApiResponse> HandleStripeWebhookAsync(string jsonPayload, string stripeSignatureHeader)
        {
            Event stripeEvent;
            try
            {
                stripeEvent = EventUtility.ConstructEvent(jsonPayload, stripeSignatureHeader, _webhookSecret);
            }
            catch (Exception)
            {
                return new ApiResponse
                {
                    Success = false,
                    Error = new ApiError { Code = "invalid_signature", Message = "Webhook signature verification failed" }
                };
            }

            // Idempotency check
            var existingEvent = await _db.Events.FirstOrDefaultAsync(e => e.StripeEventId == stripeEvent.Id);
            if (existingEvent != null)
            {
                // Already processed
                return new ApiResponse { Success = true, Data = new WebhookResponse() };
            }

            // Record event as processed early to avoid race conditions
            var eventRecord = new EventRecord
            {
                StripeEventId = stripeEvent.Id,
                EventType = stripeEvent.Type,
                ProcessedAt = DateTime.UtcNow
            };
            _db.Events.Add(eventRecord);
            await _db.SaveChangesAsync();

            // Process based on type
            switch (stripeEvent.Type)
            {
                case "invoice.payment_succeeded":
                    {
                        var invoice = stripeEvent.Data.Object as Stripe.Invoice;
                        var dbInvoice = new Invoice
                        {
                            StripeInvoiceId = invoice.Id,
                            CustomerId = invoice.CustomerId,
                            Amount = invoice.AmountPaid ?? 0,
                            Status = "succeeded",
                            PaidAt = DateTimeOffset.FromUnixTimeSeconds(invoice.StatusTransitions?.PaidAt ?? 0).UtcDateTime
                        };
                        _db.Invoices.Add(dbInvoice);
                        await _db.SaveChangesAsync();

                        LogAudit("payment_succeeded",
                            JsonSerializer.Serialize(new { customer_id = invoice.CustomerId, invoice_id = invoice.Id, amount = invoice.AmountPaid }));
                        break;
                    }
                case "invoice.payment_failed":
                    {
                        var invoice = stripeEvent.Data.Object as Stripe.Invoice;
                        var subscription = await _db.Subscriptions.FirstOrDefaultAsync(s => s.StripeSubscriptionId == invoice.SubscriptionId);
                        if (subscription != null && subscription.Status != "past_due")
                        {
                            subscription.Status = "past_due";
                            subscription.UpdatedAt = DateTime.UtcNow;
                            await _db.SaveChangesAsync();
                        }

                        LogAudit("payment_failed",
                            JsonSerializer.Serialize(new { customer_id = invoice.CustomerId, invoice_id = invoice.Id, reason = invoice.StatusTransition?.FailedAt }));
                        break;
                    }
                case "customer.subscription.updated":
                    {
                        var stripeSub = stripeEvent.Data.Object as Stripe.Subscription;
                        var subscription = await _db.Subscriptions.FirstOrDefaultAsync(s => s.StripeSubscriptionId == stripeSub.Id);
                        if (subscription != null)
                        {
                            var oldTier = subscription.Tier;
                            var newTier = stripeSub.Items.Data.FirstOrDefault()?.Price?.LookupKey ?? oldTier;
                            subscription.Tier = newTier;
                            subscription.Status = stripeSub.Status;
                            subscription.UpdatedAt = DateTime.UtcNow;
                            await _db.SaveChangesAsync();

                            LogAudit("subscription_updated",
                                JsonSerializer.Serialize(new { customer_id = stripeSub.CustomerId, old_tier = oldTier, new_tier = newTier }));
                        }
                        break;
                    }
                case "customer.subscription.deleted":
                    {
                        var stripeSub = stripeEvent.Data.Object as Stripe.Subscription;
                        var subscription = await _db.Subscriptions.FirstOrDefaultAsync(s => s.StripeSubscriptionId == stripeSub.Id);
                        if (subscription != null)
                        {
                            subscription.Status = "cancelled";
                            subscription.CancelledAt = DateTime.UtcNow;
                            subscription.UpdatedAt = DateTime.UtcNow;
                            await _db.SaveChangesAsync();

                            LogAudit("subscription_cancelled",
                                JsonSerializer.Serialize(new { customer_id = stripeSub.CustomerId }));
                        }
                        break;
                    }
                default:
                    // Unhandled event types are ignored but logged
                    LogAudit("unhandled_event",
                        JsonSerializer.Serialize(new { event_type = stripeEvent.Type }));
                    break;
            }

            return new ApiResponse { Success = true, Data = new WebhookResponse() };
        }
    }
}