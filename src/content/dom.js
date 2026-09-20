'use strict';

// Работа с деревом страницы: измерения, обратимая правка стилей, скрытие.
//
// Каждая правка инлайн-стиля запоминается, чтобы выключенный тумблер возвращал
// страницу в исходный вид без перезагрузки.

/* ---------- утилиты ---------- */

const isTopGamePage = () => location.pathname.startsWith('/games') && window.top === window.self;
const isGameAppPage = () => location.pathname.startsWith('/games/app');

// Адрес игры — /games/app/<slug>-<id>. Числовой хвост и есть идентификатор:
// slug Яндекс меняет вместе с названием, а id остаётся.
function gameId() {
    const match = location.pathname.match(/\/games\/app\/(?:.*-)?(\d+)/);
    if (match) {
        return match[1];
    }
    const fallback = location.pathname.match(/\/games\/app\/([^/?#]+)/);
    return fallback ? fallback[1] : null;
}

// Растягивать ли фрейм по ширине. Высота растягивается всегда: место из-под
// нижнего баннера игре нужно отдать в любом случае.
function widthStretchAllowed() {
    const id = gameId();
    return !id || !noStretchGames.includes(id);
}

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

// Самый внешний узел, который всё ещё подходит под зацепку.
//
// Скрывать внутренности бесполезно: место в разметке держит обёртка, она же
// перехватывает клики. Раньше этот подъём был скопирован в трёх проходах —
// боковой баннер, всплывашка «Обменяйте яны», интерстишл с промо.
function outermost(el, selector) {
    let node = el;
    let parent = node.parentElement;
    while (parent && parent.matches && parent.matches(selector)) {
        node = parent;
        parent = node.parentElement;
    }
    return node;
}

/* ---------- скрытие ---------- */

function hide(el, options = {}) {
    if (!el || el.getAttribute(HIDDEN_ATTR) === '1') {
        return false;
    }

    // Кнопки — это интерфейс, а не реклама: широкий селектор однажды уже
    // прибил «Отключить рекламу» по одному лишь совпадению в data-testid.
    // Снять предохранитель можно только адресно, флагом allowButtons.
    if (!options.allowButtons && (el.tagName === 'BUTTON' || el.closest('button'))) {
        return false;
    }

    if (el.matches(BAIT_SELECTOR)) {
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
