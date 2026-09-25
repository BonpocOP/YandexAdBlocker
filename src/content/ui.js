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

function showToast(text) {
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'ygab-toast';
        document.body.append(toast);
    }
    toast.textContent = text;
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
        toast.remove();
        toast = null;
    }
}

/* ---------- оверлей с таймером ---------- */

let overlay = null;

function buildOverlay(onReveal) {
    // Собираем через createElement, а не innerHTML: на странице включены
    // Trusted Types, и строковая разметка может быть отклонена.
    const root = document.createElement('div');
    root.className = 'ygab-overlay';

    const card = document.createElement('div');
    card.className = 'ygab-overlay__card';

    const title = document.createElement('div');
    title.className = 'ygab-overlay__title';
    title.textContent = 'Реклама за награду скрыта';

    const timer = document.createElement('div');
    timer.className = 'ygab-overlay__timer';
    timer.textContent = '—';

    const hint = document.createElement('div');
    hint.className = 'ygab-overlay__hint';
    hint.textContent = 'Награда придёт автоматически';

    const reveal = document.createElement('button');
    reveal.className = 'ygab-overlay__reveal';
    reveal.type = 'button';
    reveal.textContent = 'Показать рекламу';
    reveal.addEventListener('click', onReveal);

    card.append(title, timer, hint, reveal);
    root.append(card);
    document.body.append(root);

    return { root, timer, hint };
}

function removeOverlay() {
    if (overlay) {
        overlay.root.remove();
        overlay = null;
    }
}
