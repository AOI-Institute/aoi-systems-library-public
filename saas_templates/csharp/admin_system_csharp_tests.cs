using System;
using System.Collections.Generic;
using Xunit;
using AdminSystem;

public class AdminControllerTests
{
    private readonly AdminController _controller = new AdminController();

    private const string ValidCsrf = "valid_csrf_token";

    private User CreateOwner(string email = "owner@example.com")
    {
        var owner = new User
        {
            Email = email,
            Name = "Owner",
            Tier = Role.Owner
        };
        Database.Users.Add(owner);
        return owner;
    }

    private User CreateAdmin(string email = "admin@example.com")
    {
        var admin = new User
        {
            Email = email,
            Name = "Admin",
            Tier = Role.Admin
        };
        Database.Users.Add(admin);
        return admin;
    }

    private User CreateUser(string email = "user@example.com")
    {
        var user = new User
        {
            Email = email,
            Name = "User",
            Tier = Role.User
        };
        Database.Users.Add(user);
        return user;
    }

    private Customer CreateCustomer()
    {
        var cust = new Customer
        {
            Email = "cust@example.com",
            Name = "Customer",
            Tier = Role.User,
            StripeSubscriptionId = "sub_123"
        };
        Database.Customers.Add(cust);
        return cust;
    }

    private Deployment CreateDeployment(Guid customerId, string domain = "example.com")
    {
        var dep = new Deployment
        {
            CustomerId = customerId,
            Domain = domain,
            Tier = Role.User,
            ThemeId = Guid.NewGuid()
        };
        Database.Deployments.Add(dep);
        return dep;
    }

    // ---------- USER TESTS ----------
    [Fact]
    public void CreateUser_HappyPath()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var result = _controller.CreateUser(ValidCsrf, "new@example.com", "New User", "User", true);
        Assert.True(((dynamic)result).success);
        Assert.Equal("new@example.com", ((dynamic)result).email);
        Assert.Equal("User", ((dynamic)result).tier);
    }

    [Fact]
    public void CreateUser_DuplicateEmail()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;
        CreateUser("dup@example.com");

        var ex = Assert.Throws<ApiException>(() =>
            _controller.CreateUser(ValidCsrf, "dup@example.com", "Dup", "User", false));
        Assert.Equal("email_exists", ex.Code);
    }

    [Fact]
    public void CreateUser_NonOwner()
    {
        var admin = CreateAdmin();
        AuthContext.CurrentUser = admin;

        var ex = Assert.Throws<ApiException>(() =>
            _controller.CreateUser(ValidCsrf, "test@example.com", "Test", "User", false));
        Assert.Equal("owner_only", ex.Code);
    }

    [Fact]
    public void ResetPassword_HappyPath()
    {
        var owner = CreateOwner();
        var user = CreateUser("reset@example.com");
        AuthContext.CurrentUser = owner;

        var result = _controller.ResetPassword(ValidCsrf, user.UserId);
        Assert.True(((dynamic)result).success);
        Assert.Equal("reset_email_sent", ((dynamic)result).status);
    }

    [Fact]
    public void ResetPassword_OwnAccount()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var ex = Assert.Throws<ApiException>(() =>
            _controller.ResetPassword(ValidCsrf, owner.UserId));
        Assert.Equal("cannot_reset_own_password", ex.Code);
    }

    [Fact]
    public void ChangeRole_HappyPath()
    {
        var owner = CreateOwner();
        var user = CreateUser("changerole@example.com");
        AuthContext.CurrentUser = owner;

        var result = _controller.ChangeUserRole(ValidCsrf, user.UserId, "Admin");
        Assert.True(((dynamic)result).success);
        Assert.Equal("User", ((dynamic)result).old_tier);
        Assert.Equal("Admin", ((dynamic)result).new_tier);
    }

    [Fact]
    public void ChangeRole_LastOwner()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var ex = Assert.Throws<ApiException>(() =>
            _controller.ChangeUserRole(ValidCsrf, owner.UserId, "User"));
        Assert.Equal("cannot_change_own_role", ex.Code);
    }

    [Fact]
    public void SuspendUser_HappyPath()
    {
        var owner = CreateOwner();
        var user = CreateUser("suspend@example.com");
        AuthContext.CurrentUser = owner;

        var result = _controller.SuspendUser(ValidCsrf, user.UserId, "Violation");
        Assert.True(((dynamic)result).success);
        Assert.True(((dynamic)result).suspended);
    }

    [Fact]
    public void SuspendUser_OwnAccount()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var ex = Assert.Throws<ApiException>(() =>
            _controller.SuspendUser(ValidCsrf, owner.UserId, "Self"));
        Assert.Equal("cannot_suspend_yourself", ex.Code);
    }

    // ---------- CUSTOMER TESTS ----------
    [Fact]
    public void Customers_List_Pagination()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        // Add 30 customers
        for (int i = 0; i < 30; i++)
        {
            Database.Customers.Add(new Customer
            {
                Email = $"c{i}@example.com",
                Name = $"Cust{i}",
                Tier = Role.User
            });
        }

        var result = _controller.ListCustomers(ValidCsrf, page: 2, pageSize: 10) as List<object>;
        Assert.Equal(10, result.Count);
    }

    [Fact]
    public void Customer_Detail_AllFields()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;
        var cust = CreateCustomer();

        var result = _controller.GetCustomerDetail(ValidCsrf, cust.CustomerId);
        Assert.Equal(cust.CustomerId, ((dynamic)result).customer_id);
        Assert.Equal(cust.Email, ((dynamic)result).email);
        Assert.Equal(cust.Name, ((dynamic)result).name);
    }

    [Fact]
    public void ChangePlan_StripeCalledAndAuditLogged()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;
        var cust = CreateCustomer();

        var result = _controller.ChangeCustomerPlan(ValidCsrf, cust.CustomerId, "Admin");
        Assert.True(((dynamic)result).success);
        Assert.Equal("User", ((dynamic)result).old_tier);
        Assert.Equal("Admin", ((dynamic)result).new_tier);
    }

    [Fact]
    public void QueueRefund_CreatedWithQueuedStatus()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var refundResult = _controller.QueueRefund(ValidCsrf, Guid.NewGuid(), 100.00m, "Customer request");
        Assert.True(((dynamic)refundResult).success);
        Assert.Equal("queued", ((dynamic)refundResult).status);
        Assert.Equal(100.00m, ((dynamic)refundResult).amount);
    }

    // ---------- DEPLOYMENT TESTS ----------
    [Fact]
    public void CreateDeployment_HappyPath()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;
        var cust = CreateCustomer();

        var result = _controller.CreateDeployment(ValidCsrf, cust.CustomerId, "newsite.com", "User", Guid.NewGuid());
        Assert.True(((dynamic)result).success);
        Assert.Equal("newsite.com", ((dynamic)result).domain);
    }

    [Fact]
    public void PublishDeployment_DoubleGateChecked()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;
        var cust = CreateCustomer();
        var dep = CreateDeployment(cust.CustomerId, "publish.com");

        var result = _controller.PublishDeployment(ValidCsrf, dep.DeploymentId);
        Assert.True(((dynamic)result).success);
        Assert.Equal("live", ((dynamic)result).status);
    }

    // ---------- GOVERNANCE TESTS ----------
    [Fact]
    public void Governance_Approve_ExecutesAndLogs()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var ga = new GovernanceAction
        {
            ActionType = "test_action",
            ActorId = owner.UserId,
            TargetResourceId = Guid.NewGuid(),
            Reason = "Testing"
        };
        Database.GovernanceActions.Add(ga);

        var result = _controller.DecideGovernanceAction(ValidCsrf, ga.ActionId, "approve");
        Assert.True(((dynamic)result).success);
        Assert.Equal("approved", ((dynamic)result).status);
    }

    [Fact]
    public void Governance_Reject_LogsReason()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        var ga = new GovernanceAction
        {
            ActionType = "test_action",
            ActorId = owner.UserId,
            TargetResourceId = Guid.NewGuid(),
            Reason = "Testing"
        };
        Database.GovernanceActions.Add(ga);

        var result = _controller.DecideGovernanceAction(ValidCsrf, ga.ActionId, "reject", "Not needed");
        Assert.True(((dynamic)result).success);
        Assert.Equal("rejected", ((dynamic)result).status);
    }

    [Fact]
    public void AuditLog_Search_FiltersAndPagination()
    {
        var owner = CreateOwner();
        AuthContext.CurrentUser = owner;

        // Insert audit entries
        for (int i = 0; i < 5; i++)
        {
            AuditLogger.Log("test_action", owner.UserId, "test", Guid.NewGuid(),
                oldValue: $"old{i}", newValue: $"new{i}");
        }

        var result = _controller.SearchAuditLog(ValidCsrf, actionType: "test_action", limit: 3, offset: 1) as List<object>;
        Assert.Equal(3, result.Count);
    }
}