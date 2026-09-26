'use strict';

// Диагностический отчёт для попапа.
//
// Нужен, когда Яндекс поменял вёрстку: по нему правятся зацепки в config.js.

// Общее описание узла. src фрейма игры показывает, покрыт ли его origin в
// manifest: без этого не понять, доехал ли хук SDK до нужного документа.
function describe(el) {
    return el ? {
        tag: el.tagName,
        class: el.getAttribute('class'),
        id: el.id || null,
        src: el.getAttribute('src'),
        rect: el.getBoundingClientRect().toJSON(),
        inlineStyle: el.getAttribute('style')
    } : null;
}

// «Подозреваемые» выручают, когда зацепки промахнулись: всё, что похоже на
// рекламу по классу, id или адресу фрейма. По ним видно, как Яндекс назвал
// блок на самом деле.
const SUSPECT_RE = /(adv|adfox|rtb|yabs|banner|promo)/i;

function collectSuspects() {
    return Array.from(document.querySelectorAll('div, section, aside, iframe, ins'))
        .filter(el => {
            const className = typeof el.className === 'string' ? el.className : '';
            return SUSPECT_RE.test(className)
                || SUSPECT_RE.test(el.id)
                || SUSPECT_RE.test(el.getAttribute('src') || '');
        })
        .slice(0, 20)
        .map(el => ({
            tag: el.tagName,
            class: typeof el.className === 'string' ? el.className : null,
            id: el.id || null,
            src: el.getAttribute('src'),
            rect: el.getBoundingClientRect().toJSON()
        }));
}

// Почему модал не обработан — главный вопрос следующего теста. Без этого по
// отчёту не отличить «зацепка промахнулась» от «признак показа не сработал»:
// в разметке оба выглядят одинаково.
function describeModal(el) {
    const promo = el.matches(PROMO_INTERSTITIAL_SELECTOR);
    const contentSelector = promo ? PROMO_CONTENT_SELECTOR : AD_CONTENT_SELECTOR;
    const closeSelector = promo ? PROMO_CLOSE_SELECTOR : CLOSE_BUTTON_SELECTOR;
    const content = el.querySelector(contentSelector);

    return {
        tag: el.tagName,
        class: el.getAttribute('class'),
        rect: el.getBoundingClientRect().toJSON(),
        kind: promo ? 'promo' : (isRewardedModal(el) ? 'rewarded' : 'fullscreen'),
        isAdvModal: promo ? true : isAdvModal(el),
        // false у пустого модала — значит, это окно платформы (меню, пауза),
        // и закрывать его как зависшую рекламу нельзя.
        isAdShell: promo ? true : isAdShell(el),
        // Ключевой флаг: false при живой рекламе на экране — значит,
        // промахнулся contentSelector.
        isModalShown: isModalShown(el, contentSelector),
        onScreen: isModalOnScreen(el),
        // Сколько модал уже стоит на экране пустым: больше STUCK_MODAL_MS
        // без закрытия — значит, зависший путь почему-то не сработал.
        stuckMs: stuckSince.has(el) ? Date.now() - stuckSince.get(el) : null,
        contentFound: content ? {
            tag: content.tagName,
            class: content.getAttribute('class'),
            id: content.id || null,
            rect: content.getBoundingClientRect().toJSON()
        } : null,
        closeButtonFound: Boolean(findCloseButton(el, closeSelector)),
        // Какие вообще кнопки есть внутри — по ним видно, как платформа
        // назвала крестик, если наша зацепка промахнулась.
        buttons: Array.from(el.querySelectorAll('button')).slice(0, 6).map(button => ({
            class: button.getAttribute('class'),
            testid: button.getAttribute('data-testid'),
            label: button.getAttribute('aria-label'),
            disabled: button.disabled || button.getAttribute('aria-disabled') === 'true'
        })),
        dismissing: dismissing.has(el),
        hidden: hiddenNodes.has(el),
        inlineStyle: el.getAttribute('style')
    };
}

// Что лежит в центре экрана, сверху вниз. Отвечает на вопросы, которые не
// видны по списку модалов: чей крестик висит посередине и что перехватывает
// клики поверх игры, когда глазу ничего не видно.
function collectAtCenter() {
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    let stack;
    try {
        stack = document.elementsFromPoint(x, y);
    } catch (e) {
        return [];
    }
    return stack.slice(0, 8).map(el => {
        const style = getComputedStyle(el);
        return {
            tag: el.tagName,
            class: el.getAttribute('class'),
            id: el.id || null,
            testid: el.getAttribute('data-testid'),
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            zIndex: style.zIndex
        };
    });
}

function collectModals() {
    const selector = [FULLSCREEN_MODAL_SELECTOR, PROMO_INTERSTITIAL_SELECTOR].join(', ');
    return Array.from(document.querySelectorAll(selector)).slice(0, 12).map(describeModal);
}

// Следы окружения: соседние блокировщики, перевод страницы, сеть. Узнать
// напрямую, какие расширения стоят, нельзя, но по следам видно. Вчерашний
// баг «игра стоит после вкладки» такой блок помог бы разобрать сразу.
const AD_TRACE_SELECTOR = '[id*="_R-A-"], [id^="yandex_rtb"], [id*="adfox"], ins.adsbygoogle, [class*="adv"], [class*="ads"], [class*="Adv"]';
const AD_NETWORK_RE = /an\.yandex\.|yandex\.ru\/ads|adfox|yabs\.yandex|doubleclick|googlesyndication|ad\.mail\.ru|ads\.vk\.com/i;

function collectEnvironment() {
    // Рекламные узлы, спрятанные не нами: вычисленный display: none, а в
    // нашем множестве спрятанного их нет.
    let hiddenByOthers = 0;
    let adTraces = 0;
    for (const el of Array.from(document.querySelectorAll(AD_TRACE_SELECTOR)).slice(0, 500)) {
        adTraces += 1;
        if (hiddenNodes.has(el)) {
            continue;
        }
        try {
            if (getComputedStyle(el).display === 'none') {
                hiddenByOthers += 1;
            }
        } catch (e) {
            /* узел ушёл из документа — пропускаем */
        }
    }

    // Приманки детекторов: если кто-то их спрятал — это не мы (мы их не трогаем).
    const baits = Array.from(document.querySelectorAll(BAIT_SELECTOR)).slice(0, 5).map(el => {
        const style = getComputedStyle(el);
        return {
            id: el.id || null,
            hidden: style.display === 'none' || style.visibility === 'hidden' || el.getClientRects().length === 0,
            // Спрятали ли её мы. Должно быть всегда false; если true — наш баг.
            byUs: hiddenNodes.has(el)
        };
    });

    // Запросы к рекламным сетям, которые дошли: если их ноль на странице с
    // рекламой, их, скорее всего, режет сосед или сеть.
    const adRequests = {};
    for (const entry of performance.getEntriesByType('resource')) {
        if (!AD_NETWORK_RE.test(entry.name)) {
            continue;
        }
        let host;
        try {
            host = new URL(entry.name).hostname;
        } catch (e) {
            continue;
        }
        adRequests[host] = (adRequests[host] || 0) + 1;
    }

    const html = document.documentElement;
    return {
        adTraces,
        hiddenByOthers,
        baits,
        adRequests,
        lang: html.lang || null,
        // Переводчик Chrome ставит на <html> классы translated-ltr/-rtl.
        translated: /translated-(ltr|rtl)/.test(html.className),
        // Что пользователь отметил в попапе сам.
        userFlags: environmentFlags
    };
}

function buildReport() {
    const banner = document.querySelector(STICKY_SELECTOR);
    const frame = largestFrame();

    let version = null;
    let product = null;
    try {
        const manifest = chrome.runtime.getManifest();
        version = manifest.version;
        // Расширение для игр или сборка Cleathernet: версии у них пока общие.
        product = manifest.name;
    } catch (e) {
        /* контекст расширения оборван — версия не критична */
    }

    return {
        // Без версии не отличить «баг не исправлен» от «расширение не
        // перезагружено после обновления».
        version,
        product,
        url: location.href,
        blockedOnPage: pageBlocked,
        settings,
        // Выключено кнопкой «на этом сайте» (сборка Cleathernet).
        siteOff: siteIsOff(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        // Пусто — значит sdk-hook.js не попал во фрейм игры и реклама
        // через SDK идёт мимо заглушки.
        sdkEvents,
        // Какие сообщения платформа слала во фрейм игры и когда (секунды
        // журнала). Отсюда видно, стояла ли игра на паузе по команде платформы.
        frameMessages,
        // История: смена вкладки, закрытие рекламы, возврат фокуса. Время —
        // секунды от загрузки страницы; uptime — когда снят сам отчёт.
        uptime: Math.round((Date.now() - journalStart) / 100) / 10,
        journal,
        tabHidden: document.hidden,
        environment: collectEnvironment(),
        // Сколько стоили наши проходы с загрузки страницы, миллисекунды.
        cost: {
            scans: activityTotal.scans,
            totalMs: Math.round(activityTotal.scanMs),
            avgMs: activityTotal.scans ? Math.round(activityTotal.scanMs / activityTotal.scans * 100) / 100 : 0,
            maxMs: Math.round(activityTotal.maxScanMs * 10) / 10
        },
        refocusPending,
        banner: describe(banner),
        bannerChain: ancestorChain(banner, 5).map(describe),
        gameFrame: describe(frame),
        gameFrameChain: ancestorChain(frame, 5).map(describe),
        // Соседи обёртки — там обычно и лежит боковой рекламный блок.
        frameSiblings: frame && frame.parentElement && frame.parentElement.parentElement
            ? Array.from(frame.parentElement.parentElement.children).map(describe)
            : [],
        suspects: collectSuspects(),
        modals: collectModals(),
        atCenter: collectAtCenter(),
        // Покрыт ли origin фрейма игры в manifest. Пустой sdkEvents при
        // sdkHookInFrame: false означает, что include_globs промахнулись
        // и реклама через SDK идёт мимо заглушки.
        sdkHookInFrame: sdkEvents.some(event => event.kind === 'sdk-hook-loaded' && event.detail === 'iframe'),
        activeElement: document.activeElement ? {
            tag: document.activeElement.tagName,
            id: document.activeElement.id || null,
            class: document.activeElement.getAttribute('class')
        } : null,
        bannerHTML: banner ? banner.outerHTML.slice(0, 1500) : null
    };
}
