'use strict';

/**
 * Диагностика движка: скачивает версию и пробует запустить Minecraft.
 * Запуск: npx electron scripts/doctor.js [секунды-до-остановки] [--version=1.21.4]
 */

const { app } = require('electron');
const path = require('path');
const { launchGame, listVersions } = require('../src/main/minecraft');
const { findJava } = require('../src/main/java');
const { dataRoot } = require('../src/main/store');

const versionArg = process.argv.find((item) => item.startsWith('--version='));
const requestedVersion = versionArg ? versionArg.split('=')[1] : '';
const numericArg = process.argv.slice(2).find((item) => /^\d+$/.test(item));
const killAfter = (Number(numericArg) || 25) * 1000;

app.whenReady().then(async () => {
  try {
    const root = dataRoot();
    const settings = { nickname: 'Steve', memory: 4096, javaPath: '', gameDir: '' };
    const gameDir = path.join(root, 'game');
    const java = findJava({ requiredMajor: 25 });

    console.log('root:', root);
    console.log('java:', java);

    const list = await listVersions(root);
    const versionId = requestedVersion || list.latest.release;
    console.log('version:', versionId);

    let lastPercent = -1;
    const started = Date.now();

    const { child } = await launchGame({
      root,
      gameDir,
      settings,
      versionId,
      onStatus: (status) => {
        if (status.percent !== lastPercent || status.phase === 'launching') {
          lastPercent = status.percent;
          console.log(`[${status.phase}] ${status.percent}% ${status.message} ${status.detail || ''}`.trim());
        }
      },
      onLog: ({ stream, line }) => {
        console.log(`LOG ${stream}: ${line}`);
      }
    });

    console.log(`SPAWNED pid=${child.pid} за ${((Date.now() - started) / 1000).toFixed(1)} c`);

    const timer = setTimeout(() => {
      console.log('KILL: время теста истекло');
      child.kill();
    }, killAfter);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      console.log(`EXIT code=${code} signal=${signal}`);
      app.quit();
    });
  } catch (error) {
    console.error('FAIL:', error?.message || error);
    if (error?.hint) console.error('HINT:', error.hint);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
