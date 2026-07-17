const { v4: uuidv4 } = require('uuid');

function generateInvoice() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = uuidv4().split('-')[0].toUpperCase();
  return `INV-${ts}-${rand}`;
}

module.exports = { generateInvoice };
