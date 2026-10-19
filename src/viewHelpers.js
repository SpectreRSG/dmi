// Functions the page templates (views/*.ejs) can use, e.g. <%= fmtDate(x) %>.
const { escapeXML } = require('ejs');
const time = require('./time');
const { expiryStatus } = require('./services/compliance');

// Simple line icons (24x24). Used like <%- icon('calendar') %>.
const ICONS = {
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  building:
    '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  cap: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  passkey: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// The sidebar menu. Each item lists which kinds of account see it.
const OFFICE = ['admin', 'manager'];
const NAV = [
  { href: '/', label: 'Dashboard', icon: 'dashboard', roles: OFFICE },
  { href: '/schedule', label: 'Schedule', icon: 'calendar', roles: OFFICE },
  { href: '/timesheets', label: 'Timesheets', icon: 'clock', roles: OFFICE },
  { href: '/pay', label: 'Pay', icon: 'money', roles: ['admin'] },
  { href: '/staff', label: 'Staff', icon: 'users', roles: OFFICE },
  { href: '/clients', label: 'Clients & sites', icon: 'building', roles: OFFICE },
  { href: '/contracts', label: 'Contracts', icon: 'file', roles: OFFICE },
  { href: '/training', label: 'Training', icon: 'cap', roles: OFFICE },
  { href: '/my/schedule', label: 'My schedule', icon: 'calendar', roles: ['officer'] },
  { href: '/my/schedule', label: 'Schedule', icon: 'calendar', roles: ['client'] },
  { href: '/my/availability', label: 'My availability', icon: 'clock', roles: ['officer'] },
  { href: '/my/requests', label: 'Shift requests', icon: 'plus', roles: ['client'] },
  { href: '/my/pay', label: 'My pay', icon: 'money', roles: ['officer'], also: ['/my/tax'] },
  { href: '/my/details', label: 'My details', icon: 'user', roles: ['officer'] },
  { href: '/waiting', label: 'Getting started', icon: 'clock', roles: ['pending'] },
];
const ADMIN_NAV = [
  { href: '/users', label: 'User accounts', icon: 'key' },
  { href: '/tax', label: '1099 forms', icon: 'file' },
  { href: '/settings', label: 'Settings', icon: 'sliders' },
  { href: '/activity', label: 'Activity log', icon: 'list' },
];

// What each role is called on screen.
const ROLE_NAMES = { admin: 'Admin', manager: 'Manager', officer: 'Officer', client: 'Client', pending: 'Waiting for approval' };

function isActive(currentPath, href) {
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

function formatMoney(amount, symbol) {
  const n = Number(amount) || 0;
  const digits = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbol}${digits}`;
}

function fmtHours(n) {
  return (Number(n) || 0).toFixed(2);
}

// Coloured status labels.
const STATUS_COLORS = {
  active: 'green',
  approved: 'green',
  completed: 'green',
  finalized: 'green',
  scheduled: 'blue',
  pending: 'amber',
  draft: 'gray',
  inactive: 'gray',
  ended: 'gray',
  cancelled: 'gray',
  rejected: 'red',
  terminated: 'red',
};

function badge(text, color = 'gray') {
  return `<span class="badge badge-${color}">${escapeXML(text)}</span>`;
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function statusBadge(status) {
  return badge(capitalize(status), STATUS_COLORS[status] || 'gray');
}

// Badge for a compliance item or anything with an expiry date.
function complianceBadge(status, expiresOn) {
  const date = expiresOn ? time.fmtDate(expiresOn) : '';
  switch (status) {
    case 'valid':
      return badge(`Valid to ${date}`, 'green');
    case 'no-expiry':
      return badge('Valid', 'green');
    case 'expiring':
      return badge(`Expires ${date}`, 'amber');
    case 'expired':
      return badge(`Expired ${date}`, 'red');
    default:
      return badge('Missing', 'red');
  }
}

function expiryBadge(expiresOn, warningDays) {
  if (!expiresOn) return '';
  return complianceBadge(expiryStatus(expiresOn, warningDays), expiresOn);
}

// Contracts: "Active" becomes "Ending soon" or "Expired" based on the end date.
function contractBadge(contract, warningDays) {
  if (contract.status === 'active' && contract.end_date) {
    const state = expiryStatus(contract.end_date, warningDays);
    if (state === 'expired') return badge('Expired', 'red');
    if (state === 'expiring') return badge('Ending soon', 'amber');
  }
  return statusBadge(contract.status);
}

module.exports = {
  ...time,
  icon,
  NAV,
  ADMIN_NAV,
  ROLE_NAMES,
  isActive,
  formatMoney,
  fmtHours,
  badge,
  capitalize,
  statusBadge,
  complianceBadge,
  expiryBadge,
  contractBadge,
};
