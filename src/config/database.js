const mongoose = require('mongoose');
const { config } = require('./index');

async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log('✅ MongoDB connected');
}

module.exports = { connectDB };
