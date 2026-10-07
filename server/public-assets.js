// The files this application intentionally serves to browsers.
// Keep the Vercel build and local Express server on the same allowlist.
module.exports = [
  'index.html', 'features.html', 'security.html', 'support.html', 'card.html',
  'login.html', 'open-account.html', 'verify-email.html', 'recover-account.html',
  'dashboard.html', 'dashboard-activity.html',
  'dashboard-cards.html', 'dashboard-support.html', 'dashboard-members.html',
  'account-invite.html', 'admin.html', 'staff-setup.html',
  'script.js', 'card.js', 'login.js', 'open-account.js', 'dashboard.js',
  'dashboard-activity.js', 'dashboard-cards.js', 'dashboard-support.js',
  'admin.js', 'auth-client.js', 'translate.js', 'staff-setup.js',
  'verify-email.js', 'recover-account.js', 'account-invite.js', 'dashboard-members.js',
  'style.css', 'admin.css', 'translate.css', 'tailwind/output.css'
];
