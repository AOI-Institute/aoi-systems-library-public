using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
using BCrypt.Net;
using Microsoft.EntityFrameworkCore;
using Moq;
using StackExchange.Redis;
using Xunit;
using SaaSLibrary.ApiKeys;

namespace SaaSLibrary.ApiKeys.Tests
{
    public class ApiKeysServiceTests : IDisposable
    {
        private readonly ApiKeysDbContext _dbContext;
        private readonly Mock<IConnectionMultiplexer> _redisMock;
        private readonly Mock<IDatabase> _redisDatabaseMock;
        private readonly Mock<ILogger<ApiKeysService>> _loggerMock;
        private readonly ApiKeysService _service;
        private readonly Guid _testUserId = Guid.NewGuid();

        public ApiKeysServiceTests()
        {
            var options = new DbContextOptionsBuilder<ApiKeysDbContext>()
                .UseInMemoryDatabase(databaseName: Guid.NewGuid().ToString())
                .Options;
            _dbContext = new ApiKeysDbContext(options);

            _redisMock = new Mock<IConnectionMultiplexer>();
            _redisDatabaseMock = new Mock<IDatabase>();
            _redisMock.Setup(r => r.GetDatabase(It.IsAny<int>(), It.IsAny<object>())).Returns(_redisDatabaseMock.Object);

            _loggerMock = new Mock<ILogger<ApiKeysService>>();

            _service = new ApiKeysService(_dbContext, _redisMock.Object, _loggerMock.Object);
        }

        public void Dispose()
        {
            _dbContext.Dispose();
        }

        [Fact]
        public async Task CreateApiKey_WithValidRequest_ReturnsApiKeyResponse()
        {
            // Arrange
            var request = new CreateApiKeyRequest
            {
                Name = "Test Key",
                Scopes = new List<string> { "read:deployments", "write:webhooks" },
                ExpiresAt = DateTime.UtcNow.AddYears(1),
                RateLimit = 1000
            };

            // Act
            var result = await _service.CreateApiKeyAsync(_testUserId, request);

            // Assert
            Assert.NotNull(result);
            Assert.NotNull(result.ApiKeyId);
            Assert.NotNull(result.Key);
            Assert.StartsWith("sk_live_", result.Key);
            Assert.Equal(request.Name, result.Key); // Name is not in response, but we check other properties
            Assert.Equal(request.RateLimit, result.RateLimit);
            Assert.Equal(request.ExpiresAt, result.ExpiresAt);
            Assert.Equal(DateTime.UtcNow.Date, result.CreatedAt.Date); // Created today

            // Verify in database
            var apiKey = await _dbContext.ApiKeys.FindAsync(Guid.Parse(result.ApiKeyId));
            Assert.NotNull(apiKey);
            Assert.Equal(_testUserId, apiKey.UserId);
            Assert.Equal(request.Name, apiKey.Name);
            Assert.True(BCrypt.Net.BCrypt.Verify(result.Key, apiKey.KeySecretHash));
            Assert.Equal(request.Scopes.Count, JsonSerializer.Deserialize<List<string>>(apiKey.ScopesJson)!.Count);
            Assert.Equal(request.RateLimit, apiKey.RateLimit);
            Assert.Equal(request.ExpiresAt, apiKey.ExpiresAt);
            Assert.True(apiKey.IsActive);
        }

        [Fact]
        public async Task CreateApiKey_WithNullRequest_ThrowsArgumentNullException()
        {
            await Assert.ThrowsAsync<ArgumentNullException>(() => 
                _service.CreateApiKeyAsync(_testUserId, null!));
        }

        [Fact]
        public async Task CreateApiKey_WithEmptyName_ThrowsArgumentException()
        {
            var request = new CreateApiKeyRequest
            {
                Name = "",
                Scopes = new List<string> { "read:deployments" },
                RateLimit = 1000
            };

            await Assert.ThrowsAsync<ArgumentException>(() => 
                _service.CreateApiKeyAsync(_testUserId, request));
        }

        [Fact]
        public async Task CreateApiKey_WithEmptyScopes_ThrowsArgumentException()
        {
            var request = new CreateApiKeyRequest
            {
                Name = "Test",
                Scopes = new List<string>(),
                RateLimit = 1000
            };

            await Assert.ThrowsAsync<ArgumentException>(() => 
                _service.CreateApiKeyAsync(_testUserId, request));
        }

        [Fact]
        public async Task CreateApiKey_WithNonPositiveRateLimit_ThrowsArgumentException()
        {
            var request = new CreateApiKeyRequest
            {
                Name = "Test",
                Scopes = new List<string> { "read:deployments" },
                RateLimit = 0
            };

            await Assert.ThrowsAsync<ArgumentException>(() => 
                _service.CreateApiKeyAsync(_testUserId, request));
        }

        [Fact]
        public async Task ListApiKeys_ForUserWithKeys_ReturnsMaskedKeys()
        {
            // Arrange
            await CreateTestApiKeyInDb("Key 1", new List<string> { "read:deployments" });
            await CreateTestApiKeyInDb("Key 2", new List<string> { "write:deployments" });

            // Act
            var result = await _service.ListApiKeysAsync(_testUserId);

            // Assert
            Assert.NotNull(result);
            Assert.Equal(2, result.Keys.Count);
            Assert.All(result.Keys, k =>
            {
                Assert.NotNull(k.ApiKeyId);
                Assert.DoesNotContain("sk_live_", k.ApiKeyId); // ID is GUID, not key
                Assert.Contains(k.Name, new[] { "Key 1", "Key 2" });
                Assert.NotEmpty(k.Scopes);
                Assert.Equal(1000, k.RateLimit); // Default from test helper
                Assert.False(k.IsActive == false); // All active by default
            });
        }

        [Fact]
        public async Task ListApiKeys_ForUserWithNoKeys_ReturnsEmptyList()
        {
            // Act
            var result = await _service.ListApiKeysAsync(_testUserId);

            // Assert
            Assert.NotNull(result);
            Assert.Empty(result.Keys);
        }

        [Fact]
        public async Task RevokeApiKey_ExistingKeyForUser_SetsIsActiveFalse()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("To Revoke", new List<string> { "read:deployments" });

            // Act
            var result = await _service.RevokeApiKeyAsync(_testUserId, apiKey.Id);

            // Assert
            Assert.True(result.Success);
            Assert.Equal(DateTime.UtcNow.Date, result.RevokedAt.Date);

            var updatedKey = await _dbContext.ApiKeys.FindAsync(apiKey.Id);
            Assert.False(updatedKey.IsActive);
        }

        [Fact]
        public async Task RevokeApiKey_NonExistingKeyForUser_ThrowsKeyNotFoundException()
        {
            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.RevokeApiKeyAsync(_testUserId, Guid.NewGuid()));
        }

        [Fact]
        public async Task RevokeApiKey_KeyBelongingToOtherUser_ThrowsKeyNotFoundException()
        {
            // Arrange
            var otherUserId = Guid.NewGuid();
            var apiKey = await CreateTestApiKeyInDb("Other User Key", new List<string> { "read:deployments" }, otherUserId);

            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.RevokeApiKeyAsync(_testUserId, apiKey.Id));
        }

        [Fact]
        public async Task RotateApiKey_ExistingKeyForUser_ReturnsNewKeyAndRevokesOld()
        {
            // Arrange
            var originalKey = await CreateTestApiKeyInDb("To Rotate", new List<string> { "read:deployments" });
            var originalKeyString = $"sk_live_{originalKey.KeyPrefix}xxxx"; // Simulate full key for bcrypt

            // Act
            var result = await _service.RotateApiKeyAsync(_testUserId, originalKey.Id);

            // Assert
            Assert.NotNull(result);
            Assert.NotNull(result.NewKey);
            Assert.StartsWith("sk_live_", result.NewKey);
            Assert.Equal(DateTime.UtcNow.Date, result.OldKeyRevokedAt.Date);
            Assert.Equal(DateTime.UtcNow.AddHours(24).Date, result.GracePeriodEndsAt.Date);

            // Verify old key is inactive in DB
            var oldKey = await _dbContext.ApiKeys.FindAsync(originalKey.Id);
            Assert.False(oldKey.IsActive);
            Assert.NotEqual(originalKey.KeyPrefix, oldKey.KeyPrefix); // Prefix changed
            Assert.True(BCrypt.Net.BCrypt.Verify(result.NewKey, oldKey.KeySecretHash)); // New key matches hash

            // Verify new key works (by checking prefix and hash)
            Assert.Equal(oldKey.KeyPrefix, result.NewKey.Substring(8, 8));
        }

        [Fact]
        public async Task RotateApiKey_NonExistingKeyForUser_ThrowsKeyNotFoundException()
        {
            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.RotateApiKeyAsync(_testUserId, Guid.NewGuid()));
        }

        [Fact]
        public async Task RotateApiKey_KeyBelongingToOtherUser_ThrowsKeyNotFoundException()
        {
            // Arrange
            var otherUserId = Guid.NewGuid();
            var apiKey = await CreateTestApiKeyInDb("Other User Key", new List<string> { "read:deployments" }, otherUserId);

            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.RotateApiKeyAsync(_testUserId, apiKey.Id));
        }

        [Fact]
        public async Task ValidateApiKey_ValidKeyAndScope_ReturnsValid()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("Valid Key", new List<string> { "get:deployments" });
            var fullKey = $"sk_live_{apiKey.KeyPrefix}xxxxxxxxxxxxxxxx"; // 24 bytes base64 -> 32 chars, plus prefix
            // Adjust to match actual key format: our GenerateApiKey makes 24 bytes -> 32 base64 chars -> total 40 chars
            // We'll create a valid key by using the actual generation method via reflection? 
            // Instead, we'll use the service's internal method via a test helper or just verify with the stored hash.
            // Since we have the apiKey from DB, we can construct a key that will verify:
            // We know the prefix and we can append enough chars to make a verifiable key.
            // But BCrypt.Verify expects the exact original key. Let's instead test via the service's internal logic by mocking?
            // Better: we know the key that was generated in CreateTestApiKeyInDb is not stored, only hash.
            // We'll create a key that matches the hash by using the same random generation? Not feasible in test.
            // Alternative: test the validation logic directly by setting up the scenario.
            // Let's change approach: we'll test ValidateApiKeyAsync by providing a key that we know will work because we just created it.
            // But we don't have the original key string from CreateTestApiKeyInDb.
            // We'll modify CreateTestApiKeyInDb to return the key string as well.

            // For now, let's skip this test and come back to it after adjusting the helper.
            // Actually, we can test the validation by using the service's own CreateApiKeyAsync to get a real key.
            var createRequest = new CreateApiKeyRequest
            {
                Name = "Validation Test",
                Scopes = new List<string> { "get:deployments" },
                RateLimit = 1000
            };
            var createResult = await _service.CreateApiKeyAsync(_testUserId, createRequest);
            var validKey = createResult.Key;

            // Act
            var result = await _service.ValidateApiKeyAsync(validKey, "/deployments", HttpMethod.Get);

            // Assert
            Assert.True(result.IsValid);
            Assert.Null(result.ErrorMessage);
            Assert.Null(result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_NullKey_ReturnsInvalidWithUnauthorized()
        {
            // Act
            var result = await _service.ValidateApiKeyAsync(null!, "/deployments", HttpMethod.Get);

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("Missing API key", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_InvalidFormatKey_ReturnsInvalidWithUnauthorized()
        {
            // Act
            var result = await _service.ValidateApiKeyAsync("invalid_key", "/deployments", HttpMethod.Get);

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("Invalid API key format", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_TooShortKey_ReturnsInvalidWithUnauthorized()
        {
            // Act
            var result = await _service.ValidateApiKeyAsync("sk_live_123", "/deployments", HttpMethod.Get);

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("API key too short", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_ValidKeyButWrongPrefix_ReturnsInvalidWithUnauthorized()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("Valid Key", new List<string> { "get:deployments" });
            // Use a different prefix that doesn't exist in DB
            var wrongKey = $"sk_live_{apiKey.KeyPrefix.Substring(0, 4)}xxxxxxxxxxxxxxxx"; // Still 8 chars prefix but different

            // Act
            var result = await _service.ValidateApiKeyAsync(wrongKey, "/deployments", HttpMethod.Get);

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("Invalid API key", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_ValidKeyButFailedBcryptVerify_ReturnsInvalidWithUnauthorized()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("Valid Key", new List<string> { "get:deployments" });
            // Create a key that has the correct prefix but wrong secret (will fail bcrypt)
            var wrongKey = $"sk_live_{apiKey.KeyPrefix}wrongsecrethere123"; // Same prefix, different rest

            // Act
            var result = await _service.ValidateApiKeyAsync(wrongKey, "/deployments", HttpMethod.Get);

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("Invalid API key", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_ExpiredKey_ReturnsInvalidWithUnauthorized()
        {
            // Arrange
            var expiredDate = DateTime.UtcNow.AddDays(-1);
            var apiKey = await CreateTestApiKeyInDb("Expired Key", new List<string> { "get:deployments" }, expiresAt: expiredDate);
            var createRequest = new CreateApiKeyRequest
            {
                Name = "Expired Key Test",
                Scopes = new List<string> { "get:deployments" },
                RateLimit = 1000,
                ExpiresAt = expiredDate
            };
            var createResult = await _service.CreateApiKeyAsync(_testUserId, createRequest);
            var expiredKey = createResult.Key;

            // Act
            var result = await _service.ValidateApiKeyAsync(expiredKey, "/deployments", HttpMethod.Get);

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("API key expired", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Unauthorized, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_ValidKeyButInsufficientScope_ReturnsInvalidWithForbidden()
        {
            // Arrange
            var createRequest = new CreateApiKeyRequest
            {
                Name = "Scope Test",
                Scopes = new List<string> { "read:deployments" }, // Only read
                RateLimit = 1000
            };
            var createResult = await _service.CreateApiKeyAsync(_testUserId, createRequest);
            var key = createResult.Key;

            // Act
            var result = await _service.ValidateApiKeyAsync(key, "/deployments", HttpMethod.Post); // Requires write

            // Assert
            Assert.False(result.IsValid);
            Assert.Equal("Insufficient scope", result.ErrorMessage);
            Assert.Equal(HttpStatusCode.Forbidden, result.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_ValidKeyButRateLimitExceeded_ReturnsInvalidWith429()
        {
            // Arrange
            var createRequest = new CreateApiKeyRequest
            {
                Name = "Rate Limit Test",
                Scopes = new List<string> { "get:deployments" },
                RateLimit = 2 // Very low for testing
            };
            var createResult = await _service.CreateApiKeyAsync(_testUserId, createRequest);
            var key = createResult.Key;

            // Mock Redis to return increasing counts
            _redisDatabaseMock.SetupSequence(r => r.StringIncrementAsync(It.IsAny<RedisKey>(), It.IsAny<long>(), It.IsAny<CommandFlags>()))
                .ReturnsAsync(1L)
                .ReturnsAsync(2L)
                .ReturnsAsync(3L); // Third call exceeds limit of 2

            // Act
            var result1 = await _service.ValidateApiKeyAsync(key, "/deployments", HttpMethod.Get);
            var result2 = await _service.ValidateApiKeyAsync(key, "/deployments", HttpMethod.Get);
            var result3 = await _service.ValidateApiKeyAsync(key, "/deployments", HttpMethod.Get);

            // Assert
            Assert.True(result1.IsValid);
            Assert.True(result2.IsValid);
            Assert.False(result3.IsValid);
            Assert.Equal("Rate limit exceeded", result3.ErrorMessage);
            Assert.Equal((HttpStatusCode)429, result3.StatusCode);
        }

        [Fact]
        public async Task ValidateApiKey_ValidKey_UpdatesLastUsedAt()
        {
            // Arrange
            var createRequest = new CreateApiKeyRequest
            {
                Name = "Last Used Test",
                Scopes = new List<string> { "get:deployments" },
                RateLimit = 1000
            };
            var createResult = await _service.CreateApiKeyAsync(_testUserId, createRequest);
            var key = createResult.Key;

            // Act
            await _service.ValidateApiKeyAsync(key, "/deployments", HttpMethod.Get);

            // Assert
            var apiKey = await _dbContext.ApiKeys.FindAsync(Guid.Parse(createResult.ApiKeyId));
            Assert.NotNull(apiKey.LastUsedAt);
            Assert.InRange(apiKey.LastUsedAt.Value, DateTime.UtcNow.AddSeconds(-5), DateTime.UtcNow.AddSeconds(5));
        }

        [Fact]
        public async Task LogApiKeyUsageAsync_AddsUsageRecord()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("Usage Test", new List<string> { "get:deployments" });

            // Act
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/deployments", HttpMethod.Get, 200);

            // Assert
            var usage = await _dbContext.ApiKeyUsages.FirstOrDefaultAsync();
            Assert.NotNull(usage);
            Assert.Equal(apiKey.Id, usage.ApiKeyId);
            Assert.Equal("/deployments", usage.Endpoint);
            Assert.Equal("GET", usage.Method);
            Assert.Equal(200, usage.Status);
        }

        [Fact]
        public async Task GetApiKeyUsageAsync_ForExistingKey_ReturnsUsageStats()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("Usage Stats Test", new List<string> { "get:deployments" });
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/deployments", HttpMethod.Get, 200);
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/deployments", HttpMethod.Get, 200);
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/webhooks", HttpMethod.Post, 200);
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/webhooks", HttpMethod.Post, 429); // Rate limit hit
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/nonexistent", HttpMethod.Get, 404);

            // Act
            var result = await _service.GetApiKeyUsageAsync(_testUserId, apiKey.Id, null, null);

            // Assert
            Assert.NotNull(result);
            Assert.Equal(apiKey.Id.ToString(), result.ApiKeyId);
            Assert.Equal(5, result.TotalRequests);
            Assert.Equal(2, result.RequestsByEndpoint["GET /deployments"]);
            Assert.Equal(2, result.RequestsByEndpoint["POST /webhooks"]);
            Assert.Equal(1, result.RequestsByEndpoint["GET /nonexistent"]);
            Assert.Equal(1, result.RateLimitHits); // One 429
            Assert.Equal(1, result.Errors["404"]); // One 404
            Assert.DoesNotContain("200", result.Errors.Keys); // Successes not in errors
        }

        [Fact]
        public async Task GetApiKeyUsageAsync_WithDateRange_FiltersByTimestamp()
        {
            // Arrange
            var apiKey = await CreateTestApiKeyInDb("Date Range Test", new List<string> { "get:deployments" });
            var now = DateTime.UtcNow;
            var yesterday = now.AddDays(-1);
            var tomorrow = now.AddDays(1);

            // Log usages at different times
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/deployments", HttpMethod.Get, 200); // Now
            await _service.LogApiKeyUsageAsync(apiKey.Id, "/deployments", HttpMethod.Get, 200); // Now
            // Manually insert an old usage to bypass service timestamp
            _dbContext.ApiKeyUsages.Add(new ApiKeyUsage
            {
                Id = Guid.NewGuid(),
                ApiKeyId = apiKey.Id,
                Endpoint = "/deployments",
                Method = "GET",
                Status = 200,
                Timestamp = yesterday
            });
            await _dbContext.SaveChangesAsync();

            // Act
            var result = await _service.GetApiKeyUsageAsync(_testUserId, apiKey.Id, yesterday.AddHours(1), now.AddHours(1));

            // Assert
            Assert.Equal(2, result.TotalRequests); // Only the two from 'now', not yesterday's
        }

        [Fact]
        public async Task GetApiKeyUsageAsync_NonExistingKeyForUser_ThrowsKeyNotFoundException()
        {
            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.GetApiKeyUsageAsync(_testUserId, Guid.NewGuid(), null, null));
        }

        [Fact]
        public async Task GetApiKeyUsageAsync_KeyBelongingToOtherUser_ThrowsKeyNotFoundException()
        {
            // Arrange
            var otherUserId = Guid.NewGuid();
            var apiKey = await CreateTestApiKeyInDb("Other User Key", new List<string> { "get:deployments" }, otherUserId);

            // Act & Assert
            await Assert.ThrowsAsync<KeyNotFoundException>(() => 
                _service.GetApiKeyUsageAsync(_testUserId, apiKey.Id, null, null));
        }

        [Fact]
        public async Task AdminListApiKeysAsync_NoFilters_ReturnsAllKeys()
        {
            // Arrange
            var user1Id = Guid.NewGuid();
            var user2Id = Guid.NewGuid();
            await CreateTestApiKeyInDb("User1 Key", new List<string> { "get:deployments" }, user1Id);
            await CreateTestApiKeyInDb("User1 Key 2", new List<string> { "post:deployments" }, user1Id);
            await CreateTestApiKeyInDb("User2 Key", new List<string> { "get:webhooks" }, user2Id);

            // Act
            var result = await _service.AdminListApiKeysAsync(null, null);

            // Assert
            Assert.NotNull(result);
            Assert.Equal(3, result.Keys.Count);
            Assert.Equal(3, result.Total);
        }

        [Fact]
        public async Task AdminListApiKeysAsync_WithUserIdFilter_ReturnsOnlyUsersKeys()
        {
            // Arrange
            var user1Id = Guid.NewGuid();
            var user2Id = Guid.NewGuid();
            await CreateTestApiKeyInDb("User1 Key", new List<string> { "get:deployments" }, user1Id);
            await CreateTestApiKeyInDb("User2 Key", new List<string> { "get:webhooks" }, user2Id);

            // Act
            var result = await _service.AdminListApiKeysAsync(user1Id, null);

            // Assert
            Assert.NotNull(result);
            Assert.Equal(1, result.Keys.Count);
            Assert.Equal(1, result.Total);
            Assert.Contains(result.Keys, k => k.Name == "User1 Key");
        }

        [Fact]
        public async Task AdminListApiKeysAsync_WithStatusActiveFilter_ReturnsOnlyActiveKeys()
        {
            // Arrange
            var activeKey = await CreateTestApiKeyInDb("Active Key", new List<string> { "get:deployments" });
            var revokedKey = await CreateTestApiKeyInDb("Revoked Key", new List<string> { "get:deployments" });
            await _service.RevokeApiKeyAsync(_testUserId, revokedKey.Id);

            // Act
            var result = await _service.AdminListApiKeysAsync(null, "active");

            // Assert
            Assert.NotNull(result);
            Assert.Equal(1, result.Keys.Count);
            Assert.Equal(1, result.Total);
            Assert.Contains(result.Keys, k => k.Name == "Active Key");
            Assert.DoesNotContain(result.Keys, k => k.Name == "Revoked Key");
        }

        [Fact]
        public async Task AdminListApiKeysAsync_WithStatusInactiveFilter_ReturnsOnlyInactiveKeys()
        {
            // Arrange
            var activeKey = await CreateTestApiKeyInDb("Active Key", new List<string> { "get:deployments" });
            var revokedKey = await CreateTestApiKeyInDb("Revoked Key", new List<string> { "get:deployments" });
            await _service.RevokeApiKeyAsync(_testUserId, revokedKey.Id);

            // Act
            var result = await _service.AdminListApiKeysAsync(null, "inactive");

            // Assert
            Assert.NotNull(result);
            Assert.Equal(1, result.Keys.Count);
            Assert.Equal(1, result.Total);
            Assert.Contains(result.Keys, k => k.Name == "Revoked Key");
            Assert.DoesNotContain(result.Keys, k => k.Name == "Active Key");
        }

        // Helper methods
        private async Task<ApiKey> CreateTestApiKeyInDb(string name, List<string> scopes, Guid? userId = null, DateTime? expiresAt = null)
        {
            var apiKey = new ApiKey
            {
                Id = Guid.NewGuid(),
                UserId = userId ?? _testUserId,
                Name = name,
                KeyPrefix = "testpref", // Fixed prefix for testing - note: in real code this is generated
                KeySecretHash = BCrypt.Net.BCrypt.HashPassword($"sk_live_testpref{new string('x', 24)}"), // Hash of a dummy key
                ScopesJson = JsonSerializer.Serialize(scopes),
                RateLimit = 1000,
                ExpiresAt = expiresAt,
                IsActive = true,
                CreatedAt = DateTime.UtcNow
            };

            _dbContext.ApiKeys.Add(apiKey);
            await _dbContext.SaveChangesAsync();
            return apiKey;
        }
    }
}