using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using BillingSubscriptions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Moq;
using Stripe;
using Xunit;

namespace BillingSubscriptionsTests
{
    public class BillingServiceTests
    {
        private BillingContext GetInMemoryContext()
        {
            var options = new DbContextOptionsBuilder<BillingContext>()
                .UseInMemoryDatabase(Guid.NewGuid().ToString())
                .Options;
            var context = new BillingContext(options);
            context.Database.EnsureCreated();
            return context;
        }

        private ILogger<BillingService> GetLogger()
        {
            var mock = new Mock<ILogger<BillingService>>();
            return mock.Object;
        }

        // Helper to create a mock StripeService
        private Mock<IStripeService> GetMockStripeService()
        {
            return new Mock<IStripeService>();
        }

        [Fact]
        public async Task CreateSubscription_HappyPath()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var stripeSub = new Stripe.Subscription
            {
                Id = "sub_123",
                CurrentPeriodEnd = DateTimeOffset.UtcNow.AddMonths(1).ToUnixTimeSeconds()
            };
            stripeMock.Setup(s => s.CreateSubscriptionAsync("cust_1", It.IsAny<string>()))
                .ReturnsAsync(stripeSub);

            var service = new BillingService(ctx, stripeMock.Object, logger);
            var response = await service.CreateSubscriptionAsync("cust_1", "solo");

            Assert.True(response.Success);
            var data = Assert.IsType<CreateSubscriptionResult>(response.Data);
            Assert.Equal("sub_123", data.SubscriptionId);
            Assert.Equal("solo", data.Tier);
            Assert.Equal("active", data.Status);
            Assert.NotNull(data.NextBillingDate);

            var dbSub = await ctx.Subscriptions.FirstOrDefaultAsync(s => s.StripeSubscriptionId == "sub_123");
            Assert.NotNull(dbSub);
            Assert.Equal("solo", dbSub.Tier);
        }

        [Fact]
        public async Task CreateSubscription_InvalidTier()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var service = new BillingService(ctx, stripeMock.Object, logger);
            var response = await service.CreateSubscriptionAsync("cust_1", "invalid_tier");

            Assert.False(response.Success);
            Assert.Equal("invalid_tier", response.Error.Code);
        }

        [Fact]
        public async Task ChangePlan_HappyPath()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            // Seed subscription
            var sub = new Subscription
            {
                StripeSubscriptionId = "sub_123",
                CustomerId = "cust_1",
                Tier = "solo",
                Status = "active",
                CreatedAt = DateTime.UtcNow
            };
            ctx.Subscriptions.Add(sub);
            await ctx.SaveChangesAsync();

            var stripeSub = new Stripe.Subscription
            {
                Id = "sub_123",
                CurrentPeriodStart = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                LatestInvoice = new Stripe.Invoice { AmountRefunded = 0 }
            };
            stripeMock.Setup(s => s.UpdateSubscriptionAsync("sub_123", It.IsAny<string>()))
                .ReturnsAsync(stripeSub);

            var service = new BillingService(ctx, stripeMock.Object, logger);
            var response = await service.ChangePlanAsync("sub_123", "team");

            Assert.True(response.Success);
            var data = Assert.IsType<ChangePlanResult>(response.Data);
            Assert.Equal("sub_123", data.SubscriptionId);
            Assert.Equal("solo", data.OldTier);
            Assert.Equal("team", data.NewTier);
            Assert.NotNull(data.EffectiveDate);
            Assert.Equal(0, data.ProrationCredit);

            var dbSub = await ctx.Subscriptions.FirstAsync(s => s.StripeSubscriptionId == "sub_123");
            Assert.Equal("team", dbSub.Tier);
        }

        [Fact]
        public async Task QueueRefund_HappyPath()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var stripeInvoice = new Stripe.Invoice
            {
                Id = "in_123",
                AmountPaid = 5000,
                Status = "paid"
            };
            stripeMock.Setup(s => s.RetrieveInvoiceAsync("in_123"))
                .ReturnsAsync(stripeInvoice);

            var service = new BillingService(ctx, stripeMock.Object, logger);
            var response = await service.QueueRefundAsync("in_123", 3000, "Customer request", "admin_user");

            Assert.True(response.Success);
            var data = Assert.IsType<QueueRefundResult>(response.Data);
            Assert.Equal("queued", data.Status);
            Assert.Equal(3000, data.Amount);
            Assert.Equal("Customer request", data.Reason);
            Assert.True(data.RefundId > 0);

            var dbRefund = await ctx.Refunds.FirstAsync(r => r.Id == data.RefundId);
            Assert.Equal("queued", dbRefund.Status);
            Assert.Equal(3000, dbRefund.Amount);
        }

        [Fact]
        public async Task QueueRefund_AmountExceedsInvoice()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var stripeInvoice = new Stripe.Invoice
            {
                Id = "in_123",
                AmountPaid = 2000,
                Status = "paid"
            };
            stripeMock.Setup(s => s.RetrieveInvoiceAsync("in_123"))
                .ReturnsAsync(stripeInvoice);

            var service = new BillingService(ctx, stripeMock.Object, logger);
            var response = await service.QueueRefundAsync("in_123", 3000, "Too much", "admin_user");

            Assert.False(response.Success);
            Assert.Equal("refund_exceeds_invoice", response.Error.Code);
        }

        [Fact]
        public async Task HandleWebhook_PaymentSucceeded()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var service = new BillingService(ctx, stripeMock.Object, logger);

            var stripeEvent = new Event
            {
                Id = "evt_1",
                Type = "invoice.payment_succeeded",
                Data = new EventData
                {
                    Object = new Stripe.Invoice
                    {
                        Id = "in_123",
                        CustomerId = "cust_1",
                        AmountPaid = 5000,
                        StatusTransitions = new InvoiceStatusTransitions { PaidAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() }
                    }
                }
            };
            var json = JsonSerializer.Serialize(stripeEvent);
            // Simulate valid signature by bypassing verification (set secret to empty)
            Environment.SetEnvironmentVariable("STRIPE_WEBHOOK_SECRET", "");

            var response = await service.HandleStripeWebhookAsync(json, "dummy_signature");
            Assert.True(response.Success);
            var webhookResp = Assert.IsType<WebhookResponse>(response.Data);
            Assert.True(webhookResp.Received);

            var dbInvoice = await ctx.Invoices.FirstAsync(i => i.StripeInvoiceId == "in_123");
            Assert.Equal("succeeded", dbInvoice.Status);
            Assert.Equal(5000, dbInvoice.Amount);
        }

        [Fact]
        public async Task HandleWebhook_DuplicateEvent_Idempotent()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var service = new BillingService(ctx, stripeMock.Object, logger);

            var stripeEvent = new Event
            {
                Id = "evt_dup",
                Type = "invoice.payment_succeeded",
                Data = new EventData
                {
                    Object = new Stripe.Invoice
                    {
                        Id = "in_123",
                        CustomerId = "cust_1",
                        AmountPaid = 5000,
                        StatusTransitions = new InvoiceStatusTransitions { PaidAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() }
                    }
                }
            };
            var json = JsonSerializer.Serialize(stripeEvent);
            Environment.SetEnvironmentVariable("STRIPE_WEBHOOK_SECRET", "");

            // First call
            var first = await service.HandleStripeWebhookAsync(json, "sig");
            Assert.True(first.Success);

            // Second call (duplicate)
            var second = await service.HandleStripeWebhookAsync(json, "sig");
            Assert.True(second.Success);
            var webhookResp = Assert.IsType<WebhookResponse>(second.Data);
            Assert.True(webhookResp.Received);

            // Ensure only one invoice record
            var invoices = await ctx.Invoices.ToListAsync();
            Assert.Single(invoices);
        }

        [Fact]
        public async Task HandleWebhook_SubscriptionUpdated()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            // Seed existing subscription
            ctx.Subscriptions.Add(new Subscription
            {
                StripeSubscriptionId = "sub_123",
                CustomerId = "cust_1",
                Tier = "solo",
                Status = "active",
                CreatedAt = DateTime.UtcNow
            });
            await ctx.SaveChangesAsync();

            var service = new BillingService(ctx, stripeMock.Object, logger);

            var stripeEvent = new Event
            {
                Id = "evt_upd",
                Type = "customer.subscription.updated",
                Data = new EventData
                {
                    Object = new Stripe.Subscription
                    {
                        Id = "sub_123",
                        CustomerId = "cust_1",
                        Status = "active",
                        Items = new StripeList<SubscriptionItem>
                        {
                            Data = new List<SubscriptionItem>
                            {
                                new SubscriptionItem
                                {
                                    Price = new Price { LookupKey = "team" }
                                }
                            }
                        }
                    }
                }
            };
            var json = JsonSerializer.Serialize(stripeEvent);
            Environment.SetEnvironmentVariable("STRIPE_WEBHOOK_SECRET", "");

            var response = await service.HandleStripeWebhookAsync(json, "sig");
            Assert.True(response.Success);

            var sub = await ctx.Subscriptions.FirstAsync(s => s.StripeSubscriptionId == "sub_123");
            Assert.Equal("team", sub.Tier);
            Assert.Equal("active", sub.Status);
        }

        [Fact]
        public async Task HandleWebhook_InvalidSignature()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var service = new BillingService(ctx, stripeMock.Object, logger);
            Environment.SetEnvironmentVariable("STRIPE_WEBHOOK_SECRET", "whsec_test");

            var response = await service.HandleStripeWebhookAsync("{}", "invalid_signature");
            Assert.False(response.Success);
            Assert.Equal("invalid_signature", response.Error.Code);
        }

        [Fact]
        public async Task Webhook_ResponseTime_UnderThreeSeconds()
        {
            var ctx = GetInMemoryContext();
            var logger = GetLogger();
            var stripeMock = GetMockStripeService();

            var service = new BillingService(ctx, stripeMock.Object, logger);
            Environment.SetEnvironmentVariable("STRIPE_WEBHOOK_SECRET", "");

            var stripeEvent = new Event
            {
                Id = "evt_time",
                Type = "invoice.payment_succeeded",
                Data = new EventData
                {
                    Object = new Stripe.Invoice
                    {
                        Id = "in_123",
                        CustomerId = "cust_1",
                        AmountPaid = 1000,
                        StatusTransitions = new InvoiceStatusTransitions { PaidAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() }
                    }
                }
            };
            var json = JsonSerializer.Serialize(stripeEvent);

            var start = DateTime.UtcNow;
            var response = await service.HandleStripeWebhookAsync(json, "sig");
            var elapsed = DateTime.UtcNow - start;

            Assert.True(response.Success);
            Assert.True(elapsed.TotalSeconds < 3, $"Elapsed {elapsed.TotalSeconds}s exceeds 3 seconds");
        }
    }
}