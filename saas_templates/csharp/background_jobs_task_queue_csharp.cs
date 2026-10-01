using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BackgroundJobs
{
    // -------------------------------------------------------------------------
    // Data models & EF Core context
    // -------------------------------------------------------------------------
    public enum JobStatus
    {
        Enqueued,
        Running,
        Completed,
        Failed,
        Cancelled
    }

    public class Job
    {
        [Key]
        public Guid Id { get; set; }

        [Required]
        public string TaskType { get; set; } = null!;

        [Required]
        public string ParamsJson { get; set; } = "{}";

        [Required]
        public JobStatus Status { get; set; } = JobStatus.Enqueued;

        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public DateTime? StartedAt { get; set; }
        public DateTime? CompletedAt { get; set; }

        public string? Progress { get; set; } // e.g. "45/100"

        public string? ResultJson { get; set; }

        public string? Error { get; set; }

        public int RetryCount { get; set; } = 0;

        public int MaxRetries { get; set; } = 3;

        public DateTime? NextRetryAt { get; set; }

        public DateTime? ScheduledAt { get; set; }
    }

    public class JobRun
    {
        [Key]
        public Guid Id { get; set; }

        [Required]
        public Guid JobId { get; set; }

        [ForeignKey(nameof(JobId))]
        public Job Job { get; set; } = null!;

        [Required]
        public JobStatus Status { get; set; }

        public DateTime StartedAt { get; set; } = DateTime.UtcNow;
        public DateTime? CompletedAt { get; set; }

        public string? ResultJson { get; set; }
    }

    public class JobsDbContext : DbContext
    {
        public DbSet<Job> Jobs => Set<Job>();
        public DbSet<JobRun> JobRuns => Set<JobRun>();

        public JobsDbContext(DbContextOptions<JobsDbContext> options) : base(options) { }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            // DDL equivalent (SQLite compatible)
            modelBuilder.Entity<Job>(entity =>
            {
                entity.ToTable("jobs");
                entity.Property(e => e.Id).HasColumnName("id");
                entity.Property(e => e.TaskType).HasColumnName("task_type");
                entity.Property(e => e.ParamsJson).HasColumnName("params");
                entity.Property(e => e.Status).HasColumnName("status")
                      .HasConversion<string>();
                entity.Property(e => e.CreatedAt).HasColumnName("created_at");
                entity.Property(e => e.StartedAt).HasColumnName("started_at");
                entity.Property(e => e.CompletedAt).HasColumnName("completed_at");
                entity.Property(e => e.Progress).HasColumnName("progress");
                entity.Property(e => e.ResultJson).HasColumnName("result");
                entity.Property(e => e.Error).HasColumnName("error");
                entity.Property(e => e.RetryCount).HasColumnName("retry_count");
                entity.Property(e => e.MaxRetries).HasColumnName("max_retries");
                entity.Property(e => e.NextRetryAt).HasColumnName("next_retry_at");
                entity.Property(e => e.ScheduledAt).HasColumnName("scheduled_at");
            });

            modelBuilder.Entity<JobRun>(entity =>
            {
                entity.ToTable("job_runs");
                entity.Property(e => e.Id).HasColumnName("id");
                entity.Property(e => e.JobId).HasColumnName("job_id");
                entity.Property(e => e.Status).HasColumnName("status")
                      .HasConversion<string>();
                entity.Property(e => e.StartedAt).HasColumnName("started_at");
                entity.Property(e => e.CompletedAt).HasColumnName("completed_at");
                entity.Property(e => e.ResultJson).HasColumnName("result");
            });
        }
    }

    // -------------------------------------------------------------------------
    // Repository
    // -------------------------------------------------------------------------
    public interface IJobRepository
    {
        Task<Job> EnqueueAsync(string taskType, object parameters, DateTime? scheduledAt, int maxRetries);
        Task<Job?> GetAsync(Guid jobId);
        Task<List<Job>> ListAsync(string? status, string? taskType, int limit);
        Task<bool> CancelAsync(Guid jobId);
        Task<Job?> RetryAsync(Guid jobId);
        Task UpdateProgressAsync(Guid jobId, string progress);
        Task MarkRunningAsync(Guid jobId);
        Task MarkCompletedAsync(Guid jobId, object result);
        Task MarkFailedAsync(Guid jobId, string error);
    }

    public class JobRepository : IJobRepository
    {
        private readonly JobsDbContext _db;
        private readonly ILogger<JobRepository> _logger;

        public JobRepository(JobsDbContext db, ILogger<JobRepository> logger)
        {
            _db = db;
            _logger = logger;
        }

        public async Task<Job> EnqueueAsync(string taskType, object parameters, DateTime? scheduledAt, int maxRetries)
        {
            var job = new Job
            {
                Id = Guid.NewGuid(),
                TaskType = taskType,
                ParamsJson = JsonSerializer.Serialize(parameters),
                Status = JobStatus.Enqueued,
                CreatedAt = DateTime.UtcNow,
                ScheduledAt = scheduledAt,
                MaxRetries = maxRetries
            };
            _db.Jobs.Add(job);
            await _db.SaveChangesAsync();
            return job;
        }

        public async Task<Job?> GetAsync(Guid jobId) => await _db.Jobs.FindAsync(jobId);

        public async Task<List<Job>> ListAsync(string? status, string? taskType, int limit)
        {
            var query = _db.Jobs.AsQueryable();
            if (!string.IsNullOrEmpty(status) && Enum.TryParse<JobStatus>(status, true, out var st))
                query = query.Where(j => j.Status == st);
            if (!string.IsNullOrEmpty(taskType))
                query = query.Where(j => j.TaskType == taskType);
            return await query.OrderByDescending(j => j.CreatedAt).Take(limit).ToListAsync();
        }

        public async Task<bool> CancelAsync(Guid jobId)
        {
            var job = await _db.Jobs.FindAsync(jobId);
            if (job == null) return false;
            if (job.Status != JobStatus.Enqueued) return false;
            job.Status = JobStatus.Cancelled;
            await _db.SaveChangesAsync();
            return true;
        }

        public async Task<Job?> RetryAsync(Guid jobId)
        {
            var oldJob = await _db.Jobs.FindAsync(jobId);
            if (oldJob == null) return null;
            if (oldJob.Status != JobStatus.Failed) return null;

            var newJob = new Job
            {
                Id = Guid.NewGuid(),
                TaskType = oldJob.TaskType,
                ParamsJson = oldJob.ParamsJson,
                Status = JobStatus.Enqueued,
                CreatedAt = DateTime.UtcNow,
                MaxRetries = oldJob.MaxRetries,
                ScheduledAt = null
            };
            _db.Jobs.Add(newJob);
            await _db.SaveChangesAsync();
            return newJob;
        }

        public async Task UpdateProgressAsync(Guid jobId, string progress)
        {
            var job = await _db.Jobs.FindAsync(jobId);
            if (job == null) return;
            job.Progress = progress;
            await _db.SaveChangesAsync();
        }

        public async Task MarkRunningAsync(Guid jobId)
        {
            var job = await _db.Jobs.FindAsync(jobId);
            if (job == null) return;
            job.Status = JobStatus.Running;
            job.StartedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }

        public async Task MarkCompletedAsync(Guid jobId, object result)
        {
            var job = await _db.Jobs.FindAsync(jobId);
            if (job == null) return;
            job.Status = JobStatus.Completed;
            job.CompletedAt = DateTime.UtcNow;
            job.ResultJson = JsonSerializer.Serialize(result);
            await _db.SaveChangesAsync();
        }

        public async Task MarkFailedAsync(Guid jobId, string error)
        {
            var job = await _db.Jobs.FindAsync(jobId);
            if (job == null) return;
            job.Status = JobStatus.Failed;
            job.Error = error;
            job.CompletedAt = DateTime.UtcNow;
            await _db.SaveChangesAsync();
        }
    }

    // -------------------------------------------------------------------------
    // Job handlers
    // -------------------------------------------------------------------------
    public interface IJobHandler
    {
        Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct);
    }

    public class SendBulkEmailHandler : IJobHandler
    {
        public async Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct)
        {
            var parameters = JsonSerializer.Deserialize<Dictionary<string, object>>(job.ParamsJson)!;
            // Simulated total count
            int total = 500;
            int sent = 0;
            int failed = 0;

            for (int i = 1; i <= total; i++)
            {
                ct.ThrowIfCancellationRequested();
                // Simulate sending email
                await Task.Delay(5, ct);
                if (i % 100 == 0) failed++; else sent++;

                await repo.UpdateProgressAsync(job.Id, $"{i}/{total}");
            }

            var result = new
            {
                task_type = job.TaskType,
                sent,
                failed,
                skipped = 0,
                errors = new object[0]
            };
            await repo.MarkCompletedAsync(job.Id, result);
        }
    }

    public class WebhookRetryHandler : IJobHandler
    {
        public async Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct)
        {
            // Simulated retry logic
            await Task.Delay(200, ct);
            var result = new { task_type = job.TaskType, retried = true };
            await repo.MarkCompletedAsync(job.Id, result);
        }
    }

    public class ExportGenerateHandler : IJobHandler
    {
        public async Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct)
        {
            await Task.Delay(500, ct);
            var result = new { task_type = job.TaskType, export_url = "https://example.com/export/12345" };
            await repo.MarkCompletedAsync(job.Id, result);
        }
    }

    public class DailyReportHandler : IJobHandler
    {
        public async Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct)
        {
            await Task.Delay(300, ct);
            var result = new { task_type = job.TaskType, report_id = Guid.NewGuid() };
            await repo.MarkCompletedAsync(job.Id, result);
        }
    }

    public class CleanupOldSessionsHandler : IJobHandler
    {
        public async Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct)
        {
            await Task.Delay(150, ct);
            var result = new { task_type = job.TaskType, cleaned = true };
            await repo.MarkCompletedAsync(job.Id, result);
        }
    }

    public class DeleteUserCascadeHandler : IJobHandler
    {
        public async Task ExecuteAsync(Job job, IJobRepository repo, CancellationToken ct)
        {
            await Task.Delay(400, ct);
            var result = new { task_type = job.TaskType, deleted = true };
            await repo.MarkCompletedAsync(job.Id, result);
        }
    }

    public class JobDispatcher
    {
        private readonly IServiceProvider _sp;
        private readonly Dictionary<string, Type> _handlerMap = new()
        {
            { "send_bulk_email", typeof(SendBulkEmailHandler) },
            { "webhook_retry", typeof(WebhookRetryHandler) },
            { "export_generate", typeof(ExportGenerateHandler) },
            { "daily_report_generate", typeof(DailyReportHandler) },
            { "cleanup_old_sessions", typeof(CleanupOldSessionsHandler) },
            { "delete_user_cascade", typeof(DeleteUserCascadeHandler) }
        };

        public JobDispatcher(IServiceProvider sp) => _sp = sp;

        public IJobHandler? Resolve(string taskType)
        {
            if (_handlerMap.TryGetValue(taskType, out var type))
                return (IJobHandler?)_sp.GetService(type);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Background worker
    // -------------------------------------------------------------------------
    public class JobProcessor : BackgroundService
    {
        private readonly IServiceProvider _sp;
        private readonly ILogger<JobProcessor> _logger;
        private readonly TimeSpan _pollInterval = TimeSpan.FromSeconds(2);

        public JobProcessor(IServiceProvider sp, ILogger<JobProcessor> logger)
        {
            _sp = sp;
            _logger = logger;
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await ProcessPendingJobs(stoppingToken);
                await Task.Delay(_pollInterval, stoppingToken);
            }
        }

        private async Task ProcessPendingJobs(CancellationToken ct)
        {
            using var scope = _sp.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<JobsDbContext>();
            var repo = scope.ServiceProvider.GetRequiredService<IJobRepository>();
            var dispatcher = scope.ServiceProvider.GetRequiredService<JobDispatcher>();

            var now = DateTime.UtcNow;
            var jobs = await db.Jobs
                .AsNoTracking()
                .Where(j => j.Status == JobStatus.Enqueued &&
                            (j.ScheduledAt == null || j.ScheduledAt <= now) &&
                            (j.NextRetryAt == null || j.NextRetryAt <= now))
                .OrderBy(j => j.CreatedAt)
                .Take(5)
                .ToListAsync(ct);

            foreach (var job in jobs)
            {
                ct.ThrowIfCancellationRequested();
                try
                {
                    await repo.MarkRunningAsync(job.Id);
                    var handler = dispatcher.Resolve(job.TaskType);
                    if (handler == null)
                        throw new InvalidOperationException($"No handler for task type {job.TaskType}");

                    await handler.ExecuteAsync(job, repo, ct);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Job {JobId} failed", job.Id);
                    await HandleFailureAsync(job, repo, ex);
                }
            }
        }

        private async Task HandleFailureAsync(Job job, IJobRepository repo, Exception ex)
        {
            job.RetryCount++;
            if (job.RetryCount > job.MaxRetries)
            {
                await repo.MarkFailedAsync(job.Id, ex.Message);
                return;
            }

            // Exponential backoff: 2^retry seconds
            var delaySeconds = Math.Pow(2, job.RetryCount - 1);
            job.NextRetryAt = DateTime.UtcNow.AddSeconds(delaySeconds);
            job.Status = JobStatus.Enqueued;
            using var scope = _sp.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<JobsDbContext>();
            db.Jobs.Update(job);
            await db.SaveChangesAsync();
        }
    }

    // -------------------------------------------------------------------------
    // API endpoints (minimal API)
    // -------------------------------------------------------------------------
    public class Startup
    {
        public void ConfigureServices(IServiceCollection services)
        {
            services.AddDbContext<JobsDbContext>(opt =>
                opt.UseSqlite("Data Source=jobs.db"));
            services.AddScoped<IJobRepository, JobRepository>();
            services.AddSingleton<JobDispatcher>();
            services.AddTransient<SendBulkEmailHandler>();
            services.AddTransient<WebhookRetryHandler>();
            services.AddTransient<ExportGenerateHandler>();
            services.AddTransient<DailyReportHandler>();
            services.AddTransient<CleanupOldSessionsHandler>();
            services.AddTransient<DeleteUserCascadeHandler>();
            services.AddHostedService<JobProcessor>();
            services.AddLogging();
        }

        public void Configure(IApplicationBuilder app)
        {
            var env = app.ApplicationServices.GetRequiredService<IHostEnvironment>();
            using (var scope = app.ApplicationServices.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<JobsDbContext>();
                db.Database.Migrate();
            }

            var api = app.UseRouting()
                .UseEndpoints(endpoints =>
                {
                    // 1. Enqueue job
                    endpoints.MapPost("/jobs/enqueue", async (HttpContext http, IJobRepository repo) =>
                    {
                        var payload = await JsonSerializer.DeserializeAsync<EnqueueRequest>(http.Request.Body);
                        if (payload == null) return Results.BadRequest(new { success = false, error = "Invalid payload" });

                        var job = await repo.EnqueueAsync(
                            payload.TaskType,
                            payload.Params,
                            payload.ScheduledAt,
                            payload.MaxRetries ?? 3);

                        return Results.Ok(new { success = true, job_id = job.Id, status = job.Status.ToString().ToLower() });
                    });

                    // 2. Get job status
                    endpoints.MapGet("/jobs/{jobId}", async (Guid jobId, IJobRepository repo) =>
                    {
                        var job = await repo.GetAsync(jobId);
                        if (job == null) return Results.NotFound();

                        var resultObj = job.ResultJson != null ? JsonSerializer.Deserialize<object>(job.ResultJson) : null;
                        return Results.Ok(new
                        {
                            job_id = job.Id,
                            task_type = job.TaskType,
                            status = job.Status.ToString().ToLower(),
                            progress = job.Progress,
                            created_at = job.CreatedAt,
                            started_at = job.StartedAt,
                            result = resultObj,
                            next_retry_at = job.NextRetryAt
                        });
                    });

                    // 3. List jobs
                    endpoints.MapGet("/jobs", async (HttpRequest req, IJobRepository repo) =>
                    {
                        var status = req.Query["status"];
                        var taskType = req.Query["task_type"];
                        var limitStr = req.Query["limit"];
                        int limit = 10;
                        if (!string.IsNullOrEmpty(limitStr) && int.TryParse(limitStr, out var l)) limit = l;

                        var jobs = await repo.ListAsync(status, taskType, limit);
                        var total = jobs.Count;
                        var list = jobs.Select(j => new
                        {
                            job_id = j.Id,
                            task_type = j.TaskType,
                            status = j.Status.ToString().ToLower(),
                            created_at = j.CreatedAt
                        });
                        return Results.Ok(new { jobs = list, total });
                    });

                    // 4. Cancel job
                    endpoints.MapDelete("/jobs/{jobId}", async (Guid jobId, IJobRepository repo) =>
                    {
                        var ok = await repo.CancelAsync(jobId);
                        if (!ok) return Results.BadRequest(new { success = false, error = "Cannot cancel" });
                        return Results.Ok(new { success = true, status = "cancelled" });
                    });

                    // 5. Retry failed job
                    endpoints.MapPost("/jobs/{jobId}/retry", async (Guid jobId, IJobRepository repo) =>
                    {
                        var newJob = await repo.RetryAsync(jobId);
                        if (newJob == null) return Results.BadRequest(new { success = false, error = "Retry not possible" });
                        return Results.Ok(new { success = true, new_job_id = newJob.Id, status = newJob.Status.ToString().ToLower() });
                    });

                    // 6. Get results
                    endpoints.MapGet("/jobs/{jobId}/results", async (Guid jobId, IJobRepository repo) =>
                    {
                        var job = await repo.GetAsync(jobId);
                        if (job == null) return Results.NotFound();
                        if (job.Status != JobStatus.Completed) return Results.BadRequest(new { error = "Job not completed" });

                        var resultObj = job.ResultJson != null ? JsonSerializer.Deserialize<object>(job.ResultJson) : null;
                        return Results.Ok(new
                        {
                            job_id = job.Id,
                            status = job.Status.ToString().ToLower(),
                            result = resultObj,
                            completed_at = job.CompletedAt
                        });
                    });
                });
        }
    }

    // -------------------------------------------------------------------------
    // DTOs
    // -------------------------------------------------------------------------
    public class EnqueueRequest
    {
        [JsonPropertyName("task_type")]
        public string TaskType { get; set; } = null!;

        [JsonPropertyName("params")]
        public object Params { get; set; } = null!;

        [JsonPropertyName("scheduled_at")]
        public DateTime? ScheduledAt { get; set; }

        [JsonPropertyName("max_retries")]
        public int? MaxRetries { get; set; }
    }

    // -------------------------------------------------------------------------
    // Program entry point
    // -------------------------------------------------------------------------
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
}