// Съёмка образцов страниц для R1 (§6 и §7 плана).
//
// Для каждой страницы и каждого состояния сохраняет:
//   page.mhtml — страница целиком, со стилями и картинками (вёрстка для тестов);
//   page.har   — все сетевые запросы и ответы (для воспроизведения и сетевых правил);
//   page.png   — скриншот всей страницы;
//   meta.json  — адрес, время, регион выхода в сеть, состояние, соседи, счётчики.
//
// Каждая съёмка — в чистом временном профиле: никаких cookies, входов и истории.
//
//   node capture.mjs                           приоритет 1 из test/corpus.json, все состояния
//   node capture.mjs --priority 2              другой приоритет
//   node capture.mjs --url https://ya.ru/      одна страница
//   node capture.mjs --state clean             только одно состояние (clean | ubol)
//   node capture.mjs --headed                  с окном браузера (антибот-защиты реже ругаются)

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const BROWSER = path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe');

// Соседи — распакованные копии чужих расширений из dev/.neighbors.
const STATES = {
    clean: [],
    ubol: [path.join(DEV, '.neighbors', 'ubol')]
};

const VIEWPORT = { width: 1600, height: 900 };

function parseArgs(argv) {
    const args = { priority: 1, states: Object.keys(STATES), headed: false, urls: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--priority') args.priority = Number(argv[++i]);
        else if (arg === '--state') args.states = [argv[++i]];
        else if (arg === '--url') args.urls.push(argv[++i]);
        else if (arg === '--headed') args.headed = true;
    }
    return args;
}

// Имя папки из адреса: домен и путь без лишних символов.
function slug(url) {
    const u = new URL(url);
    const tail = (u.pathname + u.search).replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '');
    return (u.hostname.replace(/^www\./, '') + (tail ? '_' + tail : '')).slice(0, 80);
}

// Регион выхода в сеть. Без него образец рекламы ничего не доказывает:
// из-за рубежа Яндекс и Авито показывают другую рекламу.
async function networkRegion() {
    try {
        const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
        const text = await response.text();
        const loc = /^loc=(.+)$/m.exec(text);
        return loc ? loc[1] : 'unknown';
    } catch {
        return 'unknown';
    }
}

// Ленивая реклама грузится при прокрутке. Проматываем страницу вниз
// экранами, потом возвращаемся наверх.
async function scrollThrough(page) {
    await page.evaluate(async () => {
        const step = window.innerHeight * 0.8;
        const limit = Math.min(document.documentElement.scrollHeight, 20000);
        for (let y = 0; y < limit; y += step) {
            window.scrollTo(0, y);
            await new Promise(resolve => setTimeout(resolve, 350));
        }
        window.scrollTo(0, 0);
    });
}

// Грубая перепись страницы: пригодится, чтобы сразу видеть, что снято
// (не капча ли, не пустая ли страница).
async function census(page) {
    return page.evaluate(() => ({
        title: document.title,
        elements: document.getElementsByTagName('*').length,
        iframes: document.querySelectorAll('iframe').length,
        textLength: (document.body && document.body.innerText || '').length,
        scrollHeight: document.documentElement.scrollHeight,
        captchaSuspected: /captcha|капч|robot|робот|showcaptcha/i.test(document.title + ' ' + location.href)
    }));
}

async function captureOne(url, state, headed, outRoot, region) {
    const dir = path.join(outRoot, slug(url), state);
    await fs.mkdir(dir, { recursive: true });
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-capture-'));
    const extensions = STATES[state];

    // Язык интерфейса браузера — русский, как у наших пользователей: по нему
    // uBO Lite сам включает RU AdList. Язык страницы (locale ниже) на
    // расширение не влияет.
    const args = ['--lang=ru'];
    if (extensions.length) {
        args.push('--disable-extensions-except=' + extensions.join(','));
        args.push('--load-extension=' + extensions.join(','));
    }

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: BROWSER,
        headless: !headed,
        viewport: VIEWPORT,
        locale: 'ru-RU',
        args,
        recordHar: { path: path.join(dir, 'page.har'), content: 'embed' }
    });

    const meta = { url, state, region, extensions: extensions.map(e => path.basename(e)), startedAt: new Date().toISOString() };
    try {
        // Расширению нужно мгновение, чтобы зарегистрировать правила.
        if (extensions.length) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        const page = context.pages()[0] || await context.newPage();
        // Из-за рубежа российские сайты отвечают нестабильно: одна повторная
        // попытка спасает большую часть таймаутов.
        let response;
        for (let attempt = 1; ; attempt += 1) {
            try {
                response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                break;
            } catch (error) {
                if (attempt >= 2) throw error;
                meta.retried = String(error.message || error).split('\n')[0].slice(0, 200);
            }
        }
        meta.status = response ? response.status() : null;
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        // Антибот-защита может увести страницу на капчу посреди съёмки.
        // Тогда прокрутка падает с «context destroyed»: ждём, пока новая
        // страница загрузится, и снимаем то, что есть, — это тоже результат.
        try {
            await scrollThrough(page);
        } catch (error) {
            meta.navigatedAway = String(error.message || error).split('\n')[0].slice(0, 200);
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        }
        await page.waitForTimeout(3000);

        meta.finalUrl = page.url();
        meta.census = await census(page);

        const session = await context.newCDPSession(page);
        const { data } = await session.send('Page.captureSnapshot', { format: 'mhtml' });
        await fs.writeFile(path.join(dir, 'page.mhtml'), data);
        await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true, timeout: 30000 }).catch(error => {
            meta.screenshotError = String(error.message || error).slice(0, 200);
        });
        meta.ok = true;
    } catch (error) {
        meta.ok = false;
        meta.error = String(error.message || error).slice(0, 500);
    } finally {
        meta.finishedAt = new Date().toISOString();
        await context.close();
        await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
        await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    }
    return meta;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let urls = args.urls;
    if (!urls.length) {
        const corpus = JSON.parse(await fs.readFile(path.join(ROOT, 'test', 'corpus.json'), 'utf8'));
        urls = corpus.sites.filter(site => site.priority === args.priority).map(site => site.url);
    }

    const region = await networkRegion();
    const day = new Date().toISOString().slice(0, 10);
    const outRoot = path.join(ROOT, 'test', 'fixtures', 'raw', `${day}_${region}`);
    console.log(`Регион: ${region}. Страниц: ${urls.length}, состояний: ${args.states.join(', ')}. Папка: ${outRoot}`);

    const summary = [];
    // Частые заходы на один сайт подряд антибот считает атакой: Авито после
    // серии отвечал 429. Между заходами на тот же домен — пауза.
    const SAME_HOST_PAUSE_MS = 10000;
    let lastHost = null;
    for (const url of urls) {
        for (const state of args.states) {
            const host = new URL(url).hostname.replace(/^(www|m)\./, '');
            if (host === lastHost) {
                await new Promise(resolve => setTimeout(resolve, SAME_HOST_PAUSE_MS));
            }
            lastHost = host;
            const meta = await captureOne(url, state, args.headed, outRoot, region);
            const c = meta.census || {};
            const line = `${meta.ok ? 'ok ' : 'ERR'} ${state.padEnd(5)} ${url}  ` +
                (meta.ok
                    ? `status=${meta.status} elements=${c.elements} iframes=${c.iframes} text=${c.textLength}${c.captchaSuspected ? ' КАПЧА?' : ''}`
                    : meta.error);
            console.log(line);
            summary.push({ url, state, ok: meta.ok, status: meta.status, census: meta.census, error: meta.error });
        }
    }
    await fs.writeFile(path.join(outRoot, 'summary.json'), JSON.stringify({ region, day, summary }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
