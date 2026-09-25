// Разбор сохранённой страницы (MHTML) для R2: кто держит место под рекламу.
//
// Открывает снимок в тестовом браузере без сети и без расширений и
// печатает:
//   1. пустые коробки — видимые блоки заметного размера без видимого
//      содержимого (текста, картинок, видео, canvas, фреймов);
//   2. узлы по рекламным признакам из общих списков;
//   3. по желанию — что лежит в заданных точках страницы.
// Для каждого — цепочку родителей с тем, что резервирует место: размеры,
// min-height, отступы, grid/flex, aspect-ratio.
//
//   node inspect-snapshot.mjs <page.mhtml> [--point x,y ...] [--width 1600]

import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe');

const args = process.argv.slice(2);
const file = args[0];
const points = [];
let width = 1600;
for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--point') points.push(args[++i].split(',').map(Number));
    else if (args[i] === '--width') width = Number(args[++i]);
}

// Признаки рекламы на Авито из RU AdList и общих маркеров.
const AD_MARKERS = [
    'div[class^="adv-"]', 'div[class*=" adv-"]', 'div[class*="advRoot"]',
    'div[class*="avito-ads-container"]', 'div[class*="index-advRootWidget"]',
    'div[class^="advert-"]', 'div[class^="items-ads-"]', 'div[class^="style-ads"]',
    'div[data-key^="advBannerWidget"]', '[data-marker*="ads"]', '[data-marker*="adv"]',
    '[id^="ads_"]', '[data-code^="ads_"]', '[class*="advert-mimicry"]',
    'ins.adsbygoogle', '[id^="yandex_rtb"]', '[id*="adfox"]', '[id*="_R-A-"]',
    '[class*="beduin"]'
];

const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
const page = await browser.newPage({ viewport: { width, height: 900 } });
// Снимок не должен ходить в сеть: всё нужное внутри MHTML.
await page.route('**/*', route => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1500);

const result = await page.evaluate(({ markers, points }) => {
    const px = v => (v && v !== 'auto' && v !== 'none' && v !== 'normal' && v !== '0px') ? v : undefined;

    function describe(el) {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const out = {
            tag: el.tagName.toLowerCase(),
            cls: (el.getAttribute('class') || '').slice(0, 120) || undefined,
            id: el.id || undefined,
            marker: el.getAttribute('data-marker') || undefined,
            rect: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
            display: s.display
        };
        for (const prop of ['height', 'min-height', 'aspect-ratio', 'padding-top', 'padding-bottom', 'margin-top', 'margin-bottom',
            'grid-template-columns', 'grid-template-rows', 'grid-row', 'grid-column', 'gap', 'background-color']) {
            const v = s.getPropertyValue(prop);
            if (prop === 'height' && el.style.height === '') continue;
            if (prop === 'background-color' && (v === 'rgba(0, 0, 0, 0)' || v === 'transparent')) continue;
            if (px(v)) out[prop] = v;
        }
        if (el.getAttribute('style')) out.inline = el.getAttribute('style').slice(0, 160);
        return out;
    }

    function chain(el, limit = 6) {
        const out = [];
        for (let node = el; node && node !== document.body && out.length < limit; node = node.parentElement) {
            out.push(describe(node));
        }
        return out;
    }

    function visibleContent(el) {
        const text = (el.innerText || '').trim();
        if (text.length > 2) return true;
        for (const media of el.querySelectorAll('img, video, canvas, iframe, svg, picture')) {
            const r = media.getBoundingClientRect();
            if (r.width > 20 && r.height > 20) return true;
        }
        const bg = getComputedStyle(el).backgroundImage;
        return bg && bg !== 'none';
    }

    // Пустые коробки: берём самые внешние, вложенные пустые не повторяем.
    const empty = [];
    const all = document.body.querySelectorAll('div, section, li, article, aside');
    for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width < 150 || r.height < 100) continue;
        if (getComputedStyle(el).display === 'none') continue;
        if (visibleContent(el)) continue;
        if (empty.some(outer => outer.contains(el))) continue;
        // Скелетоны загрузки в конце ленты — не реклама; помечаем, но не отбрасываем.
        empty.push(el);
    }

    const marked = [];
    for (const selector of markers) {
        for (const el of document.querySelectorAll(selector)) {
            if (marked.some(m => m.el === el)) continue;
            marked.push({ el, selector });
        }
    }

    return {
        title: document.title,
        height: document.documentElement.scrollHeight,
        empty: empty.slice(0, 25).map(el => ({ box: describe(el), chain: chain(el.parentElement, 4), innerHTML: el.innerHTML.slice(0, 300) })),
        marked: marked.slice(0, 40).map(({ el, selector }) => ({ selector, box: describe(el), hasContent: visibleContent(el) })),
        points: points.map(([x, y]) => {
            window.scrollTo(0, Math.max(0, y - 400));
            const stack = document.elementsFromPoint(x, y - scrollY).slice(0, 4);
            return { at: [x, y], stack: stack.map(describe), chain: stack[0] ? chain(stack[0], 8) : [] };
        })
    };
}, { markers: AD_MARKERS, points });

console.log(JSON.stringify(result, null, 1));
await browser.close();
