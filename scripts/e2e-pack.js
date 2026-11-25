'use strict';

/* Временная E2E-проверка скачивания готовой сборки. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electron = require('electron');
const root = path.resolve(__dirname, '..');
const port = 9224;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      /* стартуем */
    }
    await sleep(500);
  }
  throw new Error('DevTools не ответил');
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.id && pending.has(payload.id)) {
      pending.get(payload.id)(payload);
      pending.delete(payload.id);
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const send = (method, params) =>
    new Promise((resolve) => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
    return result.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function main() {
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, stdio: 'ignore' });
  try {
    const page = await waitForPage();
    const cdp = await connect(page);
    await sleep(2500);

    await cdp.evaluate(`document.querySelector('[data-view="mods"]').click()`);
    await sleep(500);
    await cdp.evaluate(`(() => {
      const select = document.querySelector('#curseforgeClass');
      select.value = '4471';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const input = document.querySelector('#curseforgeSearch');
      input.value = 'Fabulously Optimized';
      document.querySelector('#searchCurseForge').click();
    })()`);

    let resultName = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(500);
      resultName = await cdp.evaluate(`(() => {
        const card = [...document.querySelectorAll('#curseforgeResults .catalog-result')]
          .find((item) => /Fabulously Optimized/i.test(item.textContent));
        if (!card) return '';
        card.querySelector('[data-cf-files]').click();
        return card.querySelector('.mod-info strong')?.textContent || '';
      })()`);
      if (resultName) break;
    }
    console.log('PACK', JSON.stringify(resultName));
    if (!resultName) throw new Error('Модпак не найден в поиске');

    await sleep(2500);
    const files = await cdp.evaluate(`(() => ({
      rows: document.querySelectorAll('#curseforgeResults .catalog-file-row').length,
      first: document.querySelector('#curseforgeResults .catalog-file-row')?.textContent?.trim().slice(0, 80) || '',
      rowsText: [...document.querySelectorAll('#curseforgeResults .catalog-file-row')].map((row) => row.textContent.trim().replace(/\s+/g, ' ')).slice(0, 15),
      button: [...document.querySelectorAll('#curseforgeResults .catalog-file-row')]
        .find((row) => /1\.20\.1/.test(row.textContent))?.querySelector('[data-cf-install]')?.textContent || ''
    }))()`);
    console.log('PACK_FILES', JSON.stringify(files));

    await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#curseforgeResults .catalog-file-row')]
        .find((item) => /1\.20\.1/.test(item.textContent));
      row?.querySelector('[data-cf-install]')?.click();
    })()`);

    const startedAt = Date.now();
    let state = null;
    let lastLog = 0;
    while (Date.now() - startedAt < 600000) {
      state = await cdp.evaluate(`(() => ({
        percent: document.querySelector('#modDownloadPercent')?.textContent || '',
        label: document.querySelector('#modDownloadLabel')?.textContent || '',
        detail: document.querySelector('#modDownloadDetail')?.textContent || '',
        toast: document.querySelector('#toastHost')?.textContent?.trim().slice(0, 120) || ''
      }))()`);
      if (Date.now() - lastLog > 10000) {
        console.log('PROGRESS', JSON.stringify(state));
        lastLog = Date.now();
      }
      if (/скачана|не удалось|Сборка скачана/i.test(state.toast) || /Установка завершена/.test(state.label)) break;
      if (/Не удалось|ошибка/i.test(state.label)) break;
      await sleep(700);
    }

    const summary = await cdp.evaluate(`window.launcher.instances().then((data) => {
      const selected = data.instances.find((item) => item.id === data.selectedId);
      return { count: data.instances.length, selected, mods: null };
    })`);
    console.log('INSTANCES', JSON.stringify(summary));

    const mods = await cdp.evaluate(`window.launcher.modsList().then((list) => list.length, (error) => error.message)`);
    console.log('NEW_MODS', JSON.stringify(mods));
    console.log('ELAPSED_MS', Date.now() - startedAt);
    console.log('FINAL', JSON.stringify(state));

    await sleep(1200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'shots', 'pack-downloaded.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT shots/pack-downloaded.png');
    cdp.close();
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error('FAILED', error.message);
  process.exitCode = 1;
});
