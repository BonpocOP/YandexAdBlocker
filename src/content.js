// Content-script варианта B: прячет рекламные блоки, снимает зарезервированное
// под них место и заставляет игру пересчитать свой размер.
//
// Порядок шагов важен: сначала измеряем баннер (его ещё видно в потоке,
// blocker.css прячет его через visibility), потом убираем из потока, потом
// чиним геометрию родителей и только затем растягиваем фрейм игры.
(() => {
    'use strict';

    const DEFAULTS = {
        enabled: true,
        sticky: true,
        fullscreen: true,
        rewarded: true,
        catalog: true
    };

    const HIDDEN_ATTR = 'data-ygab-hidden';
    const SDK_ATTR = 'data-ygab-sdk';

    // Sticky-баннер внутри запущенной игры. Совпадение по подстроке, а не по
    // полному классу: Яндекс регулярно меняет модификаторы вроде
    // yandex-sticky-adv-banner__desktop-wrapper_with-disable-ad-button.
    const STICKY_SELECTORS = [
        '[class*="sticky-adv-banner"]',
        '[class*="yandex-sticky-adv"]',
        '[class*="adv-banner"]',
        '[class*="AdvBanner"]',
        '[data-testid*="adv"]',
        'iframe[src*="an.yandex.ru"]',
        'iframe[src*="yabs.yandex"]',
        'iframe[src*="adfox"]'
    ];
    const STICKY_SELECTOR = STICKY_SELECTORS.join(', ');

    // Рекламные вставки в каталоге игр и общие контейнеры рекламной сети.
    const CATALOG_SELECTORS = [
        '[id^="adfox_"]',
        '[id*="yandex_rtb"]',
        '[class*="AdvCard"]',
        '[class*="adv-card"]',
        '[class*="promo-banner"]',
        'ins.adsbygoogle'
    ];

    // Свойства, которыми страница резервирует место под баннер. Значение,
    // совпавшее с высотой баннера, обнуляем.
    const SIZE_PROPS = ['height', 'min-height', 'max-height', 'padding-bottom', 'margin-bottom', 'bottom'];
    const CUSTOM_PROP_RE = /(adv|ads?|banner)/i;

    let settings = { ...DEFAULTS };
    let observer = null;
    let shellObserver = null;
    let scanTimer = null;
    let pageBlocked = 0;
    let pendingTotal = 0;
    let flushTimer = null;
    let lastBannerParent = null;
    let suppressCount = false;

    // Каждая правка инлайн-стиля запоминается, чтобы тумблер «выключить»
    // возвращал страницу в исходное состояние без перезагрузки.
    const touched = [];

    /* ---------- утилиты ---------- */

    const isTopGamePage = () => location.pathname.startsWith('/games') && window.top === window.self;
    const isGameAppPage = () => location.pathname.startsWith('/games/app');

    function force(el, prop, value) {
        touched.push({
            el,
            prop,
            prev: el.style.getPropertyValue(prop),
            priority: el.style.getPropertyPriority(prop)
        });
        el.style.setProperty(prop, value, 'important');
    }

    function restoreStyles() {
        while (touched.length) {
            const { el, prop, prev, priority } = touched.pop();
            if (prev) {
                el.style.setProperty(prop, prev, priority);
            } else {
                el.style.removeProperty(prop);
            }
        }
    }

    function pxOf(value) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
    }

    const near = (a, b, tolerance = 3) => a !== null && Math.abs(a - b) <= tolerance;

    /* ---------- скрытие ---------- */

    function hide(el) {
        if (!el || el.getAttribute(HIDDEN_ATTR) === '1') {
            return false;
        }

        el.setAttribute(HIDDEN_ATTR, '1');
        // Дублируем CSS инлайном: страница перерисовывает баннер и может
        // навесить свои стили поверх нашего файла.
        el.style.setProperty('display', 'none', 'important');

        // При пересканировании после смены настроек блоки те же самые —
        // счётчик они увеличивать не должны.
        if (!suppressCount) {
            pageBlocked += 1;
            pendingTotal += 1;
            scheduleTotalFlush();
        }
        return true;
    }

    function unhideAll() {
        document.querySelectorAll('[' + HIDDEN_ATTR + '="1"]').forEach(el => {
            el.removeAttribute(HIDDEN_ATTR);
            el.style.removeProperty('display');
        });
    }

    function scheduleTotalFlush() {
        if (flushTimer || !chrome.storage) {
            return;
        }
        // За один проход скрывается несколько блоков — пишем статистику пачкой.
        flushTimer = setTimeout(() => {
            const increment = pendingTotal;
            pendingTotal = 0;
            flushTimer = null;
            if (!increment) {
                return;
            }
            chrome.storage.local.get({ totalBlocked: 0 }, ({ totalBlocked }) => {
                chrome.storage.local.set({ totalBlocked: (Number(totalBlocked) || 0) + increment });
            });
        }, 300);
    }

    /* ---------- починка геометрии ---------- */

    // Место под рекламу может резервироваться на любом уровне выше баннера,
    // поэтому работаем с цепочкой родителей, а не с одним узлом.
    function ancestorChain(node, limit = 8) {
        const chain = [];
        let el = node ? node.parentElement : null;
        let depth = 0;
        while (el && depth < limit) {
            chain.push(el);
            el = el.parentElement;
            depth += 1;
        }
        return chain;
    }

    // Инлайновые calc(100% - 90px) и подобные: подменяем на полный размер.
    function fixCalc(el, prop, height) {
        const inline = el.style.getPropertyValue(prop);
        if (!inline || !inline.includes('calc')) {
            return;
        }
        const hasBannerSize = Array.from(inline.matchAll(/(\d+(?:\.\d+)?)px/g))
            .some(match => near(parseFloat(match[1]), height));
        if (!hasBannerSize) {
            return;
        }
        const isOffset = prop.startsWith('padding') || prop.startsWith('margin') || prop === 'bottom';
        force(el, prop, isOffset ? '0px' : '100%');
    }

    // CSS-переменные вида --sticky-adv-height: 90px. Имя заранее неизвестно,
    // поэтому ищем по смыслу: подходящее имя плюс совпавшее значение.
    function fixCustomProps(el, height) {
        let computed;
        try {
            computed = getComputedStyle(el);
        } catch (e) {
            return;
        }
        for (const name of computed) {
            if (!name.startsWith('--') || !CUSTOM_PROP_RE.test(name)) {
                continue;
            }
            if (near(pxOf(computed.getPropertyValue(name)), height)) {
                force(el, name, '0px');
            }
        }
    }

    function neutralizeReservedSpace(chain, height) {
        for (const el of chain) {
            let computed;
            try {
                computed = getComputedStyle(el);
            } catch (e) {
                continue;
            }

            for (const prop of SIZE_PROPS) {
                fixCalc(el, prop, height);
            }

            // Отступ ровно в высоту баннера — это и есть резерв под него.
            for (const prop of ['padding-bottom', 'margin-bottom']) {
                if (near(pxOf(computed.getPropertyValue(prop)), height)) {
                    force(el, prop, '0px');
                }
            }

            // Grid-трек под баннер схлопываем в ноль.
            const rows = computed.getPropertyValue('grid-template-rows');
            if (rows && rows.includes('px')) {
                const patched = rows.replace(/(\d+(?:\.\d+)?)px/g, (match, num) =>
                    near(parseFloat(num), height) ? '0px' : match);
                if (patched !== rows) {
                    force(el, 'grid-template-rows', patched);
                }
            }

            fixCustomProps(el, height);
        }

        fixCustomProps(document.documentElement, height);
    }

    function largestFrame() {
        let best = null;
        let bestArea = 0;
        document.querySelectorAll('iframe').forEach(frame => {
            const rect = frame.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = frame;
            }
        });
        return bestArea > 10000 ? best : null;
    }

    // Главный шаг против «пустого поля»: идём от фрейма игры вверх и там, где
    // элемент ровно на высоту баннера ниже своего родителя, растягиваем его на
    // 100%. Опора на измерения, а не на имена классов, — переживёт редизайн.
    function expandGameFrame(height) {
        const frame = largestFrame();
        if (!frame) {
            return;
        }

        let node = frame;
        let depth = 0;
        while (node && node.parentElement && node !== document.body && depth < 8) {
            const parent = node.parentElement;
            const gap = parent.getBoundingClientRect().height - node.getBoundingClientRect().height;
            if (gap > 0 && near(gap, height, 6)) {
                force(node, 'height', '100%');
                force(node, 'max-height', '100%');
            }
            node = parent;
            depth += 1;
        }
    }

    // Когда меняется размер элемента iframe, внутри игры браузер выстреливает
    // resize сам. Верхнему документу событие отправляем руками: его слушает
    // разметка Яндекса, которая считает размер канваса.
    //
    // Троттлинг обязателен: на наш resize страница пересчитывает свои calc и
    // правит инлайн-стиль, мы правим его обратно — без ограничителя получится
    // бесконечная перепалка.
    let lastKick = 0;
    function kickResize() {
        const now = Date.now();
        if (now - lastKick < 300) {
            return;
        }
        lastKick = now;
        window.dispatchEvent(new Event('resize'));
        if (window.visualViewport) {
            window.visualViewport.dispatchEvent(new Event('resize'));
        }
    }

    // Фрейм игры на yandex.ru/games имеет постоянный id; largestFrame() —
    // запасной путь, если разметка его потеряет.
    function gameFrame() {
        return document.getElementById('game-frame') || largestFrame();
    }

    // Разметка режет место под рекламу инлайн-стилем на обёртке фрейма:
    // width: calc(99.99% - 315px) — боковой блок, height: calc(99.99% - 107px)
    // — нижний баннер. Отсюда и бралось пустое поле после обычного адблока:
    // баннер убран, а вычитание осталось.
    //
    // Дублирует правило из blocker.css. CSS достаточно в обычном случае, но
    // JS-путь закрывает варианты, где резерв висит выше по дереву или на
    // элементе без id.
    const CALC_RESERVE_RE = /calc\([^)]*-\s*\d+(?:\.\d+)?px[^)]*\)/i;

    function fixGameShell() {
        const frame = gameFrame();
        if (!frame) {
            return;
        }

        let changed = false;
        const shell = [frame].concat(ancestorChain(frame, 4));
        for (const el of shell) {
            for (const prop of ['width', 'height', 'max-width', 'max-height']) {
                const inline = el.style.getPropertyValue(prop);
                // После нашей правки в инлайне стоит 100% — регулярка больше
                // не совпадёт, повторных записей не будет.
                if (inline && CALC_RESERVE_RE.test(inline)) {
                    force(el, prop, '100%');
                    changed = true;
                }
            }
        }

        if (changed) {
            kickResize();
        }
    }

    // Скрипт страницы переписывает инлайн-стиль обёртки при своих пересчётах,
    // поэтому следим за атрибутами именно этих узлов.
    function watchShell() {
        const frame = gameFrame();
        if (!frame || shellObserver) {
            return;
        }
        shellObserver = new MutationObserver(scheduleScan);
        [frame].concat(ancestorChain(frame, 3)).forEach(el => {
            shellObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        });
    }

    function relayout(height) {
        if (!height) {
            return;
        }
        requestAnimationFrame(() => {
            neutralizeReservedSpace(ancestorChain(lastBannerParent || document.body), height);
            expandGameFrame(height);
            kickResize();
            // Второй проход: часть контейнеров пересчитывается асинхронно, и
            // резерв всплывает уже после первой перерисовки.
            setTimeout(() => {
                expandGameFrame(height);
                kickResize();
            }, 400);
        });
    }

    /* ---------- сканирование ---------- */

    function scanSticky() {
        if (!settings.sticky) {
            return;
        }
        document.querySelectorAll(STICKY_SELECTOR).forEach(el => {
            // Берём самый внешний подходящий узел: скрывать внутренности
            // бесполезно, место в разметке держит именно обёртка.
            let outer = el;
            let parent = outer.parentElement;
            while (parent && parent.matches && parent.matches(STICKY_SELECTOR)) {
                outer = parent;
                parent = outer.parentElement;
            }

            const height = outer.getBoundingClientRect().height;
            if (hide(outer) && height > 0) {
                lastBannerParent = outer.parentElement;
                relayout(height);
            }
        });
    }

    function scanCatalog() {
        if (!settings.catalog || isGameAppPage()) {
            return;
        }
        CATALOG_SELECTORS.forEach(selector => {
            document.querySelectorAll(selector).forEach(hide);
        });
    }

    function scan() {
        if (!settings.enabled || !document.body) {
            return;
        }
        scanSticky();
        scanCatalog();
        // Не зависит от того, нашёлся ли баннер: резерв в calc остаётся на
        // месте, даже когда рекламный блок ещё не отрисован.
        if (settings.sticky && isGameAppPage()) {
            fixGameShell();
            watchShell();
        }
    }

    function scheduleScan() {
        if (scanTimer) {
            return;
        }
        // Разметка прилетает пачками мутаций — склеиваем их в один проход.
        scanTimer = setTimeout(() => {
            scanTimer = null;
            scan();
        }, 150);
    }

    function startObserver() {
        if (observer) {
            return;
        }
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // SPA-навигация между играми и каталогом: баннер вставляют заново.
        window.addEventListener('popstate', scheduleScan);
        window.addEventListener('pageshow', scheduleScan);
    }

    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (shellObserver) {
            shellObserver.disconnect();
            shellObserver = null;
        }
    }

    /* ---------- состояние и связь с попапом ---------- */

    // MAIN-world скрипт не имеет доступа к chrome.storage, поэтому настройки
    // для него кладём в атрибут <html>, а он читает их в момент вызова рекламы.
    function publishSdkSettings() {
        document.documentElement.setAttribute(SDK_ATTR, JSON.stringify({
            enabled: settings.enabled,
            fullscreen: settings.fullscreen,
            rewarded: settings.rewarded
        }));
    }

    // Атрибуты на <html> управляют правилами blocker.css: так выключенный
    // тумблер возвращает рекламу на место без перезагрузки страницы.
    function publishCssFlags() {
        const root = document.documentElement;
        const flag = (attr, on) => on ? root.removeAttribute(attr) : root.setAttribute(attr, 'off');
        flag('data-ygab', settings.enabled);
        flag('data-ygab-sticky', settings.sticky);
        flag('data-ygab-catalog', settings.catalog);
        // Растягивание фрейма относится к тому же тумблеру, что и баннер:
        // без баннера место всё равно надо отдать игре.
        flag('data-ygab-layout', settings.sticky);
    }

    function applyState() {
        publishSdkSettings();
        publishCssFlags();

        // Настройки могли сузиться, поэтому сначала возвращаем страницу в
        // исходный вид, а потом скрываем заново уже по новым правилам.
        stopObserver();
        restoreStyles();
        unhideAll();

        if (!settings.enabled) {
            pageBlocked = 0;
            kickResize();
            return;
        }

        suppressCount = pageBlocked > 0;
        startObserver();
        scan();
        suppressCount = false;
        // После пересканирования счётчик приводим к тому, что реально скрыто:
        // набор правил мог сузиться.
        pageBlocked = document.querySelectorAll('[' + HIDDEN_ATTR + '="1"]').length;
        kickResize();
    }

    // Отчёт для разбора нерабочих селекторов: попап кладёт его в буфер обмена.
    function buildReport() {
        const banner = document.querySelector(STICKY_SELECTOR);
        const frame = largestFrame();
        const describe = el => el ? {
            tag: el.tagName,
            class: el.getAttribute('class'),
            id: el.id || null,
            rect: el.getBoundingClientRect().toJSON(),
            inlineStyle: el.getAttribute('style')
        } : null;

        // Если селекторы промахнулись, выручают «подозреваемые»: всё, что
        // похоже на рекламу по классу, id или адресу фрейма. По ним видно,
        // как Яндекс назвал блок на самом деле.
        const suspectRe = /(adv|adfox|rtb|yabs|banner|promo)/i;
        const suspects = Array.from(document.querySelectorAll('div, section, aside, iframe, ins'))
            .filter(el => {
                const className = typeof el.className === 'string' ? el.className : '';
                return suspectRe.test(className) || suspectRe.test(el.id) || suspectRe.test(el.getAttribute('src') || '');
            })
            .slice(0, 20)
            .map(el => ({
                tag: el.tagName,
                class: typeof el.className === 'string' ? el.className : null,
                id: el.id || null,
                src: el.getAttribute('src'),
                rect: el.getBoundingClientRect().toJSON()
            }));

        return {
            url: location.href,
            blockedOnPage: pageBlocked,
            settings,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            banner: describe(banner),
            bannerChain: ancestorChain(banner, 5).map(describe),
            gameFrame: describe(frame),
            gameFrameChain: ancestorChain(frame, 5).map(describe),
            // Соседи обёртки — там обычно и лежит боковой рекламный блок.
            frameSiblings: frame && frame.parentElement && frame.parentElement.parentElement
                ? Array.from(frame.parentElement.parentElement.children).map(describe)
                : [],
            suspects,
            bannerHTML: banner ? banner.outerHTML.slice(0, 1500) : null
        };
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (!request) {
                return;
            }
            if (request.action === 'getStats') {
                sendResponse({ blockedOnPage: pageBlocked, isGamePage: isTopGamePage() });
            } else if (request.action === 'getReport') {
                sendResponse({ report: buildReport() });
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') {
            return;
        }
        let dirty = false;
        for (const key of Object.keys(DEFAULTS)) {
            if (key in changes) {
                settings[key] = changes[key].newValue;
                dirty = true;
            }
        }
        if (dirty) {
            applyState();
        }
    });

    chrome.storage.sync.get(DEFAULTS, stored => {
        settings = { ...DEFAULTS, ...stored };
        applyState();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scan, { once: true });
        }
    });
})();
