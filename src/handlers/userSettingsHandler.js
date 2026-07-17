// User-facing Settings menu: currency & language picker.
const { Markup } = require('telegraf');
const { safeEditText, answerCb } = require('../utils/safeEdit');
const User = require('../models/User');
const currencyService = require('../services/currencyService');
const i18n = require('../services/i18nService');

async function showSettings(ctx) {
  const user = await User.findOne({ telegramId: String(ctx.from.id) });
  const cur = user && user.currency || '(belum diset)';
  const lang = user && user.language || 'id';
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(`💱 Mata Uang: ${cur}`, 'u:cur:menu')],
    [Markup.button.callback(`🌐 Bahasa: ${lang}`, 'u:lang:menu')],
    [Markup.button.callback('⬅️ Kembali', 'menu:home')],
  ]);
  await answerCb(ctx);
  return safeEditText(ctx, `⚙️ *PENGATURAN*\n\nPilih preferensi Anda:`, { parse_mode: 'Markdown', ...kb });
}

async function showCurrencyPicker(ctx) {
  const list = await currencyService.enabledList();
  const rows = [];
  for (let i = 0; i < list.length; i += 3) {
    rows.push(list.slice(i, i + 3).map(c => Markup.button.callback(`${c.symbol || ''} ${c.code}`, `u:cur:set:${c.code}`)));
  }
  rows.push([Markup.button.callback('⬅️ Kembali', 'menu:settings')]);
  await answerCb(ctx);
  return safeEditText(ctx, `💱 *PILIH MATA UANG*\n\nHarga akan ditampilkan sesuai mata uang yang dipilih.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function setCurrency(ctx, code) {
  await User.findOneAndUpdate({ telegramId: String(ctx.from.id) }, { $set: { currency: code } }, { upsert: true });
  await answerCb(ctx, `✅ ${code}`);
  return showSettings(ctx);
}

async function showLanguagePicker(ctx) {
  const rows = i18n.LANGS.map(l => [Markup.button.callback(l === 'id' ? '🇮🇩 Indonesia' : '🇬🇧 English', `u:lang:set:${l}`)]);
  rows.push([Markup.button.callback('⬅️ Kembali', 'menu:settings')]);
  await answerCb(ctx);
  return safeEditText(ctx, `🌐 *PILIH BAHASA*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
}

async function setLanguage(ctx, lang) {
  await User.findOneAndUpdate({ telegramId: String(ctx.from.id) }, { $set: { language: lang } }, { upsert: true });
  await answerCb(ctx, `✅ ${lang}`);
  return showSettings(ctx);
}

module.exports = { showSettings, showCurrencyPicker, setCurrency, showLanguagePicker, setLanguage };
