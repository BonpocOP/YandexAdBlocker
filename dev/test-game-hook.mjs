// Функциональная проверка игрового слоя без захода на Яндекс.
//
// Браузер с настоящим расширением «открывает» yandex.ru/games/app/… и фрейм
// игры на *.cdn.games.yandex.net, но все ответы подставляем сами: страница с
// фреймом и рекламным окном платформы, игра и поддельный Yandex Games SDK.
// Расширение сверяет только адрес, поэтому работает как на живой странице.
//
// Игра вызывает YaGames.init() сразу следующим скриптом после SDK — самый
// неудобный для хука случай.
//
//   node test-game-hook.mjs [--headed]

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const headed = process.argv.includes('--headed');
// --neighbor <имя>: запустить рядом распакованного соседа из dev/.neighbors.
const neighborIndex = process.argv.indexOf('--neighbor');
const neighbor = neighborIndex === -1 ? null : process.argv[neighborIndex + 1];
const EXTENSIONS = [ROOT].concat(neighbor ? [path.join(DEV, '.neighbors', neighbor)] : []);

const TOP_URL = 'https://yandex.ru/games/app/1';
const FRAME_URL = 'https://app-1.cdn.games.yandex.net/1/index.html?sdk=%2Fsdk%2F_%2Fv2.js#origin=https%3A%2F%2Fyandex.ru&app-id=1&device-type=desktop';

const TOP_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<main class="stack"><div class="wrap" style="width: calc(99.99% - 315px); height: 800px">
<iframe id="game-frame" src="${FRAME_URL}" style="width:100%;height:100%;border:0"></iframe></div></main>
<div id="ad" class="play-modal adv-focusable play-modal_fullscreen" style="position:fixed;left:-10200px;top:0;width:1600px;height:900px;background:#000">
  <div id="x_R-A-1-1" style="width:1024px;height:800px;background:#333"></div>
  <button class="close-button close-button_type_adv-fullscreen" data-testid="yandex-fullscreen-render-button" aria-label="Закрыть">×</button>
</div>
<!-- Меню игры: то же окно платформы (adv-focusable), но без следов рекламы. Закрывать нельзя. -->
<div id="menu" class="play-modal adv-focusable" style="position:fixed;left:-10200px;top:0;width:1600px;height:900px;background:#222">
  <div style="width:300px;height:200px;color:#fff">Меню игры</div>
  <button aria-label="Закрыть">×</button>
</div>
<!-- Зависшая оболочка: свой крестик рекламы есть, а содержимое не отрисовано. -->
<div id="stuck" class="play-modal adv-focusable play-modal_fullscreen" style="position:fixed;left:-10200px;top:0;width:1600px;height:900px;background:#000">
  <div id="y_R-A-1-2" style="width:0;height:0"></div>
  <button class="close-button close-button_type_adv-fullscreen" data-testid="yandex-fullscreen-render-button" aria-label="Закрыть">×</button>
</div>
<!-- Промо платформы со слайдом и крестиком. -->
<div id="promo" class="prowo-container prowo-container_advType_interstitial" style="position:fixed;left:-10200px;top:0;width:1600px;height:900px;background:#114">
  <div class="promo-slide" style="width:800px;height:600px;background:#228">Промо</div>
  <button aria-label="Закрыть">×</button>
</div>
<!-- Приманка детектора блокировщиков — расширение не должно её трогать. -->
<div id="AdBanner" class="AdsBox ad_box" style="position:absolute;left:-9999px;top:0;width:1px;height:1px"></div>
<!-- Рекламный узел, который спрятал «сосед» — должен попасть в отчёт. -->
<div class="adv-neighbor-slot" style="display:none">x</div>
<!-- Промо, у которого не загрузился слайд: ни содержимого, ни крестика. -->
<div id="promoEmpty" class="prowo-container prowo-container_advType_interstitial" style="position:fixed;left:-10200px;top:0;width:1600px;height:900px;background:#114"></div>
<script>
  window.closedAt = {};
  window.shownAt = {};
  window.show = id => {
    const m = document.getElementById(id);
    m.style.left = '0px';
    window.shownAt[id] = Date.now();
    const b = m.querySelector('button');
    if (b) b.onclick = () => { m.style.left = '-10200px'; window.closedAt[id] = Date.now() - window.shownAt[id]; };
  };
  window.state = id => {
    const m = document.getElementById(id);
    const r = m.getBoundingClientRect();
    const s = getComputedStyle(m);
    return { onScreen: r.right > 0 && r.left < innerWidth && s.display !== 'none', display: s.display, opacity: s.opacity, closedMs: window.closedAt[id] };
  };
</script></body></html>`;

const GAME_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="/sdk/_/v2.js"></script>
<script>
  window.game = { ready: false };
  YaGames.init().then(ysdk => { window.game.ysdk = ysdk; window.game.ready = true; });
</script>
<script>
  // Игра со встроенным SDK: присваивание YaGames и init() в одном скрипте,
  // события загрузки между ними нет — ловит только перехват присваивания.
  // Свой класс: прототип Adv из первого SDK уже подменён.
  class BundledAdv {
    showRewardedVideo(options) { window.originalCalls += 1; const cb = (options && options.callbacks) || {}; setTimeout(() => { cb.onOpen && cb.onOpen(); cb.onClose && cb.onClose(); }, 10); return Promise.resolve(); }
  }
  window.YaGames = { init() { return Promise.resolve({ adv: new BundledAdv() }); } };
  YaGames.init().then(ysdk => { window.game.bundled = ysdk; });
</script>
<script>
  // Как настоящий SDK v2 (yandex.ru/games/sdk/_/v2.*.js): var YaGames,
  // YaGames — класс со статическим init, который зовёт this.*, adv завёрнут
  // в прозрачный Proxy, методы в прототипе. Игра 602493 шла этим путём,
  // и хук пропускал класс: ждал только объект.
  var YaGames;
  window.advReads = [];
  class ClassAdv {
    showRewardedVideo(options) { window.originalCalls += 1; const cb = (options && options.callbacks) || {}; setTimeout(() => { cb.onOpen && cb.onOpen(); cb.onClose && cb.onClose(); }, 10); return Promise.resolve(); }
  }
  class Ya {
    constructor() { throw new Error('Please, use YaGames.init instead.'); }
    // Как Te в SDK: Proxy запоминает, какие методы прочитали.
    static setup() { return { adv: new Proxy(new ClassAdv(), { get: (target, key) => { window.advReads.push(String(key)); return target[key]; } }) }; }
    static async init() { return this.setup(); }
  }
  window.YaGames = Ya;
  YaGames = Ya;
  YaGames.init().then(ysdk => { window.game.classSdk = ysdk; });
</script></body></html>`;

// Поддельный SDK: методы рекламы — в прототипе класса, как у настоящего.
const SDK_JS = `
  window.originalCalls = 0;
  class Adv {
    showRewardedVideo(options) { window.originalCalls += 1; const cb = (options && options.callbacks) || {}; setTimeout(() => { cb.onOpen && cb.onOpen(); cb.onClose && cb.onClose(); }, 10); return Promise.resolve(); }
    showFullscreenAdv(options) { window.originalCalls += 1; const cb = (options && options.callbacks) || {}; setTimeout(() => { cb.onClose && cb.onClose(true); }, 10); return Promise.resolve(); }
  }
  window.YaGames = { init() { return Promise.resolve({ adv: new Adv() }); } };
`;

const results = [];
const check = (name, ok, detail) => results.push({ ok: Boolean(ok), name, detail });

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-hook-'));
const context = await chromium.launchPersistentContext(profile, {
    executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe'),
    headless: !headed,
    viewport: { width: 1600, height: 900 },
    args: ['--lang=ru', '--disable-extensions-except=' + EXTENSIONS.join(','), '--load-extension=' + EXTENSIONS.join(',')]
});

try {
    if (neighbor) {
        console.log('Рядом: ' + neighbor);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    // Всё подставляем сами; в настоящую сеть ничего не уходит.
    await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith('https://yandex.ru/games/app/1')) return route.fulfill({ contentType: 'text/html', body: TOP_HTML });
        if (url.startsWith('https://app-1.cdn.games.yandex.net/1/index.html')) return route.fulfill({ contentType: 'text/html', body: GAME_HTML });
        if (url.startsWith('https://app-1.cdn.games.yandex.net/sdk/_/v2.js')) return route.fulfill({ contentType: 'text/javascript', body: SDK_JS });
        return route.abort();
    });

    const isOurs = w => w.url().endsWith('/src/background.js');
    let worker = context.serviceWorkers().find(isOurs);
    if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: 15000 });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(TOP_URL, { waitUntil: 'load' });
    const frame = await (async () => {
        for (let i = 0; i < 50; i += 1) {
            const f = page.frames().find(x => x.url().startsWith('https://app-1.cdn.games.yandex.net'));
            if (f) return f;
            await page.waitForTimeout(100);
        }
        return null;
    })();
    check('фрейм игры загрузился', frame);
    await frame.waitForFunction(() => window.game && window.game.ready, null, { timeout: 5000 });
    await page.waitForTimeout(800);

    // --- незаметность во фрейме
    const stealth = await frame.evaluate(() => {
        const proto = Object.getPrototypeOf(window.game.ysdk.adv);
        const d = Object.getOwnPropertyDescriptor(proto, 'showRewardedVideo');
        const yd = Object.getOwnPropertyDescriptor(window, 'YaGames');
        return {
            globals: Object.keys(window).filter(k => /ygab/i.test(k)),
            ownOnAdv: Object.keys(window.game.ysdk.adv),
            yaGames: yd ? (yd.get ? 'accessor' : 'data') : 'none',
            proto: d ? { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable, name: d.value.name, length: d.value.length } : null
        };
    });
    check('во фрейме нет глобалов расширения', stealth.globals.length === 0, stealth.globals);
    check('на объекте adv нет собственных свойств-меток', stealth.ownOnAdv.length === 0, stealth.ownOnAdv);
    check('метод остался в прототипе с тем же дескриптором, именем и длиной',
        stealth.proto && stealth.proto.writable === true && stealth.proto.enumerable === false && stealth.proto.configurable === true &&
        stealth.proto.name === 'showRewardedVideo' && stealth.proto.length === 1, stealth.proto);

    // --- награда без ролика
    const callRewarded = (which = 'ysdk') => frame.evaluate(which => new Promise(resolve => {
        const got = { open: false, rewarded: false, close: false };
        const before = window.originalCalls;
        window.game[which].adv.showRewardedVideo({ callbacks: {
            onOpen: () => { got.open = true; },
            onRewarded: () => { got.rewarded = true; },
            onClose: () => { got.close = true; setTimeout(() => resolve({ ...got, original: window.originalCalls - before }), 50); }
        } });
        setTimeout(() => resolve({ ...got, original: window.originalCalls - before, timeout: true }), 3000);
    }), which);
    const r1 = await callRewarded();
    check('реклама за награду: награда пришла, настоящий SDK не вызван', r1.rewarded && r1.close && r1.original === 0, r1);
    const rb = await callRewarded('bundled');
    check('SDK встроен в игру (init без паузы): награда без ролика', rb.rewarded && rb.close && rb.original === 0, rb);
    // До первого вызова игрой никто не читал методы adv через Proxy SDK.
    const advReads = await frame.evaluate(() => window.advReads.slice());
    check('SDK v2: хук не читает методы adv через Proxy SDK', advReads.length === 0, advReads);
    const rc = await callRewarded('classSdk');
    check('SDK v2: YaGames — класс со статическим init: награда без ролика', rc.rewarded && rc.close && rc.original === 0, rc);

    // --- тумблера «за награду» больше нет: старое значение в хранилище не мешает
    await worker.evaluate(() => chrome.storage.sync.set({ rewarded: false }));
    await page.waitForTimeout(600);
    const r2 = await callRewarded();
    check('старый rewarded: false в хранилище: награда всё равно без ролика', r2.rewarded && r2.original === 0, r2);
    await worker.evaluate(() => chrome.storage.sync.remove('rewarded'));

    // --- полноэкранная реклама без ролика
    const f1 = await frame.evaluate(() => new Promise(resolve => {
        const before = window.originalCalls;
        window.game.ysdk.adv.showFullscreenAdv({ callbacks: { onClose: shown => setTimeout(() => resolve({ shown, original: window.originalCalls - before }), 50) } });
        setTimeout(() => resolve({ timeout: true }), 3000);
    }));
    check('полноэкранная: onClose(false), настоящий SDK не вызван', f1.shown === false && f1.original === 0, f1);

    // --- окна платформы: каждый сценарий по очереди, чтобы не мешали друг другу
    const scenario = async (id, waitMs) => {
        await page.evaluate(id => window.show(id), id);
        await page.waitForTimeout(waitMs);
        const st = await page.evaluate(id => window.state(id), id);
        await page.evaluate(id => { const m = document.getElementById(id); m.style.left = '-10200px'; }, id);
        await page.waitForTimeout(600);
        return st;
    };

    const ad = await scenario('ad', 1500);
    check('рекламное окно платформы закрыто кликом по крестику за ≤ 1 с', ad.closedMs !== undefined && ad.closedMs <= 1000, ad);

    const menu = await scenario('menu', 4500);
    check('меню игры (окно без следов рекламы) не закрыто и видно', menu.onScreen && menu.closedMs === undefined && menu.opacity === '1', menu);

    const stuck = await scenario('stuck', 4500);
    check('зависшая оболочка рекламы закрыта за ≤ 4 с', stuck.closedMs !== undefined && stuck.closedMs <= 4000, stuck);

    const promo = await scenario('promo', 1500);
    check('промо платформы закрыто кликом за ≤ 1 с', promo.closedMs !== undefined && promo.closedMs <= 1000, promo);

    const promoEmpty = await scenario('promoEmpty', 3000);
    check('пустое промо без крестика убрано за ≤ 3 с', !promoEmpty.onScreen, promoEmpty);

    // --- игра растянута на место бокового блока
    const stretch = await page.evaluate(() => {
        const wrap = document.querySelector('.wrap');
        return { inline: wrap.style.width, width: Math.round(wrap.getBoundingClientRect().width), viewport: innerWidth };
    });
    check('обёртка игры растянута: calc(… − 315px) заменён на 100%', stretch.width === stretch.viewport, stretch);

    // --- в обычном состоянии на <html> нет наших флагов
    const htmlAttrs = await page.evaluate(() => [...document.documentElement.attributes].map(a => a.name));
    check('на <html> нет атрибутов расширения', !htmlAttrs.some(a => /ygab/.test(a)), htmlAttrs);

    // --- следов в верхнем документе нет
    const topStealth = await page.evaluate(() => {
        const marks = [];
        for (const el of document.querySelectorAll('*')) {
            for (const a of el.attributes) if (/ygab/i.test(a.name + a.value)) marks.push(el.tagName + '[' + a.name + ']');
            if (/ygab/i.test(el.className && el.className.baseVal === undefined ? el.className : '')) marks.push(el.tagName + '.' + el.className);
        }
        return { marks, globals: Object.keys(window).filter(k => /ygab/i.test(k)) };
    });
    check('верхний документ: ни атрибутов, ни классов, ни глобалов', topStealth.marks.length === 0 && topStealth.globals.length === 0, topStealth);

    // --- спрятанный баннер возвращается в спрятанное, если страница стёрла стиль
    // (регрессия после отказа от атрибута-метки)
    // Для этого нужен баннер: добавим и дадим расширению его спрятать.
    await page.evaluate(() => {
        const b = document.createElement('div');
        b.className = 'yandex-sticky-adv-banner';
        b.style.cssText = 'height: 90px; background: red';
        b.textContent = 'ad';
        document.body.append(b);
        window.banner = b;
    });
    await page.waitForTimeout(800);
    const hidden1 = await page.evaluate(() => getComputedStyle(window.banner).display);
    await page.evaluate(() => { window.banner.setAttribute('style', 'height: 90px; background: red'); });
    await page.waitForTimeout(2600);
    const hidden2 = await page.evaluate(() => ({ display: getComputedStyle(window.banner).display, visibility: getComputedStyle(window.banner).visibility }));
    check('баннер спрятан', hidden1 === 'none', hidden1);
    check('после того как страница стёрла стиль, баннер снова спрятан', hidden2.display === 'none', hidden2);

    // --- отчёт получает диагностику из фрейма через фоновый скрипт
    const report = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({});
        const r = (await chrome.tabs.sendMessage(tab.id, { action: 'getReport' }, { frameId: 0 })).report;
        return { version: r.version, sdkEvents: r.sdkEvents.map(e => `${e.kind}:${typeof e.detail === 'string' ? e.detail : ''}`), journal: r.journal.map(j => j.kind), environment: r.environment, cost: r.cost };
    });
    check('отчёт: хук загрузился во фрейме', report.sdkEvents.includes('sdk-hook-loaded:iframe'), report.sdkEvents);
    check('отчёт: методы SDK подменены', report.sdkEvents.some(e => e.startsWith('sdk-patched:') && e.includes('showRewardedVideo') && e.includes('showFullscreenAdv')), report.sdkEvents);
    check('отчёт: вызовы рекламы игрой в журнале', report.journal.includes('sdk-call'), report.journal);
    check('отчёт: закрытие окна в журнале', report.journal.includes('dismiss-end'), report.journal);
    // Бюджет скорости: наш проход по странице дёшев и сценарий целиком тоже.
    const cost = report.cost || {};
    check('бюджет: средний проход ≤ 5 мс, самый долгий ≤ 50 мс, всего ≤ 300 мс', cost.scans > 0 && cost.avgMs <= 5 && cost.maxMs <= 50 && cost.totalMs <= 300, cost);
    const env = report.environment || {};
    check('отчёт: видит рекламный узел, спрятанный не нами', env.hiddenByOthers >= 1, env);
    // Приманку может спрятать сосед — это его след, не наш. Наша забота —
    // не тронуть её самим; без соседа она должна остаться видимой вовсе.
    check('отчёт: приманку детектора не тронули мы', Array.isArray(env.baits) && env.baits.length > 0 && env.baits.every(b => !b.byUs), env.baits);
    if (!neighbor) {
        check('без соседа приманка видима', env.baits.every(b => !b.hidden), env.baits);
    }
} catch (error) {
    check('тест не упал', false, String(error.message || error).slice(0, 300));
} finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

for (const r of results) {
    console.log(`${r.ok ? 'ОК  ' : 'СБОЙ'} ${r.name}${r.ok ? '' : '  → ' + JSON.stringify(r.detail)}`);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\nИтого: ${results.length - failed} из ${results.length}`);
process.exit(failed ? 1 : 0);
