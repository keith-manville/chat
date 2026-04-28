function newId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const AVATAR_COLORS = [
  '#4A154B', '#36C5F0', '#2EB67D', '#ECB22E', '#E01E5A',
  '#1264A3', '#7C3AED', '#DB2777', '#0F766E', '#B45309',
];

function pickAvatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Human-friendly join codes: 8 chars, no easily-confused glyphs (0/O/1/I).
const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateJoinCode(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += JOIN_ALPHABET[Math.floor(Math.random() * JOIN_ALPHABET.length)];
  return s;
}

function normalizeJoinCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

module.exports = { newId, pickAvatarColor, escapeHtml, generateJoinCode, normalizeJoinCode };
