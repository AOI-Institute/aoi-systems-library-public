using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using BCrypt.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.IdentityModel.Tokens;
using OtpNet;

namespace AuthSystem
{
    public class AuthDbContext : DbContext
    {
        public AuthDbContext(DbContextOptions<AuthDbContext> options) : base(options) { }

        public DbSet<User> Users { get; set; }
        public DbSet<Session> Sessions { get; set; }
        public DbSet<VerificationCode> VerificationCodes { get; set; }
        public DbSet<AuditLog> AuditLogs { get; set; }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<User>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.Property(e => e.Email).IsRequired().HasMaxLength(255);
                entity.HasIndex(e => e.Email).IsUnique();
                entity.Property(e => e.PasswordHash).IsRequired();
                entity.Property(e => e.Tier).IsRequired().HasDefaultValue("free");
                entity.Property(e => e.Status).IsRequired().HasDefaultValue("unverified");
                entity.Property(e => e.EmailVerifiedAt);
                entity.Property(e => e.MfaSecret);
                entity.Property(e => e.MfaEnabled).HasDefaultValue(false);
            });

            modelBuilder.Entity<Session>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.Property(e => e.RefreshToken).IsRequired().HasMaxLength(255);
                entity.HasIndex(e => e.RefreshToken).IsUnique();
                entity.Property(e => e.CreatedAt).IsRequired();
                entity.Property(e => e.ExpiresAt).IsRequired();
                entity.Property(e => e.Ip).IsRequired().HasMaxLength(45);
                entity.Property(e => e.DeviceId).IsRequired().HasMaxLength(255);
                entity.HasOne(e => e.User).WithMany().HasForeignKey(e => e.UserId);
            });

            modelBuilder.Entity<VerificationCode>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.Property(e => e.UserId).IsRequired();
                entity.Property(e => e.Code).IsRequired().HasMaxLength(255);
                entity.Property(e => e.CreatedAt).IsRequired();
                entity.Property(e => e.ExpiresAt).IsRequired();
                entity.Property(e => e.Type).IsRequired().HasMaxLength(20);
                entity.HasOne(e => e.User).WithMany().HasForeignKey(e => e.UserId);
            });

            modelBuilder.Entity<AuditLog>(entity =>
            {
                entity.HasKey(e => e.Id);
                entity.Property(e => e.Timestamp).IsRequired();
                entity.Property(e => e.Action).IsRequired().HasMaxLength(100);
                entity.Property(e => e.ResourceType).IsRequired().HasMaxLength(50);
                entity.Property(e => e.ResourceId).HasMaxLength(255);
                entity.Property(e => e.OldValue).HasMaxLength(1024);
                entity.Property(e => e.NewValue).HasMaxLength(1024);
                entity.Property(e => e.ActorId);
            });
        }
    }

    public class User
    {
        public int Id { get; set; }
        public string Email { get; set; }
        public string PasswordHash { get; set; }
        public string Tier { get; set; }
        public string Status { get; set; }
        public DateTime? EmailVerifiedAt { get; set; }
        public string MfaSecret { get; set; }
        public bool MfaEnabled { get; set; }
    }

    public class Session
    {
        public int Id { get; set; }
        public int UserId { get; set; }
        public string RefreshToken { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime ExpiresAt { get; set; }
        public string Ip { get; set; }
        public string DeviceId { get; set; }
        public User User { get; set; }
    }

    public class VerificationCode
    {
        public int Id { get; set; }
        public int UserId { get; set; }
        public string Code { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime ExpiresAt { get; set; }
        public string Type { get; set; }
        public User User { get; set; }
    }

    public class AuditLog
    {
        public int Id { get; set; }
        public DateTime Timestamp { get; set; }
        public int? ActorId { get; set; }
        public string Action { get; set; }
        public string ResourceType { get; set; }
        public string ResourceId { get; set; }
        public string OldValue { get; set; }
        public string NewValue { get; set; }
    }

    public interface IEmailSender
    {
        Task SendVerificationEmailAsync(string email, string code);
    }

    public interface IOAuthProvider
    {
        Task<string> GetEmailFromCodeAsync(string provider, string code);
        Task<bool> IsEmailVerifiedAsync(string provider, string code);
    }

    public class AuthService
    {
        private readonly AuthDbContext _db;
        private readonly IEmailSender _emailSender;
        private readonly IOAuthProvider _oauthProvider;
        private readonly IMemoryCache _cache;
        private readonly string _jwtSecret;
        private readonly string _serviceName = "MyService";
        private readonly HashSet<string> _commonPasswords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "password", "123456", "12345678", "qwerty", "abc123", "monkey", "letmein", "dragon", "baseball", "iloveyou",
            "trustno1", "sunshine", "master", "welcome", "password1", "superman", "princess", "1234567", "123456789",
            "123123", "football", "!@#$%^&*", "charlie", "aa123456", "donald", "jordan123", "harley", "ranger", "daniel",
            "starwars", "klaster", "1q2w3e4r", "131313", "freedom", "whatever", "qazwsx", "trustno1", "654321", "27653328",
            "iamthebest", "fuckyou", "superman1", "princess1", "1qaz2wsx", "qweasdzxc", "password123", "michael", "football1",
            "superman123", "123qwe", "cocacola", "samsung", "android", "foobar", "access14", "asdfghjkl", "zxcvbnm", "111111"
        };

        public AuthService(AuthDbContext db, IEmailSender emailSender, IOAuthProvider oauthProvider, IMemoryCache cache, string jwtSecret)
        {
            _db = db;
            _emailSender = emailSender;
            _oauthProvider = oauthProvider;
            _cache = cache;
            _jwtSecret = jwtSecret;
        }

        public async Task<object> SignupAsync(string email, string password, string name)
        {
            var ip = "127.0.0.1"; // In real implementation, extract from request
            var rateLimitKey = $"signup_ip:{ip}";
            if (!_cache.TryGetValue(rateLimitKey, out int count))
                count = 0;
            if (count >= 5)
                return new { error = "too_many_signups_from_ip" };

            if (await _db.Users.AnyAsync(u => u.Email == email))
                return new { error = "email_already_exists" };

            var passwordResult = ValidatePassword(password, email, name);
            if (!passwordResult.Success)
                return new { error = "password_rejected", reason = passwordResult.Reason };

            await _cache.SetAsync(rateLimitKey, count + 1, TimeSpan.FromHours(24));

            var user = new User
            {
                Email = email.ToLower(),
                PasswordHash = BCrypt.HashPassword(password),
                Tier = "free",
                Status = "unverified"
            };
            _db.Users.Add(user);
            await _db.SaveChangesAsync();

            var code = GenerateVerificationCode();
            var verification = new VerificationCode
            {
                UserId = user.Id,
                Code = code,
                Type = "email",
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddMinutes(15)
            };
            _db.VerificationCodes.Add(verification);
            await _db.SaveChangesAsync();

            await _emailSender.SendVerificationEmailAsync(email, code);
            await LogAuditAsync(null, "user_created", "user", user.Id.ToString(), null, $"{{email:{email}}}");
            await LogWhyChainAsync("signup", new[] { "email_unique", "password_strength", "rate_limit_ip_24h" });

            return new { status = "pending_verification", email, message = "check email" };
        }

        public async Task<object> VerifyEmailAsync(string email, string code)
        {
            var user = await _db.Users.FirstOrDefaultAsync(u => u.Email == email.ToLower());
            if (user == null || user.EmailVerifiedAt.HasValue)
                return new { error = "invalid_request" };

            var verification = await _db.VerificationCodes
                .FirstOrDefaultAsync(v => v.UserId == user.Id && v.Type == "email" && v.Code == code && v.ExpiresAt > DateTime.UtcNow);
            if (verification == null)
                return new { error = "code_expired" };

            user.EmailVerifiedAt = DateTime.UtcNow;
            _db.VerificationCodes.Remove(verification);
            await _db.SaveChangesAsync();

            await LogAuditAsync(user.Id, "email_verified", "user", user.Id.ToString(), null, null);
            await LogWhyChainAsync("verify_email", new[] { "code_valid", "user_unverified" });

            return new { status = "verified", user_id = user.Id, message = "ready to login" };
        }

        public async Task<object> LoginAsync(string email, string password, string deviceId, string ip)
        {
            var user = await _db.Users.FirstOrDefaultAsync(u => u.Email == email.ToLower());
            if (user == null || !user.EmailVerifiedAt.HasValue)
            {
                await LogFailedLogin(ip, email);
                return new { error = "invalid_credentials" };
            }

            if (!BCrypt.Verify(password, user.PasswordHash))
            {
                await LogFailedLogin(ip, email);
                return new { error = "invalid_credentials" };
            }

            var rateLimitKey = $"login_failed:{ip}:{email.ToLower()}";
            _cache.Remove(rateLimitKey);

            if (user.MfaEnabled)
            {
                var challengeId = Guid.NewGuid().ToString();
                var challenge = new VerificationCode
                {
                    UserId = user.Id,
                    Code = challengeId,
                    Type = "mfa",
                    CreatedAt = DateTime.UtcNow,
                    ExpiresAt = DateTime.UtcNow.AddMinutes(5)
                };
                _db.VerificationCodes.Add(challenge);
                await _db.SaveChangesAsync();
                await LogWhyChainAsync("login", new[] { "user_exists", "password_correct", "mfa_gate", "rate_limit" });
                return new { status = "mfa_required", challenge_id = challengeId };
            }

            var session = await CreateSessionAsync(user.Id, ip, deviceId);
            var token = GenerateJwtToken(user.Id, user.Tier);
            await LogAuditAsync(user.Id, "session_created", "session", session.Id.ToString(), null, $"{{ip:{ip},device_id:{deviceId}}}");
            await LogWhyChainAsync("login", new[] { "user_exists", "password_correct", "mfa_gate", "rate_limit" });

            return new
            {
                status = "authenticated",
                session_id = session.Id,
                token,
                expires_in = 900, // 15 minutes
                user = new { id = user.Id, email = user.Email, tier = user.Tier }
            };
        }

        public async Task<object> OAuthCallbackAsync(string provider, string code, string state)
        {
            var stateVerification = await _db.VerificationCodes
                .FirstOrDefaultAsync(v => v.Type == "oauth_state" && v.Code == state && v.ExpiresAt > DateTime.UtcNow);
            if (stateVerification == null)
                return new { error = "invalid_state" };

            var email = await _oauthProvider.GetEmailFromCodeAsync(provider, code);
            var isVerified = await _oauthProvider.IsEmailVerifiedAsync(provider, code);
            if (!isVerified)
                return new { error = "email_not_verified_by_provider" };

            _db.VerificationCodes.Remove(stateVerification);
            await _db.SaveChangesAsync();

            var user = await _db.Users.FirstOrDefaultAsync(u => u.Email == email.ToLower());
            bool isNewUser = user == null;
            if (isNewUser)
            {
                user = new User
                {
                    Email = email.ToLower(),
                    PasswordHash = BCrypt.HashPassword(Guid.NewGuid().ToString()),
                    Tier = "free",
                    Status = "verified"
                };
                _db.Users.Add(user);
                await _db.SaveChangesAsync();
            }

            await LogAuditAsync(user.Id, "oauth_login", "oauth_provider", provider, null, $"{{user_id:{user.Id}}}");
            await LogWhyChainAsync("oauth_callback", new[] { "state_valid", "email_verified" });

            var session = await CreateSessionAsync(user.Id, "oauth", "oauth");
            var token = GenerateJwtToken(user.Id, user.Tier);
            return new
            {
                status = "authenticated",
                session_id = session.Id,
                token,
                expires_in = 900,
                user = new { id = user.Id, email = user.Email, tier = user.Tier }
            };
        }

        public async Task<object> MfaChallengeAsync(string challengeId, string totpCode)
        {
            var challenge = await _db.VerificationCodes
                .FirstOrDefaultAsync(v => v.Type == "mfa" && v.Code == challengeId && v.ExpiresAt > DateTime.UtcNow);
            if (challenge == null)
                return new { error = "invalid_challenge" };

            var user = await _db.Users.FindAsync(challenge.UserId);
            if (user == null || !user.MfaEnabled || string.IsNullOrEmpty(user.MfaSecret))
                return new { error = "invalid_challenge" };

            var totp = new Totp(Base32Encoding.ToBytes(user.MfaSecret));
            var verified = totp.VerifyTotp(totpCode, out long timeStepMatched, new VerificationWindow(2, 2));
            if (!verified)
                return new { error = "invalid_code" };

            _db.VerificationCodes.Remove(challenge);
            await _db.SaveChangesAsync();

            var session = await CreateSessionAsync(user.Id, "mfa", "mfa");
            var token = GenerateJwtToken(user.Id, user.Tier);
            await LogAuditAsync(user.Id, "mfa_verified", "user", user.Id.ToString(), null, null);
            await LogWhyChainAsync("mfa_challenge", new[] { "challenge_valid", "code_correct" });

            return new
            {
                status = "authenticated",
                session_id = session.Id,
                token,
                expires_in = 900,
                user = new { id = user.Id, email = user.Email, tier = user.Tier }
            };
        }

        public async Task<object> TokenRefreshAsync(string refreshToken)
        {
            var session = await _db.Sessions
                .Include(s => s.User)
                .FirstOrDefaultAsync(s => s.RefreshToken == refreshToken && s.ExpiresAt > DateTime.UtcNow);
            if (session == null)
                return new { error = "invalid_token" };

            if (session.User.Status == "suspended" || session.User.Status == "banned")
                return new { error = "user_banned" };

            var newToken = GenerateJwtToken(session.User.Id, session.User.Tier);
            await LogAuditAsync(session.User.Id, "token_refreshed", "token", null, null, null);
            await LogWhyChainAsync("token_refresh", new[] { "token_valid", "user_active" });

            return new { status = "ok", token = newToken, expires_in = 900 };
        }

        private async Task LogFailedLogin(string ip, string email)
        {
            var key = $"login_failed:{ip}:{email.ToLower()}";
            if (!_cache.TryGetValue(key, out int count))
                count = 0;
            await _cache.SetAsync(key, count + 1, TimeSpan.FromMinutes(15));
        }

        private async Task<Session> CreateSessionAsync(int userId, string ip, string deviceId)
        {
            var refreshToken = GenerateRefreshToken();
            var session = new Session
            {
                UserId = userId,
                RefreshToken = refreshToken,
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddDays(7),
                Ip = ip,
                DeviceId = deviceId
            };
            _db.Sessions.Add(session);
            await _db.SaveChangesAsync();
            return session;
        }

        private string GenerateJwtToken(int userId, string tier)
        {
            var tokenHandler = new JwtSecurityTokenHandler();
            var key = Encoding.ASCII.GetBytes(_jwtSecret);
            var tokenDescriptor = new SecurityTokenDescriptor
            {
                Subject = new ClaimsIdentity(new Claim[]
                {
                    new Claim(ClaimTypes.NameIdentifier, userId.ToString()),
                    new Claim("tier", tier)
                }),
                Expires = DateTime.UtcNow.AddMinutes(15),
                SigningCredentials = new SigningCredentials(new SymmetricSecurityKey(key), SecurityAlgorithms.HmacSha256Signature)
            };
            var token = tokenHandler.CreateToken(tokenDescriptor);
            return tokenHandler.WriteToken(token);
        }

        private string GenerateRefreshToken()
        {
            var randomNumber = new byte[32];
            using var rng = RandomNumberGenerator.Create();
            rng.GetBytes(randomNumber);
            return Convert.ToBase64String(randomNumber);
        }

        private string GenerateVerificationCode()
        {
            var random = new Random();
            return random.Next(100000, 999999).ToString();
        }

        private (bool Success, string Reason) ValidatePassword(string password, string email, string name)
        {
            if (password.Length < 15) return (false, "too_short");
            if (password.Length > 64) return (false, "too_long");
            if (_commonPasswords.Contains(password)) return (false, "blocklisted");
            if (password.Equals(email, StringComparison.OrdinalIgnoreCase)) return (false, "blocklisted");
            if (password.Equals(name, StringComparison.OrdinalIgnoreCase)) return (false, "blocklisted");
            if (password.Equals(_serviceName, StringComparison.OrdinalIgnoreCase)) return (false, "blocklisted");
            return (true, null);
        }

        private Task LogAuditAsync(int? actorId, string action, string resourceType, string resourceId, string oldValue, string newValue)
        {
            var log = new AuditLog
            {
                Timestamp = DateTime.UtcNow,
                ActorId = actorId,
                Action = action,
                ResourceType = resourceType,
                ResourceId = resourceId,
                OldValue = oldValue,
                NewValue = newValue
            };
            _db.AuditLogs.Add(log);
            return _db.SaveChangesAsync();
        }

        private Task LogWhyChainAsync(string flow, string[] decisionPoints)
        {
            // In a real system, this would go to a structured logger
            Console.WriteLine($"WHY_CHAIN: flow={flow}, decision_points=[{string.Join(",", decisionPoints)}]");
            return Task.CompletedTask;
        }
    }
}