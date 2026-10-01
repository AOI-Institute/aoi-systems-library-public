using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using AuthSystem;
using BCrypt.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Moq;
using OtpNet;
using Xunit;

namespace AuthSystemTests
{
    public class AuthServiceTests
    {
        private readonly DbContextOptions<AuthDbContext> _dbOptions;
        private readonly Mock<IEmailSender> _emailSenderMock;
        private readonly Mock<IOAuthProvider> _oauthProviderMock;
        private readonly IMemoryCache _cache;
        private readonly string _jwtSecret = "this_is_a_very_secret_key_for_jwt_signing_that_is_long_enough";

        public AuthServiceTests()
        {
            _dbOptions = new DbContextOptionsBuilder<AuthDbContext>()
                .UseInMemoryDatabase(databaseName: Guid.NewGuid().ToString())
                .Options;
            _emailSenderMock = new Mock<IEmailSender>();
            _oauthProviderMock = new Mock<IOAuthProvider>();
            _cache = new MemoryCache(new MemoryCacheOptions());
        }

        private AuthDbContext CreateDb() => new AuthDbContext(_dbOptions);
        private AuthService CreateService() => new AuthService(CreateDb(), _emailSenderMock.Object, _oauthProviderMock.Object, _cache, _jwtSecret);

        [Fact]
        public async Task Signup_HappyPath_CreatesUserAndSendsEmail()
        {
            var service = CreateService();
            var result = await service.SignupAsync("test@example.com", "ThisIsAVeryLongPassword123!", "Test User");
            Assert.Equal("pending_verification", ((dynamic)result).status);
            Assert.Equal("test@example.com", ((dynamic)result).email);
            _emailSenderMock.Verify(es => es.SendVerificationEmailAsync("test@example.com", It.IsAny<string>()), Times.Once);
        }

        [Fact]
        public async Task Signup_DuplicateEmail_ReturnsError()
        {
            using var db = CreateDb();
            db.Users.Add(new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("password"), Status = "verified" });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.SignupAsync("test@example.com", "ThisIsAVeryLongPassword123!", "Test User");
            Assert.Equal("email_already_exists", ((dynamic)result).error);
        }

        [Fact]
        public async Task Signup_WeakPassword_TooShort_ReturnsError()
        {
            var service = CreateService();
            var result = await service.SignupAsync("test@example.com", "short", "Test User");
            Assert.Equal("password_rejected", ((dynamic)result).error);
            Assert.Equal("too_short", ((dynamic)result).reason);
        }

        [Fact]
        public async Task Signup_IPRateLimit_Exceeded_ReturnsError()
        {
            var service = CreateService();
            for (int i = 0; i < 5; i++)
            {
                var result = await service.SignupAsync($"user{i}@example.com", "ThisIsAVeryLongPassword123!", "Test User");
                if (i < 4)
                    Assert.Equal("pending_verification", ((dynamic)result).status);
            }

            var result = await service.SignupAsync("blocked@example.com", "ThisIsAVeryLongPassword123!", "Test User");
            Assert.Equal("too_many_signups_from_ip", ((dynamic)result).error);
        }

        [Fact]
        public async Task VerifyEmail_HappyPath_VerifiesUser()
        {
            using var db = CreateDb();
            var user = new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("password"), Status = "unverified" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var code = "123456";
            db.VerificationCodes.Add(new VerificationCode
            {
                UserId = user.Id,
                Code = code,
                Type = "email",
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddMinutes(15)
            });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.VerifyEmailAsync("test@example.com", code);
            Assert.Equal("verified", ((dynamic)result).status);
            Assert.Equal(user.Id, ((dynamic)result).user_id);

            var updatedUser = await db.Users.FindAsync(user.Id);
            Assert.NotNull(updatedUser.EmailVerifiedAt);
        }

        [Fact]
        public async Task VerifyEmail_ExpiredCode_ReturnsError()
        {
            using var db = CreateDb();
            var user = new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("password"), Status = "unverified" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var code = "123456";
            db.VerificationCodes.Add(new VerificationCode
            {
                UserId = user.Id,
                Code = code,
                Type = "email",
                CreatedAt = DateTime.UtcNow.AddMinutes(-20),
                ExpiresAt = DateTime.UtcNow.AddMinutes(-5)
            });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.VerifyEmailAsync("test@example.com", code);
            Assert.Equal("code_expired", ((dynamic)result).error);
        }

        [Fact]
        public async Task Login_NoMFA_ReturnsToken()
        {
            using var db = CreateDb();
            var user = new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("ThisIsAVeryLongPassword123!"), Status = "verified" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.LoginAsync("test@example.com", "ThisIsAVeryLongPassword123!", "device1", "127.0.0.1");
            Assert.Equal("authenticated", ((dynamic)result).status);
            Assert.NotNull(((dynamic)result).token);
            Assert.Equal(user.Id, ((dynamic)result).user.id);
        }

        [Fact]
        public async Task Login_WithMFAEnabled_ReturnsMFARequired()
        {
            using var db = CreateDb();
            var user = new User
            {
                Email = "test@example.com",
                PasswordHash = BCrypt.HashPassword("ThisIsAVeryLongPassword123!"),
                Status = "verified",
                MfaEnabled = true,
                MfaSecret = "JBSWY3DPEHPK3PXP" // Base32 for "HELLOWORLD"
            };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.LoginAsync("test@example.com", "ThisIsAVeryLongPassword123!", "device1", "127.0.0.1");
            Assert.Equal("mfa_required", ((dynamic)result).status);
            Assert.NotNull(((dynamic)result).challenge_id);
        }

        [Fact]
        public async Task Login_InvalidPassword_ReturnsError()
        {
            using var db = CreateDb();
            var user = new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("ThisIsAVeryLongPassword123!"), Status = "verified" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.LoginAsync("test@example.com", "WrongPassword", "device1", "127.0.0.1");
            Assert.Equal("invalid_credentials", ((dynamic)result).error);
        }

        [Fact]
        public async Task OAuthCallback_NewUser_CreatesUserAndLinksProvider()
        {
            _oauthProviderMock.Setup(o => o.GetEmailFromCodeAsync("google", "code")).ReturnsAsync("newuser@example.com");
            _oauthProviderMock.Setup(o => o.IsEmailVerifiedAsync("google", "code")).ReturnsAsync(true);

            var service = CreateService();
            var result = await service.OAuthCallbackAsync("google", "code", "state123");
            Assert.Equal("authenticated", ((dynamic)result).status);
            Assert.Equal("newuser@example.com", ((dynamic)result).user.email);
            Assert.Equal("verified", ((dynamic)result).user.status.ToString());

            using var db = CreateDb();
            var user = await db.Users.FirstOrDefaultAsync(u => u.Email == "newuser@example.com");
            Assert.NotNull(user);
            Assert.Equal("verified", user.Status);
        }

        [Fact]
        public async Task OAuthCallback_ExistingUser_LinksProvider()
        {
            using var db = CreateDb();
            var user = new User { Email = "existing@example.com", PasswordHash = BCrypt.HashPassword("password"), Status = "verified" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            _oauthProviderMock.Setup(o => o.GetEmailFromCodeAsync("google", "code")).ReturnsAsync("existing@example.com");
            _oauthProviderMock.Setup(o => o.IsEmailVerifiedAsync("google", "code")).ReturnsAsync(true);

            var service = CreateService();
            var result = await service.OAuthCallbackAsync("google", "code", "state123");
            Assert.Equal("authenticated", ((dynamic)result).status);
            Assert.Equal(user.Id, ((dynamic)result).user.id);
        }

        [Fact]
        public async Task MfaChallenge_ValidCode_ReturnsToken()
        {
            using var db = CreateDb();
            var user = new User
            {
                Email = "test@example.com",
                PasswordHash = BCrypt.HashPassword("ThisIsAVeryLongPassword123!"),
                Status = "verified",
                MfaEnabled = true,
                MfaSecret = "JBSWY3DPEHPK3PXP"
            };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var totp = new Totp(Base32Encoding.ToBytes(user.MfaSecret));
            var code = totp.ComputeTotp();

            var challengeId = Guid.NewGuid().ToString();
            db.VerificationCodes.Add(new VerificationCode
            {
                UserId = user.Id,
                Code = challengeId,
                Type = "mfa",
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddMinutes(5)
            });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.MfaChallengeAsync(challengeId, code);
            Assert.Equal("authenticated", ((dynamic)result).status);
            Assert.NotNull(((dynamic)result).token);
        }

        [Fact]
        public async Task MfaChallenge_InvalidCode_ReturnsError()
        {
            using var db = CreateDb();
            var user = new User
            {
                Email = "test@example.com",
                PasswordHash = BCrypt.HashPassword("ThisIsAVeryLongPassword123!"),
                Status = "verified",
                MfaEnabled = true,
                MfaSecret = "JBSWY3DPEHPK3PXP"
            };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var challengeId = Guid.NewGuid().ToString();
            db.VerificationCodes.Add(new VerificationCode
            {
                UserId = user.Id,
                Code = challengeId,
                Type = "mfa",
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddMinutes(5)
            });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.MfaChallengeAsync(challengeId, "000000");
            Assert.Equal("invalid_code", ((dynamic)result).error);
        }

        [Fact]
        public async Task TokenRefresh_HappyPath_IssuesNewToken()
        {
            using var db = CreateDb();
            var user = new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("password"), Status = "verified", Tier = "premium" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var refreshToken = Guid.NewGuid().ToString();
            db.Sessions.Add(new Session
            {
                UserId = user.Id,
                RefreshToken = refreshToken,
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddDays(7),
                Ip = "127.0.0.1",
                DeviceId = "device1"
            });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.TokenRefreshAsync(refreshToken);
            Assert.Equal("ok", ((dynamic)result).status);
            Assert.NotNull(((dynamic)result).token);
        }

        [Fact]
        public async Task TokenRefresh_BannedUser_ReturnsError()
        {
            using var db = CreateDb();
            var user = new User { Email = "test@example.com", PasswordHash = BCrypt.HashPassword("password"), Status = "banned" };
            db.Users.Add(user);
            await db.SaveChangesAsync();

            var refreshToken = Guid.NewGuid().ToString();
            db.Sessions.Add(new Session
            {
                UserId = user.Id,
                RefreshToken = refreshToken,
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = DateTime.UtcNow.AddDays(7),
                Ip = "127.0.0.1",
                DeviceId = "device1"
            });
            await db.SaveChangesAsync();

            var service = CreateService();
            var result = await service.TokenRefreshAsync(refreshToken);
            Assert.Equal("user_banned", ((dynamic)result).error);
        }
    }
}