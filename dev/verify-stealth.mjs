// Проверка на живой странице игры: расширение работает и не оставляет
// следов, по которым страница его узнает.
//
// Один заход на одну страницу — не больше: домашний IP не тратим на серии
// (см. docs/research/vpn-session.md).
//
//   node verify-stealth.mjs [адрес игры] [--headed]

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const argv = process.argv.slice(2);
const url = argv.find(a => a.startsWith('http')) || 'https://yandex.ru/games/app/602493';
const headed = argv.includes('--headed');

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-verify-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe'),
    headless: !headed,
    viewport: { width: 1600, height: 900 },
    locale: 'ru-RU',
    args: ['--lang=ru', '--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT]
});

const result = { url };
try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Игра из-за рубежа грузится долго: ждём её фрейм до минуты.
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f => /cdn\.games\.yandex\.net|games\.s3\.yandex\.net/.test(f.src)), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(20000);
    result.pageUrl = page.url();
    result.frames = page.frames().map(f => f.url().slice(0, 90));

    // 1. Следы в верхнем документе (MAIN world — то, что видит страница).
    result.top = await page.evaluate(() => {
        const marks = [];
        for (const el of document.querySelectorAll('*')) {
            for (const attr of el.attributes) {
                if (/ygab/i.test(attr.name) || /ygab/i.test(attr.value)) marks.push(`${el.tagName}[${attr.name}=${attr.value.slice(0, 30)}]`);
            }
        }
        return {
            marks: marks.slice(0, 10),
            globals: Object.keys(window).filter(k => /ygab/i.test(k)),
            yaGamesDescriptor: (d => d ? (d.get ? 'accessor' : 'data') : 'none')(Object.getOwnPropertyDescriptor(window, 'YaGames')),
            styleSheetsWithYgab: [...document.styleSheets].filter(s => { try { return [...s.cssRules].some(r => /ygab/.test(r.cssText)); } catch { return false; } }).length
        };
    });

    // 2. То же во фрейме игры.
    const gameFrame = page.frames().find(f => /cdn\.games\.yandex\.net|games\.s3\.yandex\.net/.test(f.url()));
    result.frame = gameFrame ? await gameFrame.evaluate(() => {
        const d = Object.getOwnPropertyDescriptor(window, 'YaGames');
        return {
            globals: Object.keys(window).filter(k => /ygab/i.test(k)),
            yaGamesDescriptor: d ? (d.get ? 'accessor' : 'data') : 'none',
            yaGamesMarked: !!(window.YaGames && Object.keys(window.YaGames).some(k => /ygab/i.test(k))),
            initToString: window.YaGames && typeof window.YaGames.init === 'function' ? String(window.YaGames.init).slice(0, 60) : null
        };
    }).catch(e => ({ error: String(e).slice(0, 200) })) : { error: 'фрейм игры не найден' };

    // 3. Отчёт — через фоновый скрипт, как попап.
    result.report = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({});
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getReport' }, { frameId: 0 });
        const r = response.report;
        return {
            version: r.version,
            sdkEvents: r.sdkEvents.map(e => `${e.t} ${e.kind} ${typeof e.detail === 'string' ? e.detail : ''}`.trim()),
            frameMessageTypes: r.frameMessages ? Object.keys(r.frameMessages).length : 0,
            journal: r.journal.filter(j => /dismiss|sdk-call/.test(j.kind)).map(j => `${j.t} ${j.kind}`),
            blockedOnPage: r.blockedOnPage
        };
    }).catch(e => ({ error: String(e).slice(0, 300) }));
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(JSON.stringify(result, null, 1));
