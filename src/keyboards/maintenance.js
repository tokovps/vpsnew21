// Keyboards for Maintenance Mode admin panel.
const { Markup } = require('telegraf');

// Main panel keyboard. `enabled` toggles Aktifkan/Nonaktifkan visibility.
const maintenancePanel = (enabled) => Markup.inlineKeyboard([
  enabled
    ? [Markup.button.callback('🔴 Nonaktifkan Maintenance', 'a:maint:disable')]
    : [Markup.button.callback('🟢 Aktifkan Maintenance', 'a:maint:enable')],
  [Markup.button.callback('👤 Tester Mode', 'a:maint:testers')],
  [Markup.button.callback('⏱ Edit Estimasi', 'a:maint:eta:menu'),
   Markup.button.callback('📝 Edit Pesan', 'a:maint:msg')],
  [Markup.button.callback('⬅️ Kembali', 'a:home')],
]);

// Estimasi menu — preset + custom.
const estimateMenu = (current) => {
  const opts = [30, 60, 120, 180, 360, 720, 1440]; // menit
  const label = (n) => {
    if (n < 60) return `${n} Menit`;
    if (n === 60) return '1 Jam';
    if (n % 60 === 0) return `${n / 60} Jam`;
    return `${Math.floor(n / 60)}j ${n % 60}m`;
  };
  const rows = [];
  for (let i = 0; i < opts.length; i += 2) {
    const row = [];
    row.push(Markup.button.callback(
      `${current === opts[i] ? '✅ ' : ''}${label(opts[i])}`,
      `a:maint:eta:set:${opts[i]}`,
    ));
    if (opts[i + 1] != null) {
      row.push(Markup.button.callback(
        `${current === opts[i + 1] ? '✅ ' : ''}${label(opts[i + 1])}`,
        `a:maint:eta:set:${opts[i + 1]}`,
      ));
    }
    rows.push(row);
  }
  rows.push([Markup.button.callback('✏️ Masukkan Sendiri', 'a:maint:eta:custom')]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'a:maint:menu')]);
  return Markup.inlineKeyboard(rows);
};

// Tester list menu.
const testersMenu = (testers) => {
  const rows = [];
  if (!testers.length) {
    rows.push([Markup.button.callback('_(belum ada tester)_', 'noop')]);
  } else {
    for (const t of testers.slice(0, 20)) {
      const label = `❌ ${t.name || t.username || t.telegramId}`.slice(0, 60);
      rows.push([Markup.button.callback(label, `a:maint:tester:rm:${t.telegramId}`)]);
    }
    if (testers.length > 20) {
      rows.push([Markup.button.callback(`… ${testers.length - 20} lainnya`, 'noop')]);
    }
  }
  rows.push([Markup.button.callback('➕ Tambah Tester', 'a:maint:tester:add')]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'a:maint:menu')]);
  return Markup.inlineKeyboard(rows);
};

// Admin notification for a tester request — approve / reject.
const testerRequestKb = (telegramId) => Markup.inlineKeyboard([
  [Markup.button.callback('✅ Jadikan Tester', `a:maint:req:ok:${telegramId}`),
   Markup.button.callback('❌ Tolak', `a:maint:req:no:${telegramId}`)],
]);

const cancelToPanel = () => Markup.inlineKeyboard([
  [Markup.button.callback('❌ Batal', 'a:maint:menu')],
]);

module.exports = {
  maintenancePanel, estimateMenu, testersMenu, testerRequestKb, cancelToPanel,
};
