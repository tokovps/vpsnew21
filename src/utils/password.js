// Cryptographically-secure password generator.
// Excludes ambiguous chars by default (O/0, l/I/1, etc.) for user-friendliness.
// Guarantees at least one lowercase, uppercase, digit and symbol.
const crypto = require('crypto');

const AMBIGUOUS = /[O0oIl1|`'"~,;.:]/g;

function pickSecure(set) {
  const idx = crypto.randomInt(0, set.length);
  return set[idx];
}

function shuffleSecure(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function build(charset, excludeAmbig) {
  return excludeAmbig ? charset.replace(AMBIGUOUS, '') : charset;
}

function generatePassword(length = 12, excludeAmbiguous = true) {
  const len = Math.max(8, Math.min(64, parseInt(length, 10) || 12));
  const lower = build('abcdefghijklmnopqrstuvwxyz', excludeAmbiguous);
  const upper = build('ABCDEFGHIJKLMNOPQRSTUVWXYZ', excludeAmbiguous);
  const digits = build('23456789', excludeAmbiguous) || '0123456789';
  const symbols = '!@#$%^&*()-_=+[]{}?';
  const all = lower + upper + digits + symbols;

  const out = [
    pickSecure(lower),
    pickSecure(upper),
    pickSecure(digits),
    pickSecure(symbols),
  ];
  for (let i = out.length; i < len; i++) out.push(pickSecure(all));
  return shuffleSecure(out).join('');
}

module.exports = { generatePassword };
