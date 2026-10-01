const crypto = require('crypto');

class InMemoryStore {
  constructor() {
    this.organizations = new Map();
    this.memberships = new Map();
    this.invitations = new Map();
    this.orgSeq = 1;
    this.invSeq = 1;
  }

  createOrganization(name, slug, createdAt) {
    const id = this.orgSeq++;
    const org = { id, name, slug, created_at: createdAt };
    this.organizations.set(id, org);
    return org;
  }

  getOrganization(id) {
    return this.organizations.get(id) || null;
  }

  getOrganizationBySlug(slug) {
    for (const org of this.organizations.values()) {
      if (org.slug === slug) return org;
    }
    return null;
  }

  createMembership(orgId, userId, role, createdAt) {
    const key = `${orgId}:${userId}`;
    const membership = { org_id: orgId, user_id: userId, role, created_at: createdAt };
    this.memberships.set(key, membership);
    return membership;
  }

  getMembership(orgId, userId) {
    return this.memberships.get(`${orgId}:${userId}`) || null;
  }

  deleteMembership(orgId, userId) {
    return this.memberships.delete(`${orgId}:${userId}`);
  }

  updateMembershipRole(orgId, userId, role) {
    const key = `${orgId}:${userId}`;
    const membership = this.memberships.get(key);
    if (!membership) return null;
    membership.role = role;
    return membership;
  }

  listMemberships(orgId) {
    const result = [];
    for (const membership of this.memberships.values()) {
      if (membership.org_id === orgId) result.push(membership);
    }
    return result;
  }

  countOwners(orgId) {
    let count = 0;
    for (const membership of this.memberships.values()) {
      if (membership.org_id === orgId && membership.role === 'owner') count++;
    }
    return count;
  }

  createInvitation(orgId, email, role, tokenHash, expiresAt, invitedBy, createdAt) {
    const id = this.invSeq++;
    const invitation = {
      id,
      org_id: orgId,
      email,
      role,
      token_hash: tokenHash,
      expires_at: expiresAt,
      accepted_at: null,
      invited_by: invitedBy,
      created_at: createdAt
    };
    this.invitations.set(id, invitation);
    return invitation;
  }

  getInvitationByTokenHash(tokenHash) {
    for (const invitation of this.invitations.values()) {
      if (invitation.token_hash === tokenHash) return invitation;
    }
    return null;
  }

  markInvitationAccepted(invitationId, acceptedAt) {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return null;
    invitation.accepted_at = acceptedAt;
    return invitation;
  }
}

class OrganizationsTeams {
  constructor(store) {
    this.store = store;
  }

  createOrg(user, name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const existing = this.store.getOrganizationBySlug(slug);
    if (existing) {
      return { status: 409, content_type: 'application/json', body: { error: 'Organization with this slug already exists' } };
    }
    const createdAt = new Date().toISOString();
    const org = this.store.createOrganization(name, slug, createdAt);
    this.store.createMembership(org.id, user.id, 'owner', createdAt);
    return { status: 201, content_type: 'application/json', body: org };
  }

  invite(actor, orgId, email, role) {
    const org = this.store.getOrganization(orgId);
    if (!org) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const membership = this.store.getMembership(orgId, actor.id);
    if (!membership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    if (membership.role !== 'admin' && membership.role !== 'owner') {
      return { status: 403, content_type: 'application/json', body: { error: 'Forbidden: only admins and owners can invite' } };
    }
    if (role === 'owner') {
      return { status: 400, content_type: 'application/json', body: { error: 'Cannot invite as owner' } };
    }
    const tokenBytes = crypto.randomBytes(32);
    const rawToken = tokenBytes.toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenBytes).digest('hex');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const invitation = this.store.createInvitation(orgId, email, role, tokenHash, expiresAt, actor.id, createdAt);
    return { status: 201, content_type: 'application/json', body: { token: rawToken, invitation_id: invitation.id } };
  }

  acceptInvitation(user, rawToken) {
    const tokenBytes = Buffer.from(rawToken, 'hex');
    const tokenHash = crypto.createHash('sha256').update(tokenBytes).digest('hex');
    const invitation = this.store.getInvitationByTokenHash(tokenHash);
    if (!invitation) {
      return { status: 404, content_type: 'application/json', body: { error: 'Invitation not found' } };
    }
    if (invitation.accepted_at !== null) {
      return { status: 410, content_type: 'application/json', body: { error: 'Invitation already accepted' } };
    }
    const now = new Date();
    if (new Date(invitation.expires_at) < now) {
      return { status: 410, content_type: 'application/json', body: { error: 'Invitation expired' } };
    }
    if (user.email !== invitation.email) {
      return { status: 403, content_type: 'application/json', body: { error: 'Email does not match invitation' } };
    }
    const createdAt = new Date().toISOString();
    this.store.markInvitationAccepted(invitation.id, createdAt);
    const membership = this.store.createMembership(invitation.org_id, user.id, invitation.role, createdAt);
    return { status: 201, content_type: 'application/json', body: membership };
  }

  changeRole(actor, orgId, userId, role) {
    const org = this.store.getOrganization(orgId);
    if (!org) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const actorMembership = this.store.getMembership(orgId, actor.id);
    if (!actorMembership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    if (actorMembership.role !== 'owner') {
      return { status: 403, content_type: 'application/json', body: { error: 'Forbidden: only owners can change roles' } };
    }
    const targetMembership = this.store.getMembership(orgId, userId);
    if (!targetMembership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Member not found' } };
    }
    if (targetMembership.role === 'owner' && role !== 'owner') {
      const ownerCount = this.store.countOwners(orgId);
      if (ownerCount <= 1) {
        return { status: 400, content_type: 'application/json', body: { error: 'Cannot demote the last owner' } };
      }
    }
    const updated = this.store.updateMembershipRole(orgId, userId, role);
    return { status: 200, content_type: 'application/json', body: updated };
  }

  removeMember(actor, orgId, userId) {
    const org = this.store.getOrganization(orgId);
    if (!org) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const actorMembership = this.store.getMembership(orgId, actor.id);
    if (!actorMembership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    if (actorMembership.role !== 'owner') {
      return { status: 403, content_type: 'application/json', body: { error: 'Forbidden: only owners can remove members' } };
    }
    const targetMembership = this.store.getMembership(orgId, userId);
    if (!targetMembership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Member not found' } };
    }
    if (targetMembership.role === 'owner') {
      const ownerCount = this.store.countOwners(orgId);
      if (ownerCount <= 1) {
        return { status: 400, content_type: 'application/json', body: { error: 'Cannot remove the last owner' } };
      }
    }
    this.store.deleteMembership(orgId, userId);
    return { status: 204, content_type: 'application/json', body: null };
  }

  leaveOrg(user, orgId) {
    const org = this.store.getOrganization(orgId);
    if (!org) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const membership = this.store.getMembership(orgId, user.id);
    if (!membership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    if (membership.role === 'owner') {
      const ownerCount = this.store.countOwners(orgId);
      if (ownerCount <= 1) {
        return { status: 400, content_type: 'application/json', body: { error: 'Cannot leave as the last owner' } };
      }
    }
    this.store.deleteMembership(orgId, user.id);
    return { status: 204, content_type: 'application/json', body: null };
  }

  listMembers(actor, orgId) {
    const org = this.store.getOrganization(orgId);
    if (!org) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const membership = this.store.getMembership(orgId, actor.id);
    if (!membership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const members = this.store.listMemberships(orgId);
    return { status: 200, content_type: 'application/json', body: members };
  }

  getOrg(actor, orgId) {
    const org = this.store.getOrganization(orgId);
    if (!org) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    const membership = this.store.getMembership(orgId, actor.id);
    if (!membership) {
      return { status: 404, content_type: 'application/json', body: { error: 'Organization not found' } };
    }
    return { status: 200, content_type: 'application/json', body: org };
  }
}

module.exports = { OrganizationsTeams, InMemoryStore };