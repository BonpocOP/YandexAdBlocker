'use strict';

// Всё, что расширение показывает игроку, и возврат фокуса в игру.
//
// Плашка — для рекламы, которая пропускается мгновенно; карточка с отсчётом —
// для рекламы за награду, где приходится ждать.

/* ---------- фокус и индикация ---------- */

// Пока модал висит поверх игры, фокус держит он: у платформы это
// focus-trap, отсюда и класс adv-focusable. Платформа возвращает фокус
// игре сама, когда закрывает рекламу своим путём; мы этот путь обходим,
// поэтому после закрытия фрейм остаётся без фокуса — игра видна, но не
// реагирует на клавиатуру.
//
// Во вкладке в фоне фокус не переносится. Реклама, всплывшая, пока игрок
// был на другой вкладке, закрывалась там же, фокус с её кнопки снимался, а во
// фрейм не попадал — при возврате клавиши уходили в body. На экране при этом
// пусто: плашка успевала погаснуть ещё в фоне. Поэтому возврат откладываем
// до появления вкладки.
let refocusPending = false;

function refocusGame() {
    const frame = document.querySelector('iframe#game-frame') || largestFrame();
    if (!frame) {
        return;
    }
    if (document.hidden) {
        refocusPending = true;
        note('refocus-deferred', focusLabel());
        return;
    }
    refocusPending = false;
    const before = focusLabel();
    try {
        // Сначала снимаем фокус с того, что его перехватило: иначе
        // focus-trap модала вернёт его себе.
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
        frame.focus({ preventScroll: true });
        // Фрейм кросс-доменный, но focus() — один из немногих методов,
        // разрешённых через границу origin. Без него фокус останется на
        // элементе <iframe>, а не внутри документа игры.
        if (frame.contentWindow) {
            frame.contentWindow.focus();
        }
    } catch (e) {
        /* фокус не критичен — молча пропускаем */
    }
    note('refocus', { before, after: focusLabel() });
}

// Игрок вернулся во вкладку. Фокус отдаём игре, если он ей и причитается:
// висит отложенный возврат или фокус никому не принадлежит (body). Если он
// стоит на чём-то своём — меню, поле ввода, сам фрейм, — не трогаем.
function restoreGameFocus() {
    if (document.hidden || !isTopGamePage() || !isGameAppPage()) {
        return;
    }
    const active = document.activeElement;
    const idle = !active || active === document.body || active === document.documentElement;
    if (refocusPending || idle) {
        refocusGame();
    }
}

/* ---------- плашка-индикатор ---------- */

// Полноэкранная реклама пропускается за доли секунды, и без индикации
// выглядит это как мигание непонятно чего. Большой оверлей с карточкой
// тут не годится — он сам мелькнёт и помешает. Поэтому маленькая плашка в
// углу: видно, что произошло, и видно счётчик, если закрытие затянулось.
let toast = null;
let toastTimer = null;

// Наш интерфейс на странице — плашка и карточка награды — живёт в закрытом
// shadow DOM. Раньше это были узлы с классами ygab-*, а стили лежали в
// blocker.css: и то и другое находилось одним querySelector. Теперь снаружи
// виден только безымянный div, а внутрь скрипты страницы не заглянут.
//
// pointer-events: none на плашке обязателен — она висит поверх игры и не
// должна перехватывать ни клики, ни фокус. У карточки награды фон тоже
// пропускает клики: под ним пауза игры, перехватывать нечего.
const UI_CSS = `
.t {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
    padding: 8px 14px; background: rgba(23, 23, 26, 0.92);
    border: 1px solid #2e2e34; border-radius: 10px; color: #f2f2f4;
    font: 400 13px/1.3 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    font-variant-numeric: tabular-nums; pointer-events: none; user-select: none;
}
.o {
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    background: rgba(12, 12, 14, 0.82);
    font: 400 14px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    pointer-events: none;
}
.c {
    min-width: 240px; padding: 24px 32px; background: #17171a;
    border: 1px solid #2e2e34; border-radius: 16px; color: #f2f2f4;
    text-align: center; pointer-events: auto;
}
.h { font-size: 15px; font-weight: 600; }
.n {
    margin: 12px 0 4px; font-size: 56px; font-weight: 700; line-height: 1;
    color: #ffcc00; font-variant-numeric: tabular-nums;
}
.s { color: #9a9aa4; font-size: 12px; }
.b {
    margin-top: 16px; padding: 6px 12px; background: transparent; color: #9a9aa4;
    border: 1px solid #2e2e34; border-radius: 8px; font-size: 12px;
    font-family: inherit; cursor: pointer;
}
.b:hover { color: #f2f2f4; }
`;

// Хост с закрытым теневым деревом. Сам хост нулевого размера и не ловит
// события; видимое — внутри, с position: fixed относительно окна.
function createShadowHost() {
    const host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.append(style);
    return { host, shadow };
}

function showToast(text) {
    if (!toast) {
        const { host, shadow } = createShadowHost();
        const node = document.createElement('div');
        node.className = 't';
        shadow.append(node);
        document.body.append(host);
        toast = { host, node };
    }
    toast.node.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = null;
    return toast;
}

// Плашка живёт ещё пару секунд после закрытия: иначе при быстрой рекламе
// игрок не успеет её прочитать.
function fadeToast(text) {
    if (text) {
        showToast(text);
    }
    if (!toast) {
        return;
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(removeToast, 2000);
}

function removeToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    if (toast) {
        toast.host.remove();
        toast = null;
    }
}

/* ---------- оверлей с таймером ---------- */

let overlay = null;

function buildOverlay(onReveal) {
    // Собираем через createElement, а не innerHTML: на странице включены
    // Trusted Types, и строковая разметка может быть отклонена.
    const { host, shadow } = createShadowHost();

    const root = document.createElement('div');
    root.className = 'o';

    const card = document.createElement('div');
    card.className = 'c';

    const title = document.createElement('div');
    title.className = 'h';
    title.textContent = 'Реклама за награду скрыта';

    const timer = document.createElement('div');
    timer.className = 'n';
    timer.textContent = '—';

    const hint = document.createElement('div');
    hint.className = 's';
    hint.textContent = 'Награда придёт автоматически';

    const reveal = document.createElement('button');
    reveal.className = 'b';
    reveal.type = 'button';
    reveal.textContent = 'Показать рекламу';
    reveal.addEventListener('click', onReveal);

    card.append(title, timer, hint, reveal);
    root.append(card);
    shadow.append(root);
    document.body.append(host);

    return { root: host, timer, hint };
}

function removeOverlay() {
    if (overlay) {
        overlay.root.remove();
        overlay = null;
    }
}
