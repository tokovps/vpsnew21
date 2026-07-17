// Cryptographically-strong Administrator password generator for auto-created RDP.
// Rules chosen to satisfy Windows Default Password Policy AND to remain
// copy-friendly on Telegram (avoids visually ambiguous chars & shell-hostile
// characters like backticks / quotes / spaces).
const crypto = require('crypto');

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';       // no I,O
const LOWER = 'abcdefghijkmnpqrstuvwxyz';       // no l,o
const DIGIT = '23456789';                        // no 0,1
const SYMBOL = '!@#%^&*-_=+?';                   // shell/URL safe

function pickOne(pool) {
  const idx = crypto.randomInt(0, pool.length);
  return pool[idx];
}

function shuffle(str) {
  const arr = str.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

/**
 * Generate a strong Administrator password.
 * @param {number} length - total length (default 18)
 * @returns {string}
 */
function generateAdminPassword(length = 18) {
  if (length < 12) length = 12;
  const required = [
    pickOne(UPPER), pickOne(UPPER),
    pickOne(LOWER), pickOne(LOWER),
    pickOne(DIGIT), pickOne(DIGIT),
    pickOne(SYMBOL),
  ];
  const pool = UPPER + LOWER + DIGIT + SYMBOL;
  const remaining = length - required.length;
  let rest = '';
  for (let i = 0; i < remaining; i++) rest += pickOne(pool);
  return shuffle(required.join('') + rest);
}

module.exports = { generateAdminPassword };
