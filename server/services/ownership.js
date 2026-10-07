const { identityOwnershipReady } = require('../migrations/003_identity_ownership');

function accountsForUser(db, userId) {
  if (!identityOwnershipReady(db)) return null;
  return db.prepare(`SELECT a.id, a.display_name AS name, a.requested_type AS requestedType,
    a.ownership_kind AS ownershipKind, a.status, m.member_role AS memberRole,
    l.account_number AS accountNumber, l.currency, l.balance_minor AS balanceMinor
    FROM account_memberships m JOIN customer_accounts a ON a.id = m.account_id
    JOIN ledger_accounts l ON l.id = a.ledger_account_id
    WHERE m.user_id = ? AND m.status = 'active' AND a.status != 'closed'
    ORDER BY a.id`).all(userId);
}

function accountForUser(db, userId, accountId) {
  if (!identityOwnershipReady(db)) return null;
  return db.prepare(`SELECT a.id, a.display_name AS name, a.requested_type AS requestedType,
    a.ownership_kind AS ownershipKind, a.status, m.member_role AS memberRole,
    l.account_number AS accountNumber, l.currency, l.balance_minor AS balanceMinor
    FROM account_memberships m JOIN customer_accounts a ON a.id = m.account_id
    JOIN ledger_accounts l ON l.id = a.ledger_account_id
    WHERE m.user_id = ? AND m.status = 'active' AND a.status != 'closed' AND a.id = ?`)
    .get(userId, accountId);
}

function publicAccount(account) {
  return {
    id: account.id, name: account.name, label: account.name,
    type: account.requestedType, requestedType: account.requestedType,
    ownershipKind: account.ownershipKind, memberRole: account.memberRole,
    mask: account.accountNumber.slice(-4), balance: account.balanceMinor / 100,
    currency: account.currency, status: account.status, trend: account.status,
    isJoint: account.ownershipKind === 'joint'
  };
}

module.exports = { accountsForUser, accountForUser, publicAccount };
