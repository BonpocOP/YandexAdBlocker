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
    activity.forces += 1;
}

function restoreEntry({ el, prop, prev, priority }) {
    if (prev) {
        el.style.setProperty(prop, prev, priority);
    } else {
        el.style.removeProperty(prop);
    }
}

function restoreStyles() {
    while (touched.length) {
        restoreEntry(touched.pop());
    }
}

// Вернуть исходные стили одного узла, не трогая остальные правки. Идём с
// конца: при нескольких правках одного свойства последней восстановится
// самая ранняя, то есть исходная.
function restoreStylesOf(el) {
    for (let i = touched.length - 1; i >= 0; i -= 1) {
        if (touched[i].el === el) {
            restoreEntry(touched.splice(i, 1)[0]);
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
    if (!el) {
        return false;
    }
    // Узел уже спрятан, но страница могла переписать ему стиль целиком —
    // тогда реклама вернулась бы до перезагрузки. Раньше её держало ещё и
    // CSS-правило по атрибуту-метке; метки больше нет, поэтому стиль
    // восстанавливаем здесь, на каждом проходе.
    if (hiddenNodes.has(el)) {
        if (el.style.getPropertyValue('display') !== 'none' || el.style.getPropertyPriority('display') !== 'important') {
            el.style.setProperty('display', 'none', 'important');
        }
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

    hiddenNodes.add(el);
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
    hiddenNodes.forEach(el => {
        el.style.removeProperty('display');
    });
    hiddenNodes.clear();
}
