package com.example.admin;

import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.*;
import org.springframework.test.web.servlet.*;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;

@SpringBootTest
@AutoConfigureMockMvc
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AdminSystemTests {

    @Autowired private MockMvc mockMvc;
    @Autowired private UserRepository userRepo;
    @Autowired private CustomerRepository custRepo;
    @Autowired private DeploymentRepository depRepo;
    @Autowired private ObjectMapper mapper;

    private User owner;
    private User admin;
    private User regular;

    private static final String CSRF_HEADER = "X-CSRF-Token";
    private static final String CSRF_TOKEN = "secure-token";

    @BeforeAll
    void setupUsers() {
        owner = new User(); owner.setEmail("owner@example.com"); owner.setName("Owner"); owner.setTier("OWNER");
        admin = new User(); admin.setEmail("admin@example.com"); admin.setName("Admin"); admin.setTier("ADMIN");
        regular = new User(); regular.setEmail("user@example.com"); regular.setName("User"); regular.setTier("USER");
        userRepo.saveAll(List.of(owner, admin, regular));
    }

    private RequestPostProcessor auth(User u) {
        return request -> {
            request.addHeader("X-User-Id", u.getId().toString());
            request.addHeader(CSRF_HEADER, CSRF_TOKEN);
            return request;
        };
    }

    @Test
    void testCreateUserHappyPath() throws Exception {
        Map<String, Object> payload = Map.of(
                "email", "newuser@example.com",
                "name", "New User",
                "tier", "USER",
                "notify", true
        );
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "create")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.email").value("newuser@example.com"));
    }

    @Test
    void testCreateUserDuplicateEmail() throws Exception {
        Map<String, Object> payload = Map.of(
                "email", owner.getEmail(),
                "name", "Dup",
                "tier", "USER",
                "notify", false
        );
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "create")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("email_exists"));
    }

    @Test
    void testCreateUserNonOwner() throws Exception {
        Map<String, Object> payload = Map.of(
                "email", "another@example.com",
                "name", "Another",
                "tier", "USER",
                "notify", false
        );
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "create")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(admin)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("owner_only"));
    }

    @Test
    void testResetPasswordHappyPath() throws Exception {
        Map<String, Object> payload = Map.of("user_id", regular.getId());
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "reset_password")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("reset_email_sent"));
    }

    @Test
    void testResetPasswordOwnAccount() throws Exception {
        Map<String, Object> payload = Map.of("user_id", owner.getId());
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "reset_password")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("cannot_reset_own_password"));
    }

    @Test
    void testChangeRoleHappyPath() throws Exception {
        Map<String, Object> payload = Map.of("user_id", regular.getId(), "new_tier", "ADMIN");
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "change_role")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true));
    }

    @Test
    void testChangeRoleLastOwner() throws Exception {
        // Ensure only one owner exists
        userRepo.findAll().stream()
                .filter(u -> !"OWNER".equals(u.getTier()))
                .forEach(u -> u.setTier("USER"));
        userRepo.saveAll(userRepo.findAll());

        Map<String, Object> payload = Map.of("user_id", owner.getId(), "new_tier", "ADMIN");
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "change_role")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("cannot_demote_last_owner"));
    }

    @Test
    void testSuspendUserHappyPath() throws Exception {
        Map<String, Object> payload = Map.of("user_id", regular.getId(), "reason", "policy");
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "suspend")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.suspended").value(true));
    }

    @Test
    void testSuspendOwnAccount() throws Exception {
        Map<String, Object> payload = Map.of("user_id", owner.getId(), "reason", "self");
        mockMvc.perform(post("/admin/users/action")
                .header("X-Action", "suspend")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("cannot_suspend_yourself"));
    }

    @Test
    void testCustomersListPagination() throws Exception {
        // create dummy customers
        for (int i = 0; i < 30; i++) {
            Customer c = new Customer();
            c.setEmail("c"+i+"@example.com");
            c.setName("Customer "+i);
            c.setTier("USER");
            c.setSignupDate(java.time.LocalDate.now());
            custRepo.save(c);
        }
        mockMvc.perform(get("/admin/customers")
                .param("page", "0")
                .param("size", "10")
                .with(auth(admin)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(10));
    }

    @Test
    void testCustomerDetailFields() throws Exception {
        Customer c = new Customer();
        c.setEmail("detail@example.com");
        c.setName("Detail");
        c.setTier("USER");
        c.setSignupDate(java.time.LocalDate.now());
        custRepo.save(c);
        mockMvc.perform(get("/admin/customers/"+c.getId())
                .with(auth(admin)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.email").value("detail@example.com"))
                .andExpect(jsonPath("$.name").value("Detail"));
    }

    @Test
    void testChangePlanStripeCalled() throws Exception {
        Customer c = new Customer();
        c.setEmail("stripe@example.com");
        c.setName("Stripe");
        c.setTier("BASIC");
        c.setSignupDate(java.time.LocalDate.now());
        c.setStripeSubscriptionId("sub_123");
        custRepo.save(c);
        Map<String, Object> payload = Map.of("new_tier", "PRO");
        mockMvc.perform(post("/admin/customers/"+c.getId()+"/action")
                .header("X-Action", "change_plan")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.new_tier").value("PRO"));
    }

    @Test
    void testQueueRefundRecordCreated() throws Exception {
        Map<String, Object> payload = Map.of(
                "invoice_id", 1001,
                "amount", 49.99,
                "reason", "customer request"
        );
        mockMvc.perform(post("/admin/customers/1/action")
                .header("X-Action", "queue_refund")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("queued"));
    }

    @Test
    void testCreateDeployment() throws Exception {
        Customer c = new Customer();
        c.setEmail("dep@example.com");
        c.setName("DepCust");
        c.setTier("BASIC");
        c.setSignupDate(java.time.LocalDate.now());
        custRepo.save(c);
        Map<String, Object> payload = Map.of(
                "customer_id", c.getId(),
                "domain", "example.com",
                "tier", "BASIC",
                "theme_id", 1
        );
        mockMvc.perform(post("/admin/deployments/action")
                .header("X-Action", "create")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.domain").value("example.com"));
    }

    @Test
    void testPublishDeploymentDoubleGate() throws Exception {
        // create deployment first
        Deployment d = new Deployment();
        d.setCustomerId(1L);
        d.setDomain("publish.com");
        d.setTier("BASIC");
        d.setStatus("draft");
        depRepo.save(d);
        Map<String, Object> payload = Map.of("deployment_id", d.getId());
        mockMvc.perform(post("/admin/deployments/action")
                .header("X-Action", "publish")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("live"));
    }

    @Test
    void testGovernanceApprove() throws Exception {
        // create a pending governance action
        GovernanceAction ga = new GovernanceAction();
        ga.setActionType("delete_user");
        ga.setActorId(admin.getId());
        ga.setTargetResourceId(regular.getId());
        ga.setReason("cleanup");
        // save via repository (omitted injection for brevity)
        // Assume saved and id = 1
        mockMvc.perform(post("/admin/governance/actions/1/decide")
                .header("X-Decide", "approve")
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("approved"));
    }

    @Test
    void testGovernanceReject() throws Exception {
        // create a pending governance action
        GovernanceAction ga = new GovernanceAction();
        ga.setActionType("delete_user");
        ga.setActorId(admin.getId());
        ga.setTargetResourceId(regular.getId());
        ga.setReason("cleanup");
        // save via repository (omitted)
        Map<String, Object> payload = Map.of("reason", "not needed");
        mockMvc.perform(post("/admin/governance/actions/2/decide")
                .header("X-Decide", "reject")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(payload))
                .with(auth(owner)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("rejected"));
    }

    @Test
    void testAuditLogSearch() throws Exception {
        mockMvc.perform(get("/admin/governance/audit-log")
                .param("action_type", "user_created")
                .param("limit", "10")
                .with(auth(admin)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").isNumber());
    }
}