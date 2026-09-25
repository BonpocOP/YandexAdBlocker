// Эмуляция косметических правил блокировщика на сохранённой странице.
//
// Отвечает на вопрос R2 без захода на сайт: останется ли дыра, если
// блокировщик спрячет то, что велят его правила. Правила применяются так же,
// как у uBO Lite: display: none !important на совпавших узлах.
//
//   node emulate-rules.mjs <page.mhtml> <файл-селекторов> [селектор-для-замера ...]

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const [file, selectorsFile, ...probes] = process.argv.slice(2);
const selectors = fs.readFileSync(selectorsFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const log = message => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

const browser = await chromium.launch({ executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe'), headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(30000);
    await page.route('**/*', route => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    log('открываю снимок');
    await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    const measure = () => page.evaluate(probes => probes.map(selector => ({
        selector,
        boxes: [...document.querySelectorAll(selector)].slice(0, 5).map(el => {
            const r = el.getBoundingClientRect();
            return [Math.round(r.width), Math.round(r.height), getComputedStyle(el).display];
        })
    })).concat([{ selector: 'page', boxes: [[0, document.documentElement.scrollHeight, '']] }]), probes);

    log('замер до правил');
    const before = await measure();

    log(`применяю ${selectors.length} правил`);
    const rejected = await page.evaluate(selectors => {
        const bad = [];
        const style = document.createElement('style');
        document.head.append(style);
        for (const selector of selectors) {
            try {
                style.sheet.insertRule(`${selector} { display: none !important; }`, style.sheet.cssRules.length);
            } catch {
                bad.push(selector);
            }
        }
        return bad;
    }, selectors);
    await page.waitForTimeout(500);

    log('замер после правил');
    const after = await measure();
    console.log(JSON.stringify({ rules: selectors.length, rejected, before, after }, null, 1));
} finally {
    await browser.close();
}
