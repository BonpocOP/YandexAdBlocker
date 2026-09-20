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
        // Ключевой флаг: false при живой рекламе на экране — значит,
        // промахнулся contentSelector.
        isModalShown: isModalShown(el, contentSelector),
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
        hidden: el.getAttribute(HIDDEN_ATTR) === '1',
        inlineStyle: el.getAttribute('style')
    };
}

function collectModals() {
    const selector = [FULLSCREEN_MODAL_SELECTOR, PROMO_INTERSTITIAL_SELECTOR].join(', ');
    return Array.from(document.querySelectorAll(selector)).slice(0, 12).map(describeModal);
}

function buildReport() {
    const banner = document.querySelector(STICKY_SELECTOR);
    const frame = largestFrame();

    return {
        url: location.href,
        blockedOnPage: pageBlocked,
        settings,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        // Пусто — значит sdk-hook.js не попал во фрейм игры и реклама
        // через SDK идёт мимо заглушки.
        sdkEvents,
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
