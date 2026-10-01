import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrganizationsTeams, InMemoryStore } from './organizations_teams_typescript.ts';
import { createHash } from 'node:crypto';

function createService() {
  const store = new InMemoryStore();
  return new OrganizationsTeams(store);
}

test('non-member cannot read members of another org (IDOR attempt)', () => {
  const svc = createService();

  const org1 = svc.createOrg('user1', 'Org One');
  const org1Id = org1.body.id;

  const org2 = svc.createOrg('user2', 'Org Two');
  const org2Id = org2.body.id;

  assert.throws(
    () => svc.listMembers('user1', org2Id),
    /not found/
  );
});

test('member cannot invite; admin can', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  // Owner invites admin
  const inviteResult = svc.invite('owner', orgId, 'admin@example.com', 'admin');
  const adminToken = inviteResult.body.token;
  svc.acceptInvitation('admin@example.com', adminToken);

  // Admin can invite
  const adminInvite = svc.invite('admin@example.com', orgId, 'member@example.com', 'member');
  assert.equal(adminInvite.status, 201);
  const memberToken = adminInvite.body.token;
  svc.acceptInvitation('member@example.com', memberToken);

  // Member cannot invite
  assert.throws(
    () => svc.invite('member@example.com', orgId, 'another@example.com', 'member'),
    /forbidden/
  );
});

test('admin cannot remove owner; last owner cannot leave', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  // Invite admin
  const inviteResult = svc.invite('owner', orgId, 'admin@example.com', 'admin');
  svc.acceptInvitation('admin@example.com', inviteResult.body.token);

  // Admin tries to remove owner - should fail
  assert.throws(
    () => svc.removeMember('admin@example.com', orgId, 'owner'),
    /forbidden/
  );

  // Owner tries to leave - should fail (last owner)
  assert.throws(
    () => svc.leaveOrg('owner', orgId),
    /last owner protected/
  );
});

test('invitation works once; second use fails', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  const inviteResult = svc.invite('owner', orgId, 'user@example.com', 'member');
  const rawToken = inviteResult.body.token;

  // First acceptance works
  const firstAccept = svc.acceptInvitation('user@example.com', rawToken);
  assert.equal(firstAccept.status, 200);

  // Second acceptance fails
  assert.throws(
    () => svc.acceptInvitation('user@example.com', rawToken),
    /already used/
  );
});

test('expired invitation fails', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  // Mock Date to control time
  const OriginalDate = global.Date;
  const fixedNow = new Date('2023-01-01');
  global.Date = class extends OriginalDate {
    constructor(value?: any) {
      if (value === undefined) {
        super(fixedNow.getTime());
      } else {
        super(value);
      }
    }
    static now() {
      return fixedNow.getTime();
    }
  };

  try {
    // Create invitation that expires in 7 days from fixedNow (2023-01-08)
    const inviteResult = svc.invite('owner', orgId, 'user@example.com', 'member');
    const rawToken = inviteResult.body.token;

    // Move time to after expiration (2023-01-09)
    const fixedNowAfter = new Date('2023-01-09');
    global.Date = class extends OriginalDate {
      constructor(value?: any) {
        if (value === undefined) {
          super(fixedNowAfter.getTime());
        } else {
          super(value);
        }
      }
      static now() {
        return fixedNowAfter.getTime();
      }
    };

    // Attempt to accept - should be expired
    assert.throws(
      () => svc.acceptInvitation('user@example.com', rawToken),
      /expired/
    );
  } finally {
    global.Date = OriginalDate;
  }
});

test('accepting with different email fails', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  const inviteResult = svc.invite('owner', orgId, 'user@example.com', 'member');
  const rawToken = inviteResult.body.token;

  // Attempt to accept with different email
  assert.throws(
    () => svc.acceptInvitation('different@example.com', rawToken),
    /email mismatch/
  );
});

test('raw token is not stored anywhere in the database', () => {
  const store = new InMemoryStore();
  const svc = new OrganizationsTeams(store);

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  const inviteResult = svc.invite('owner', orgId, 'user@example.com', 'member');
  const rawToken = inviteResult.body.token;

  // Check that raw token is not in invitations map
  for (const inv of (store as any).invitations.values()) {
    assert.notEqual(inv.token_hash, rawToken);
    // Verify it's actually the hash
    const expectedHash = createHash('sha256').update(rawToken).digest('hex');
    assert.equal(inv.token_hash, expectedHash);
  }
});

test('change_role on non-member fails with not found', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  assert.throws(
    () => svc.changeRole('owner', orgId, 'nonexistent', 'admin'),
    /not found/
  );
});

test('remove_member on non-member fails with not found', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  assert.throws(
    () => svc.removeMember('owner', orgId, 'nonexistent'),
    /not found/
  );
});

test('admin cannot demote owner', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  const inviteResult = svc.invite('owner', orgId, 'admin@example.com', 'admin');
  svc.acceptInvitation('admin@example.com', inviteResult.body.token);

  assert.throws(
    () => svc.changeRole('admin@example.com', orgId, 'owner', 'admin'),
    /forbidden/
  );
});

test('admin cannot promote to owner', () => {
  const svc = createService();

  const org = svc.createOrg('owner', 'Test Org');
  const orgId = org.body.id;

  const inviteResult = svc.invite('owner', orgId, 'admin@example.com', 'admin');
  svc.acceptInvitation('admin@example.com', inviteResult.body.token);

  const inviteResult2 = svc.invite('owner', orgId, 'member@example.com', 'member');
  svc.acceptInvitation('member@example.com', inviteResult2.body.token);

  assert.throws(
    () => svc.changeRole('admin@example.com', orgId, 'member@example.com', 'owner'),
    /forbidden/
  );
});