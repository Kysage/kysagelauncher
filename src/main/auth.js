'use strict';

const crypto = require('crypto');

/**
 * UUID оффлайн-профиля — тот же алгоритм, что использует официальный лаунчер.
 * MD5("OfflinePlayer:<ник>") с выставленными битами версии 3.
 */
function offlineUuid(nickname) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${String(nickname || 'Steve')}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizeNickname(value) {
  const nick = String(value || '').replace(/[^\wа-яА-ЯёЁ]/g, '').slice(0, 16);
  return nick || 'Steve';
}

module.exports = {
  offlineUuid,
  sanitizeNickname
};
