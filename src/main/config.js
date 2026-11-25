'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/*
 * Встроенный ключ CurseForge, чтобы каталог работал сразу после установки
 * и его не приходилось вводить при каждом запуске.
 * Переменная окружения CURSEFORGE_API_KEY всё ещё имеет приоритет.
 */
const BUNDLED_CURSEFORGE_API_KEY = '$2a$10$10b7SyFqJ4jMxK1p6ehMN.pJx0XNnpew6.cA3YaH5BBvNdTH6yorC';

let envLoaded = false;

function envFiles() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, '.env'));
  try {
    candidates.push(path.join(app.getAppPath(), '.env'));
  } catch {
    /* app ещё не готов — используем путь относительно исходников */
  }
  candidates.push(path.resolve(__dirname, '..', '..', '.env'));
  return [...new Set(candidates)];
}

function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  if (typeof process.loadEnvFile !== 'function') return;
  for (const file of envFiles()) {
    if (!fs.existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
    } catch (error) {
      console.error(`Не удалось загрузить ${file}: ${error.message}`);
    }
  }
}

function curseforgeApiKey() {
  loadEnv();
  return String(process.env.CURSEFORGE_API_KEY || BUNDLED_CURSEFORGE_API_KEY).trim();
}

module.exports = { curseforgeApiKey, BUNDLED_CURSEFORGE_API_KEY };
