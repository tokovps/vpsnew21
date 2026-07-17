function rupiah(n) {
  const num = Number(n || 0);
  return 'Rp ' + num.toLocaleString('id-ID');
}

function escapeMd(str = '') {
  return String(str).replace(/([_*`\[\]()~>#+\-=|{}.!\\])/g, '\\$1');
}

function statusLabel(status) {
  const map = {
    waiting_payment: '🕐 Menunggu Pembayaran',
    waiting_review: '🔎 Menunggu Review Admin',
    processing: '⚙️ Sedang Diproses',
    success: '✅ Selesai',
    cancelled: '❌ Dibatalkan',
    rejected: '🚫 Ditolak',
  };
  return map[status] || status;
}

function shortInvoice(inv) {
  return inv ? inv.slice(0, 16).toUpperCase() : '-';
}

module.exports = { rupiah, escapeMd, statusLabel, shortInvoice };
