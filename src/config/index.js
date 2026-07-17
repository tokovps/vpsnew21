require('dotenv').config();

const config = {
  botToken: process.env.BOT_TOKEN,
  adminId: process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : '',
  adminUsername: (process.env.ADMIN_USERNAME || '').replace(/^@/, ''),
  mongoUri: process.env.MONGODB_URI,
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  webhookUrl: process.env.WEBHOOK_URL || '',
};

function validateConfig() {
  const missing = [];
  if (!config.botToken || config.botToken === 'YOUR_BOT_TOKEN') missing.push('BOT_TOKEN');
  if (!config.adminId || config.adminId === 'YOUR_TELEGRAM_ID') missing.push('ADMIN_ID');
  if (!config.adminUsername || config.adminUsername === 'YOUR_USERNAME') missing.push('ADMIN_USERNAME');
  if (!config.mongoUri || config.mongoUri === 'YOUR_MONGODB_URI') missing.push('MONGODB_URI');
  return missing;
}

module.exports = { config, validateConfig };
