'use strict';
const { app } = require('electron');
const { Store, dataRoot } = require('../src/main/store');
const { launchGame } = require('../src/main/minecraft');

app.whenReady().then(async () => {
  const store = new Store();
  const instance = store.getInstances().find((item) => item.id === '2a2d4708-f86a-40c6-b09c-db992dd42784');
  if (!instance) throw new Error('Тестовая сборка не найдена.');
  const settings = { ...store.get(), ...instance };
  console.log(`INSTANCE ${instance.name} ${instance.versionId} ${instance.loader} ${instance.loaderVersion}`);
  try {
    const { child, java } = await launchGame({
      root: dataRoot(),
      gameDir: instance.gameDir,
      settings,
      versionId: instance.versionId,
      onStatus: (status) => console.log(`STATUS ${status.phase} ${status.percent}% ${status.message || ''} ${status.detail || ''}`),
      onLog: ({ stream, line }) => console.log(`LOG ${stream}: ${line}`)
    });
    console.log(`SPAWNED ${child.pid} JAVA ${java.version}`);
    const timer = setTimeout(() => { console.log('TIMEOUT_STOP'); child.kill(); }, 90000);
    child.on('exit', (code, signal) => { clearTimeout(timer); console.log(`EXIT ${code} ${signal || ''}`); app.quit(); });
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    if (error.hint) console.error(`HINT ${error.hint}`);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
