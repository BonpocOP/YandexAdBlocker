// Страницы-детекторы: заметен ли блокировщик типовым приёмам сайтов.
//
// Подставляем страницу игры (yandex.ru/games/app/3) и её фрейм на
// *.cdn.games.yandex.net — там работают наши скрипты — и запускаем набор
// детекторов dev/detectors.js в обоих документах.
//
//   node test-detectors.mjs                   только наше расширение
//   node test-detectors.mjs --neighbor ubol   плюс сосед из dev/.neighbors/<имя>
//   node test-detectors.mjs --only-neighbor ubol   только сосед, без нас (для сравнения)

import { chromium } from 'playwright';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const neighbor = opt('--neighbor') || opt('--only-neighbor');
const withUs = !argv.includes('--only-neighbor');

const DETECTORS = fs.readFileSync(path.join(DEV, 'detectors.js'), 'utf8');
const TOP_URL = 'https://yandex.ru/games/app/3';
const FRAME_URL = 'https://app-3.cdn.games.yandex.net/3/index.html';
const TOP_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="game-frame" src="${FRAME_URL}" style="width:800px;height:600px"></iframe>
<script src="/detectors.js"></script></body></html>`;
const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="/sdk/_/v2.js"></script><script src="/detectors.js"></script></body></html>`;
const SDK_JS = 'class Adv { showRewardedVideo() { return Promise.resolve(); } } window.YaGames = { init() { return Promise.resolve({ adv: new Adv() }); } };';

const extensions = [];
if (withUs) extensions.push(ROOT);
if (neighbor) extensions.push(path.join(DEV, '.neighbors', neighbor));

const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'ygab-detect-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe'),
    headless: true,
    args: ['--lang=ru', ...(extensions.length ? ['--disable-extensions-except=' + extensions.join(','), '--load-extension=' + extensions.join(',')] : [])]
});

let out = {};
try {
    await context.route(/^https?:/, route => {
        const url = route.request().url();
        if (url.startsWith(TOP_URL)) return route.fulfill({ contentType: 'text/html', body: TOP_HTML });
        if (url.startsWith(FRAME_URL)) return route.fulfill({ contentType: 'text/html', body: FRAME_HTML });
        if (url.endsWith('/detectors.js')) return route.fulfill({ contentType: 'text/javascript', body: DETECTORS });
        if (url.includes('/sdk/_/v2.js')) return route.fulfill({ contentType: 'text/javascript', body: SDK_JS });
        // Рекламный скрипт «отвечает» — если его не режет блокировщик, он загрузится.
        if (url.startsWith('https://an.yandex.ru/')) return route.fulfill({ contentType: 'text/javascript', body: '/* ad */' });
        return route.abort();
    });
    // Соседу нужно время, чтобы зарегистрировать правила.
    await new Promise(resolve => setTimeout(resolve, neighbor ? 4000 : 1000));
    // --ubol-mode complete: переключить uBO Lite в режим «Полный» (по
    // умолчанию «Оптимальный», и общая косметика в нём не работает). Делаем
    // это его же сообщением со страницы его настроек.
    const ubolMode = opt('--ubol-mode');
    if (ubolMode && neighbor === 'ubol') {
        const levels = { basic: 1, optimal: 2, complete: 3 };
        const workers = context.serviceWorkers();
        const ours = withUs ? new URL(workers.find(w => w.url().endsWith('/src/background.js')).url()).host : null;
        const ubolWorker = workers.find(w => new URL(w.url()).host !== ours);
        const ubolId = new URL(ubolWorker.url()).host;
        const settingsPage = await context.newPage();
        await settingsPage.goto(`chrome-extension://${ubolId}/dashboard.html`);
        const level = await settingsPage.evaluate(level => chrome.runtime.sendMessage({ what: 'setDefaultFilteringMode', level }), levels[ubolMode]);
        console.log(`uBO Lite: режим по умолчанию → ${level}`);
        await settingsPage.close();
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const page = context.pages()[0] || await context.newPage();
    await page.goto(TOP_URL, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    out.top = await page.evaluate(() => window.__detectorsReady);
    const frame = page.frames().find(f => f.url().startsWith('https://app-3.cdn.games.yandex.net'));
    out.frame = frame ? await frame.evaluate(() => window.__detectorsReady) : { error: 'нет фрейма' };
} finally {
    await context.close();
    await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
}

const label = `${withUs ? 'мы' : ''}${withUs && neighbor ? ' + ' : ''}${neighbor || ''}` || 'никого';
const fired = doc => {
    const r = out[doc] || {};
    return {
        control: r.controlHidden, bait: r.bait, yandexBait: r.yandexBait, adScriptBlocked: r.adScriptBlocked,
        patchedNatives: (r.patchedNatives || []).join(',') || '—',
        foreignStyleRules: r.foreignStyleRules, globals: (r.suspiciousGlobals || []).join(',') || '—',
        attributes: (r.suspiciousAttributes || []).join(',') || '—'
    };
};
console.log(`Состав: ${label}`);
console.log('страница:', JSON.stringify(fired('top')));
console.log('фрейм   :', JSON.stringify(fired('frame')));

// Для одного нашего расширения — строгая проверка: ни один детектор не сработал.
if (withUs && !neighbor) {
    const bad = [];
    for (const doc of ['top', 'frame']) {
        const r = out[doc] || {};
        if (r.error) bad.push(`${doc}: ${r.error}`);
        if (r.bait) bad.push(`${doc}: приманка спрятана`);
        if (r.yandexBait) bad.push(`${doc}: приманка Яндекса спрятана`);
        if (r.adScriptBlocked) bad.push(`${doc}: рекламный скрипт не загрузился`);
        if ((r.patchedNatives || []).length) bad.push(`${doc}: подменены ${r.patchedNatives.join(',')}`);
        if (r.foreignStyleRules) bad.push(`${doc}: чужие правила в styleSheets`);
        if ((r.suspiciousGlobals || []).length) bad.push(`${doc}: глобалы ${r.suspiciousGlobals.join(',')}`);
        if ((r.suspiciousAttributes || []).length) bad.push(`${doc}: атрибуты ${r.suspiciousAttributes.join(',')}`);
    }
    console.log(bad.length ? 'СБОЙ ' + bad.join('; ') : 'ОК   ни один детектор не сработал');
    process.exit(bad.length ? 1 : 0);
}
