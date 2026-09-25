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
        hidden: el.getAttribute(HIDDEN_ATTR) === '1',
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
        // История: смена вкладки, закрытие рекламы, возврат фокуса. Время —
        // секунды от загрузки страницы; uptime — когда снят сам отчёт.
        uptime: Math.round((Date.now() - journalStart) / 100) / 10,
        journal,
        tabHidden: document.hidden,
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
