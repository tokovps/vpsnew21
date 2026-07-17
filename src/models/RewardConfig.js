const mongoose = require('mongoose');

const tierSchema = new mongoose.Schema({
  threshold: { type: Number, required: true },
  rewardTier: { type: String, enum: ['low', 'basic', 'medium', 'special'], required: true },
  label: { type: String, default: '' },
  warrantyDays: { type: Number, default: 30 },
  maxReplace: { type: Number, default: 3 },
  active: { type: Boolean, default: true },
}, { _id: false });

const badgeSchema = new mongoose.Schema({
  code: { type: String, required: true },
  name: { type: String, required: true },
  icon: { type: String, default: '🏅' },
  kind: { type: String, enum: ['vps', 'referral'], required: true },
  threshold: { type: Number, required: true },
  active: { type: Boolean, default: true },
}, { _id: false });

const frameSchema = new mongoose.Schema({
  code: { type: String, required: true },
  name: { type: String, required: true },
  icon: { type: String, default: '🥉' },
  threshold: { type: Number, required: true }, // min vpsTxCount to unlock
}, { _id: false });

const DEFAULT_LOYALTY = [
  { threshold: 15,  rewardTier: 'low',     label: 'VPS LOW GRATIS',     warrantyDays: 30, maxReplace: 3, active: true },
  { threshold: 30,  rewardTier: 'basic',   label: 'VPS BASIC GRATIS',   warrantyDays: 30, maxReplace: 3, active: true },
  { threshold: 50,  rewardTier: 'medium',  label: 'VPS MEDIUM GRATIS',  warrantyDays: 30, maxReplace: 3, active: true },
  { threshold: 100, rewardTier: 'special', label: 'Reward Spesial',     warrantyDays: 30, maxReplace: 3, active: true },
];
const DEFAULT_REFERRAL = [
  { threshold: 10,  rewardTier: 'low',     label: 'VPS LOW GRATIS',     warrantyDays: 30, maxReplace: 3, active: true },
  { threshold: 25,  rewardTier: 'basic',   label: 'VPS BASIC GRATIS',   warrantyDays: 30, maxReplace: 3, active: true },
  { threshold: 50,  rewardTier: 'medium',  label: 'VPS MEDIUM GRATIS',  warrantyDays: 30, maxReplace: 3, active: true },
  { threshold: 100, rewardTier: 'special', label: 'Reward Spesial',     warrantyDays: 30, maxReplace: 3, active: true },
];
const DEFAULT_BADGES = [
  { code: 'first_vps',   name: 'First VPS',       icon: '🆕', kind: 'vps',      threshold: 1,    active: true },
  { code: 'bronze_b',    name: 'Bronze Buyer',    icon: '🥉', kind: 'vps',      threshold: 15,   active: true },
  { code: 'silver_b',    name: 'Silver Buyer',    icon: '🥈', kind: 'vps',      threshold: 30,   active: true },
  { code: 'gold_b',      name: 'Gold Buyer',      icon: '🥇', kind: 'vps',      threshold: 50,   active: true },
  { code: 'platinum_b',  name: 'Platinum Buyer',  icon: '💎', kind: 'vps',      threshold: 75,   active: true },
  { code: 'diamond_b',   name: 'Diamond Buyer',   icon: '👑', kind: 'vps',      threshold: 100,  active: true },
  { code: 'vps_hunter',  name: 'VPS Hunter',      icon: '🔥', kind: 'vps',      threshold: 200,  active: true },
  { code: 'cloud_master',name: 'Cloud Master',    icon: '🚀', kind: 'vps',      threshold: 500,  active: true },
  { code: 'vps_legend',  name: 'VPS Legend',      icon: '🌌', kind: 'vps',      threshold: 1000, active: true },
  { code: 'first_ref',   name: 'First Referral',  icon: '🤝', kind: 'referral', threshold: 1,    active: true },
  { code: 'bronze_r',    name: 'Bronze Referrer', icon: '🥉', kind: 'referral', threshold: 10,   active: true },
  { code: 'silver_r',    name: 'Silver Referrer', icon: '🥈', kind: 'referral', threshold: 25,   active: true },
  { code: 'gold_r',      name: 'Gold Referrer',   icon: '🥇', kind: 'referral', threshold: 50,   active: true },
  { code: 'platinum_r',  name: 'Platinum Referrer', icon: '💎', kind: 'referral', threshold: 100, active: true },
  { code: 'ref_legend',  name: 'Referral Legend', icon: '👑', kind: 'referral', threshold: 250,  active: true },
];
const DEFAULT_FRAMES = [
  { code: 'bronze',   name: 'Bronze Member',   icon: '🥉', threshold: 15  },
  { code: 'silver',   name: 'Silver Member',   icon: '🥈', threshold: 30  },
  { code: 'gold',     name: 'Gold Member',     icon: '🥇', threshold: 50  },
  { code: 'platinum', name: 'Platinum Member', icon: '💎', threshold: 75  },
  { code: 'diamond',  name: 'Diamond Member',  icon: '👑', threshold: 100 },
];

const schema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true, index: true },
  loyaltyEnabled: { type: Boolean, default: true },
  referralEnabled: { type: Boolean, default: true },
  badgeEnabled: { type: Boolean, default: true },
  loyaltyTiers: { type: [tierSchema], default: DEFAULT_LOYALTY },
  referralTiers: { type: [tierSchema], default: DEFAULT_REFERRAL },
  badges: { type: [badgeSchema], default: DEFAULT_BADGES },
  frames: { type: [frameSchema], default: DEFAULT_FRAMES },
  minAccountAgeDays: { type: Number, default: 7 },
  minVpsActiveHours: { type: Number, default: 24 },
  specialLoyaltyReward: { type: String, default: 'Reward Spesial - hubungi Admin untuk klaim' },
  specialReferralReward: { type: String, default: 'Reward Spesial - hubungi Admin untuk klaim' },
  // Reward VPS uses this slot (1..3) from the tier's spec
  rewardSlot: { type: Number, default: 1 },
}, { timestamps: true, minimize: false });

module.exports = mongoose.model('RewardConfig', schema);
module.exports.DEFAULTS = { DEFAULT_LOYALTY, DEFAULT_REFERRAL, DEFAULT_BADGES, DEFAULT_FRAMES };
