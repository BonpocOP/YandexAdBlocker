// Проверка оповещения о новой версии без обращения к GitHub: вызываем в
// фоновом скрипте ту же функцию, что обрабатывает ответ GitHub, и смотрим
// хранилище, метку на значке и ссылку в попапе.
//
//   node test-update.mjs

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const results = [];
const check = (name, ok, detail) => results.push({ ok: Boolean(ok), name, detail });

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-update-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe'),
    headless: true,
    args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT]
});
try {
    // Настоящих запросов в сеть тесту не нужно.
    await context.route(/^https?:/, route => route.abort());
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;

    const cases = await worker.evaluate(() => ({
        a: isNewer('1.10.0', '1.9.3'),
        b: isNewer('1.6.1', '1.6.1'),
        c: isNewer('1.6.0', '1.6.1'),
        d: isNewer('2.0', '1.99.99')
    }));
    check('сравнение версий по числам', cases.a && !cases.b && !cases.c && cases.d, cases);

    const same = await worker.evaluate(async () => {
        const newer = await applyRelease({ tag_name: 'v' + chrome.runtime.getManifest().version, html_url: 'x' });
        return { newer, badge: await chrome.action.getBadgeText({}), stored: (await chrome.storage.local.get('update')).update };
    });
    check('та же версия: метки нет', !same.newer && same.badge === '' && same.stored === null, same);

    const fresh = await worker.evaluate(async () => {
        const newer = await applyRelease({ tag_name: 'v99.0.0', html_url: 'https://github.com/BonpocOP/YandexAdBlocker/releases/tag/v99.0.0' });
        return { newer, badge: await chrome.action.getBadgeText({}), stored: (await chrome.storage.local.get('update')).update };
    });
    check('новая версия: метка на значке и запись в хранилище', fresh.newer && fresh.badge === '↑' && fresh.stored && fresh.stored.version === '99.0.0', fresh);

    const popup = await context.newPage();
    const errors = [];
    popup.on('pageerror', e => errors.push(String(e.message || e)));
    popup.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await popup.goto(`chrome-extension://${id}/popup/popup.html`);
    await popup.waitForTimeout(500);
    const link = await popup.evaluate(() => { const el = document.getElementById('update'); return { hidden: el.hidden, text: el.textContent, href: el.href }; });
    check('попап показывает ссылку на новую версию', !link.hidden && link.text.includes('99.0.0') && link.href.includes('v99.0.0'), { link, errors });
} catch (error) {
    check('тест не упал', false, String(error.message || error).slice(0, 300));
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
for (const r of results) console.log(`${r.ok ? 'ОК  ' : 'СБОЙ'} ${r.name}${r.ok ? '' : '  → ' + JSON.stringify(r.detail)}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\nИтого: ${results.length - failed} из ${results.length}`);
process.exit(failed ? 1 : 0);
