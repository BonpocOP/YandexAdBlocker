// Иконки Cleathernet из platform/icons/icon.svg и icon-off.svg в PNG.
//
// icon<N>.png — наша иконка; icon<N>-off.png — серая, «выключено на
// сайте». Серую движок uBO Lite сам ставит на значок, когда сайт выключен:
// сборка (build-extension.mjs) кладёт наши картинки на место его img/icon_*.
//
//   node render-icons.mjs

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ICONS = path.join(DEV, '..', 'platform', 'icons');
const SIZES = [16, 32, 48, 64, 128, 512];

const browser = await chromium.launch({ executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe') });
const page = await browser.newPage();
for (const [source, suffix] of [['icon.svg', ''], ['icon-off.svg', '-off']]) {
    const svg = fs.readFileSync(path.join(ICONS, source), 'utf8');
    for (const size of SIZES) {
        await page.setViewportSize({ width: size, height: size });
        await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
        await page.screenshot({ path: path.join(ICONS, `icon${size}${suffix}.png`), omitBackground: true });
    }
}
await browser.close();
console.log(`platform/icons — ${SIZES.length * 2} файлов`);
