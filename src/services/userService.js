const User = require('../models/User');

async function upsertUser(from) {
  const telegramId = String(from.id);
  const existing = await User.findOne({ telegramId });
  const data = {
    telegramId,
    username: from.username || '',
    name: [from.first_name, from.last_name].filter(Boolean).join(' '),
  };
  if (!existing) data.firstSeenAt = new Date();
  return User.findOneAndUpdate({ telegramId }, { $set: data }, { upsert: true, new: true });
}

const countUsers = () => User.countDocuments();
const allUsers = () => User.find({}, { telegramId: 1 });

module.exports = { upsertUser, countUsers, allUsers };
