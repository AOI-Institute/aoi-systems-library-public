using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Net.Mail;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Twilio;
using Twilio.Rest.Api.V2010.Account;
using Twilio.Types;

namespace Notifications
{
    #region Data Models and DbContext

    public class NotificationTemplate
    {
        [Key]
        public string Key { get; set; } = null!;
        public string Subject { get; set; } = null!;
        public string BodyText { get; set; } = null!;
        public string BodyHtml { get; set; } = null!;
        public string ChannelsDefault { get; set; } = null!; // comma separated e.g. "email,sms"
        public string Variables { get; set; } = null!; // comma separated list of allowed vars
    }

    public class NotificationLog
    {
        [Key]
        public Guid Id { get; set; } = Guid.NewGuid();
        public long UserId { get; set; }
        public string TemplateKey { get; set; } = null!;
        public string Channel { get; set; } = null!; // email, sms, in_app
        public string VarsUsed { get; set; } = null!; // JSON
        public DateTime SentAt { get; set; }
        public DateTime? OpenedAt { get; set; }
        public DateTime? ClickedAt { get; set; }
        public bool Bounced { get; set; }
        public string? Error { get; set; }
        public string Status { get; set; } = "sent"; // sent, opened, bounced, skipped, failed
    }

    public class UserNotificationPreference
    {
        [Key]
        public long UserId { get; set; }
        public bool DoNotDisturb { get; set; }
        public TimeSpan QuietHoursStart { get; set; }
        public TimeSpan QuietHoursEnd { get; set; }
        public string ChannelsEnabledJson { get; set; } = null!; // {"email":true,"sms":false,"in_app":true}
        public Dictionary<string, bool> ChannelsEnabled
        {
            get => JsonSerializer.Deserialize<Dictionary<string, bool>>(ChannelsEnabledJson) ?? new();
            set => ChannelsEnabledJson = JsonSerializer.Serialize(value);
        }
    }

    public class NotificationDbContext : DbContext
    {
        public NotificationDbContext(DbContextOptions<NotificationDbContext> options) : base(options) { }

        public DbSet<NotificationTemplate> NotificationTemplates => Set<NotificationTemplate>();
        public DbSet<NotificationLog> NotificationLogs => Set<NotificationLog>();
        public DbSet<UserNotificationPreference> UserNotificationPreferences => Set<UserNotificationPreference>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            // Seed templates
            modelBuilder.Entity<NotificationTemplate>().HasData(
                new NotificationTemplate
                {
                    Key = "welcome_email",
                    Subject = "Welcome to {app_name}!",
                    BodyText = "Welcome to {app_name}! Here's your first step.",
                    BodyHtml = "<p>Welcome to {app_name}! Here's your first step.</p>",
                    ChannelsDefault = "email",
                    Variables = "app_name"
                },
                new NotificationTemplate
                {
                    Key = "trial_starting",
                    Subject = "Your trial is starting",
                    BodyText = "Your free trial is starting. You have {trial_days} days.",
                    BodyHtml = "<p>Your free trial is starting. You have {trial_days} days.</p>",
                    ChannelsDefault = "email,in_app",
                    Variables = "trial_days"
                },
                new NotificationTemplate
                {
                    Key = "trial_ending_soon",
                    Subject = "Trial ending soon",
                    BodyText = "Your trial ends in {days_left} days. Add payment method to continue.",
                    BodyHtml = "<p>Your trial ends in {days_left} days. Add payment method to continue.</p>",
                    ChannelsDefault = "email,in_app",
                    Variables = "days_left"
                },
                new NotificationTemplate
                {
                    Key = "subscription_changed",
                    Subject = "Subscription changed",
                    BodyText = "Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.",
                    BodyHtml = "<p>Your plan changed from {old_tier} to {new_tier}. Effective {effective_date}.</p>",
                    ChannelsDefault = "email",
                    Variables = "old_tier,new_tier,effective_date"
                },
                new NotificationTemplate
                {
                    Key = "payment_failed",
                    Subject = "Payment failed",
                    BodyText = "Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.",
                    BodyHtml = "<p>Payment failed for invoice {invoice_id}. {retry_date} retry, or update payment method.</p>",
                    ChannelsDefault = "email,in_app",
                    Variables = "invoice_id,retry_date"
                },
                new NotificationTemplate
                {
                    Key = "deployment_live",
                    Subject = "Deployment live",
                    BodyText = "Your deployment {deployment_name} is now live at {url}.",
                    BodyHtml = "<p>Your deployment {deployment_name} is now live at {url}.</p>",
                    ChannelsDefault = "email,in_app",
                    Variables = "deployment_name,url"
                },
                new NotificationTemplate
                {
                    Key = "user_invited",
                    Subject = "You are invited",
                    BodyText = "You've been invited to {workspace}. Click here to join.",
                    BodyHtml = "<p>You've been invited to {workspace}. <a href=\"{join_url}\">Click here to join</a>.</p>",
                    ChannelsDefault = "email,in_app",
                    Variables = "workspace,join_url"
                },
                new NotificationTemplate
                {
                    Key = "invoice_ready",
                    Subject = "Invoice ready",
                    BodyText = "Your invoice for {month} is ready. Download here.",
                    BodyHtml = "<p>Your invoice for {month} is ready. <a href=\"{download_url}\">Download here</a>.</p>",
                    ChannelsDefault = "email,in_app",
                    Variables = "month,download_url"
                },
                new NotificationTemplate
                {
                    Key = "admin_alert",
                    Subject = "Admin alert",
                    BodyText = "{actor} performed {action} on {resource}.",
                    BodyHtml = "<p>{actor} performed {action} on {resource}.</p>",
                    ChannelsDefault = "email",
                    Variables = "actor,action,resource"
                }
            );
        }
    }

    #endregion

    #region Services

    public interface INotificationSender
    {
        Task SendAsync(NotificationLog log, string content, string subject = null);
    }

    public class EmailSender : INotificationSender
    {
        private readonly SmtpClient _smtpClient;
        private readonly string _fromAddress = "no-reply@example.com";

        public EmailSender()
        {
            // Simple SMTP configuration; replace with real credentials in production
            _smtpClient = new SmtpClient("localhost")
            {
                EnableSsl = false,
                DeliveryMethod = SmtpDeliveryMethod.Network,
                Timeout = 10000
            };
        }

        public async Task SendAsync(NotificationLog log, string content, string subject = null)
        {
            var mail = new MailMessage(_fromAddress, $"user{log.UserId}@example.com")
            {
                Subject = subject ?? "Notification",
                Body = content,
                IsBodyHtml = true
            };
            // Add unsubscribe link
            var unsubscribeUrl = $"https://example.com/unsubscribe?user={log.UserId}&type=email";
            mail.Body += $"<br/><a href=\"{unsubscribeUrl}\">Unsubscribe</a>";

            try
            {
                await _smtpClient.SendMailAsync(mail);
                log.Status = "sent";
            }
            catch (Exception ex)
            {
                log.Error = ex.Message;
                log.Status = "failed";
                throw;
            }
        }
    }

    public class SmsSender : INotificationSender
    {
        private readonly string _accountSid = "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
        private readonly string _authToken = "your_auth_token";
        private readonly string _fromNumber = "+1234567890";

        public SmsSender()
        {
            // In real usage, load from configuration
            TwilioClient.Init(_accountSid, _authToken);
        }

        public async Task SendAsync(NotificationLog log, string content, string subject = null)
        {
            try
            {
                var message = await MessageResource.CreateAsync(
                    to: new PhoneNumber($"+1{log.UserId:D10}"), // placeholder phone mapping
                    from: new PhoneNumber(_fromNumber),
                    body: content
                );
                log.Status = "sent";
            }
            catch (Exception ex)
            {
                log.Error = ex.Message;
                log.Status = "failed";
                throw;
            }
        }
    }

    public class InAppSender : INotificationSender
    {
        public Task SendAsync(NotificationLog log, string content, string subject = null)
        {
            // In-app just stores the log; content can be retrieved via API later.
            log.Status = "sent";
            return Task.CompletedTask;
        }
    }

    public class NotificationService
    {
        private readonly NotificationDbContext _db;
        private readonly IServiceProvider _serviceProvider;
        private readonly ConcurrentQueue<Func<Task>> _queue = new();
        private readonly IHostedService _queueProcessor;

        public NotificationService(NotificationDbContext db, IServiceProvider serviceProvider, IHostedService queueProcessor)
        {
            _db = db;
            _serviceProvider = serviceProvider;
            _queueProcessor = queueProcessor;
        }

        private async Task<bool> IsInQuietHours(UserNotificationPreference pref, DateTime now)
        {
            var nowSpan = now.TimeOfDay;
            if (pref.QuietHoursStart < pref.QuietHoursEnd)
                return nowSpan >= pref.QuietHoursStart && nowSpan < pref.QuietHoursEnd;
            // Overnight range
            return nowSpan >= pref.QuietHoursStart || nowSpan < pref.QuietHoursEnd;
        }

        private string ApplyTemplate(string template, Dictionary<string, string> vars)
        {
            var result = template;
            foreach (var kvp in vars)
            {
                result = result.Replace($"{{{kvp.Key}}}", kvp.Value);
            }
            return result;
        }

        private INotificationSender GetSender(string channel)
        {
            return channel switch
            {
                "email" => _serviceProvider.GetRequiredService<EmailSender>(),
                "sms" => _serviceProvider.GetRequiredService<SmsSender>(),
                "in_app" => _serviceProvider.GetRequiredService<InAppSender>(),
                _ => throw new ArgumentException($"Unsupported channel {channel}")
            };
        }

        private async Task EnqueueAsync(Func<Task> work)
        {
            _queue.Enqueue(work);
            // Trigger background processor
            if (_queueProcessor is QueueProcessor qp) await qp.SignalNewWorkAsync();
        }

        public async Task<(bool Success, string MessageId, string Status, string Error)> SendAsync(
            long userId,
            string templateKey,
            string? channel,
            Dictionary<string, string> vars,
            DateTime? scheduledAt)
        {
            var template = await _db.NotificationTemplates.FirstOrDefaultAsync(t => t.Key == templateKey);
            if (template == null) return (false, "", "failed", "Template not found");

            var pref = await _db.UserNotificationPreferences.FirstOrDefaultAsync(p => p.UserId == userId)
                ?? new UserNotificationPreference
                {
                    UserId = userId,
                    DoNotDisturb = false,
                    QuietHoursStart = TimeSpan.Zero,
                    QuietHoursEnd = TimeSpan.Zero,
                    ChannelsEnabled = new Dictionary<string, bool> { { "email", true }, { "sms", true }, { "in_app", true } }
                };

            if (pref.DoNotDisturb)
            {
                var log = new NotificationLog
                {
                    UserId = userId,
                    TemplateKey = templateKey,
                    Channel = channel ?? "email",
                    VarsUsed = JsonSerializer.Serialize(vars),
                    SentAt = DateTime.UtcNow,
                    Status = "skipped"
                };
                _db.NotificationLogs.Add(log);
                await _db.SaveChangesAsync();
                return (true, log.Id.ToString(), "skipped", null);
            }

            var now = DateTime.UtcNow;
            if (await IsInQuietHours(pref, now))
            {
                // Queue for end of quiet hours
                var target = now.Date.Add(pref.QuietHoursEnd);
                if (target <= now) target = target.AddDays(1);
                scheduledAt = target;
            }

            // Determine channel
            string selectedChannel = channel ?? template.ChannelsDefault.Split(',')[0];
            if (!pref.ChannelsEnabled.TryGetValue(selectedChannel, out var enabled) || !enabled)
            {
                // fallback to first enabled channel
                selectedChannel = pref.ChannelsEnabled.FirstOrDefault(c => c.Value).Key ?? selectedChannel;
            }

            var logEntry = new NotificationLog
            {
                UserId = userId,
                TemplateKey = templateKey,
                Channel = selectedChannel,
                VarsUsed = JsonSerializer.Serialize(vars),
                SentAt = scheduledAt ?? now
            };
            _db.NotificationLogs.Add(logEntry);
            await _db.SaveChangesAsync();

            Func<Task> work = async () =>
            {
                int attempts = 0;
                int maxAttempts = 3;
                var delay = TimeSpan.FromSeconds(1);
                while (attempts < maxAttempts)
                {
                    try
                    {
                        var sender = GetSender(selectedChannel);
                        var subject = ApplyTemplate(template.Subject, vars);
                        var body = selectedChannel == "email" ? ApplyTemplate(template.BodyHtml, vars) : ApplyTemplate(template.BodyText, vars);
                        await sender.SendAsync(logEntry, body, subject);
                        await _db.SaveChangesAsync();
                        break;
                    }
                    catch
                    {
                        attempts++;
                        if (attempts >= maxAttempts)
                        {
                            logEntry.Status = "failed";
                            await _db.SaveChangesAsync();
                        }
                        else
                        {
                            await Task.Delay(delay);
                            delay = delay * 2;
                        }
                    }
                }
            };

            if (scheduledAt.HasValue && scheduledAt.Value > now)
            {
                var delay = scheduledAt.Value - now;
                await EnqueueAsync(async () =>
                {
                    await Task.Delay(delay);
                    await work();
                });
            }
            else
            {
                await EnqueueAsync(work);
            }

            return (true, logEntry.Id.ToString(), "queued", null);
        }

        public async Task<(bool Success, List<string> MessageIds, int Sent, int Failed)> SendBatchAsync(
            IEnumerable<(long userId, string templateKey, string? channel, Dictionary<string, string> vars, DateTime? scheduledAt)> batch)
        {
            var ids = new List<string>();
            int sent = 0, failed = 0;
            foreach (var item in batch)
            {
                var (success, msgId, _, error) = await SendAsync(item.userId, item.templateKey, item.channel, item.vars, item.scheduledAt);
                if (success) sent++; else failed++;
                ids.Add(msgId);
            }
            return (true, ids, sent, failed);
        }

        public async Task<NotificationLog?> TrackAsync(Guid messageId)
        {
            return await _db.NotificationLogs.FirstOrDefaultAsync(l => l.Id == messageId);
        }

        public async Task<UserNotificationPreference?> GetPreferencesAsync(long userId)
        {
            return await _db.UserNotificationPreferences.FirstOrDefaultAsync(p => p.UserId == userId);
        }

        public async Task<bool> UpdatePreferencesAsync(long userId, bool? doNotDisturb, Dictionary<string, bool>? channelsEnabled)
        {
            var pref = await _db.UserNotificationPreferences.FirstOrDefaultAsync(p => p.UserId == userId);
            if (pref == null)
            {
                pref = new UserNotificationPreference
                {
                    UserId = userId,
                    DoNotDisturb = false,
                    QuietHoursStart = TimeSpan.Zero,
                    QuietHoursEnd = TimeSpan.Zero,
                    ChannelsEnabled = new Dictionary<string, bool>()
                };
                _db.UserNotificationPreferences.Add(pref);
            }

            if (doNotDisturb.HasValue) pref.DoNotDisturb = doNotDisturb.Value;
            if (channelsEnabled != null)
            {
                foreach (var kvp in channelsEnabled)
                {
                    pref.ChannelsEnabled[kvp.Key] = kvp.Value;
                }
            }

            await _db.SaveChangesAsync();
            return true;
        }
    }

    public class QueueProcessor : BackgroundService, IHostedService
    {
        private readonly ConcurrentQueue<Func<Task>> _queue;
        private readonly SemaphoreSlim _signal = new(0);

        public QueueProcessor(ConcurrentQueue<Func<Task>> queue)
        {
            _queue = queue;
        }

        public async Task SignalNewWorkAsync()
        {
            _signal.Release();
            await Task.CompletedTask;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await _signal.WaitAsync(stoppingToken);
                while (_queue.TryDequeue(out var work))
                {
                    try
                    {
                        await work();
                    }
                    catch
                    {
                        // Swallow to keep processor alive; individual work logs failures.
                    }
                }
            }
        }
    }

    #endregion

    #region API Setup

    public class Startup
    {
        public void ConfigureServices(IServiceCollection services)
        {
            services.AddDbContext<NotificationDbContext>(opt => opt.UseInMemoryDatabase("notifications"));
            services.AddSingleton<EmailSender>();
            services.AddSingleton<SmsSender>();
            services.AddSingleton<InAppSender>();
            var queue = new ConcurrentQueue<Func<Task>>();
            services.AddSingleton(queue);
            services.AddSingleton<IHostedService, QueueProcessor>(sp => new QueueProcessor(queue));
            services.AddScoped<NotificationService>();
            services.AddControllers();
        }

        public void Configure(IApplicationBuilder app)
        {
            app.UseRouting();
            app.UseEndpoints(endpoints =>
            {
                endpoints.MapPost("/notifications/send", async context =>
                {
                    var payload = await JsonSerializer.DeserializeAsync<SendRequest>(context.Request.Body);
                    if (payload == null) { context.Response.StatusCode = 400; return; }

                    var service = context.RequestServices.GetRequiredService<NotificationService>();
                    var (success, messageId, status, error) = await service.SendAsync(
                        payload.UserId,
                        payload.TemplateKey,
                        payload.Channel,
                        payload.Vars ?? new(),
                        payload.ScheduledAt);

                    var resp = new { success, message_id = messageId, status, error };
                    await context.Response.WriteAsJsonAsync(resp);
                });

                endpoints.MapPost("/notifications/send-batch", async context =>
                {
                    var batch = await JsonSerializer.DeserializeAsync<List<SendRequest>>(context.Request.Body);
                    if (batch == null) { context.Response.StatusCode = 400; return; }

                    var service = context.RequestServices.GetRequiredService<NotificationService>();
                    var batchItems = batch.Select(r => (r.UserId, r.TemplateKey, r.Channel, r.Vars ?? new(), r.ScheduledAt));
                    var (success, ids, sent, failed) = await service.SendBatchAsync(batchItems);
                    var resp = new { success, sent, failed, message_ids = ids };
                    await context.Response.WriteAsJsonAsync(resp);
                });

                endpoints.MapGet("/notifications/track/{messageId}", async context =>
                {
                    var idStr = context.Request.RouteValues["messageId"]?.ToString();
                    if (!Guid.TryParse(idStr, out var guid)) { context.Response.StatusCode = 400; return; }

                    var service = context.RequestServices.GetRequiredService<NotificationService>();
                    var log = await service.TrackAsync(guid);
                    if (log == null) { context.Response.StatusCode = 404; return; }

                    var resp = new
                    {
                        message_id = log.Id,
                        user_id = log.UserId,
                        template_key = log.TemplateKey,
                        channel = log.Channel,
                        status = log.Status,
                        sent_at = log.SentAt,
                        opened_at = log.OpenedAt,
                        clicked_at = log.ClickedAt,
                        bounced = log.Bounced,
                        error = log.Error
                    };
                    await context.Response.WriteAsJsonAsync(resp);
                });

                endpoints.MapGet("/users/{userId}/notification-preferences", async context =>
                {
                    var idStr = context.Request.RouteValues["userId"]?.ToString();
                    if (!long.TryParse(idStr, out var userId)) { context.Response.StatusCode = 400; return; }

                    var service = context.RequestServices.GetRequiredService<NotificationService>();
                    var pref = await service.GetPreferencesAsync(userId);
                    if (pref == null) { context.Response.StatusCode = 404; return; }

                    var resp = new
                    {
                        user_id = pref.UserId,
                        do_not_disturb = pref.DoNotDisturb,
                        quiet_hours_start = pref.QuietHoursStart.ToString(@"hh\:mm"),
                        quiet_hours_end = pref.QuietHoursEnd.ToString(@"hh\:mm"),
                        channels_enabled = pref.ChannelsEnabled
                    };
                    await context.Response.WriteAsJsonAsync(resp);
                });

                endpoints.MapPut("/users/{userId}/notification-preferences", async context =>
                {
                    var idStr = context.Request.RouteValues["userId"]?.ToString();
                    if (!long.TryParse(idStr, out var userId)) { context.Response.StatusCode = 400; return; }

                    var payload = await JsonSerializer.DeserializeAsync<UpdatePrefRequest>(context.Request.Body);
                    if (payload == null) { context.Response.StatusCode = 400; return; }

                    var service = context.RequestServices.GetRequiredService<NotificationService>();
                    var success = await service.UpdatePreferencesAsync(userId, payload.DoNotDisturb, payload.ChannelsEnabled);
                    await context.Response.WriteAsJsonAsync(new { success });
                });
            });
        }
    }

    public class SendRequest
    {
        public long UserId { get; set; }
        public string TemplateKey { get; set; } = null!;
        public string? Channel { get; set; }
        public Dictionary<string, string>? Vars { get; set; }
        public DateTime? ScheduledAt { get; set; }
    }

    public class UpdatePrefRequest
    {
        public bool? DoNotDisturb { get; set; }
        public Dictionary<string, bool>? ChannelsEnabled { get; set; }
    }

    public class Program
    {
        public static async Task Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);
            var startup = new Startup();
            startup.ConfigureServices(builder.Services);
            var app = builder.Build();
            startup.Configure(app);
            await app.RunAsync();
        }
    }

    #endregion
}