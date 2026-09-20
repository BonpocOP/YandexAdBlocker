'use strict';

// Геометрия: снятие зарезервированного под рекламу места, растягивание фрейма
// игры, центрирование и пересчёт размера.
//
// Опора на измерения, а не на имена классов: обёртки у Яндекса хешированные и
// меняются от сборки к сборке, а размеры — нет.

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
    if (height < MIN_BANNER_HEIGHT) {
        return;
    }

    let computed;
    try {
        computed = getComputedStyle(el);
    } catch (e) {
        return;
    }
    for (const name of computed) {
        if (!name.startsWith('--') || !CUSTOM_PROP_RE.test(name.slice(2))) {
            continue;
        }
        const value = pxOf(computed.getPropertyValue(name));
        // Нулевую переменную обнулять незачем — только мусорим в разметке.
        if (value && near(value, height)) {
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
    // Когда игрок отключил растягивание по ширине, резерв под боковой блок
    // не трогаем: пусть страница сама решает ширину, а обёртку по центру
    // поставит правило из blocker.css.
    const props = widthStretchAllowed()
        ? ['width', 'height', 'max-width', 'max-height']
        : ['height', 'max-height'];
    const shell = [frame].concat(ancestorChain(frame, 4));
    for (const el of shell) {
        for (const prop of props) {
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

// Растягивание по ширине выключено: игра остаётся своей ширины, а
// освободившееся из-под колонки место надо разделить поровну.
//
// Одного margin: auto из blocker.css мало. По скриншотам видно, что
// обёртка прижимается к краю: при выключенном растягивании игра стоит
// вплотную слева, а вся пустота собирается справа. Авто-поля не работают,
// если страница позиционирует обёртку абсолютно или растягивает её как
// элемент флекса. Поэтому зазор считается и ставится числом.
function centerGameShell() {
    const frame = gameFrame();
    const wrapper = frame && frame.parentElement;
    const parent = wrapper && wrapper.parentElement;
    if (!parent) {
        return;
    }

    const wrapperRect = wrapper.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const free = parentRect.width - wrapperRect.width;
    // Делить нечего: обёртка и так во всю ширину родителя.
    if (free < 8) {
        return;
    }

    const half = Math.round(free / 2);
    // Уже по центру — выходим, не плодя записей в истории правок и не
    // устраивая перепалку со скриптом страницы.
    if (near(wrapperRect.left - parentRect.left, half, 4)) {
        return;
    }

    let computed;
    try {
        computed = getComputedStyle(wrapper);
    } catch (e) {
        return;
    }

    // У абсолютно спозиционированной обёртки поля игнорируются — двигаем
    // её тем же свойством, которым её держит страница.
    if (computed.position === 'absolute' || computed.position === 'fixed') {
        force(wrapper, 'left', half + 'px');
        force(wrapper, 'right', 'auto');
    } else {
        force(wrapper, 'margin-left', half + 'px');
        force(wrapper, 'margin-right', half + 'px');
    }
}

// Игра внутри фрейма считает размер канваса, когда загрузится, — а это
// заметно позже, чем отрабатывает расширение. Если к тому моменту она уже
// сняла мерку со старого размера, ни один наш пересчёт до неё не дошёл.
// Поэтому пинаем resize ещё раз по событию load фрейма и потом с
// задержкой: движки досчитывают геометрию асинхронно.
let lateKicksArmed = false;
function armLateKicks() {
    const frame = gameFrame();
    if (!frame || lateKicksArmed) {
        return;
    }
    lateKicksArmed = true;

    const kick = () => {
        fixGameShell();
        if (!widthStretchAllowed()) {
            centerGameShell();
        }
        kickResize();
    };
    frame.addEventListener('load', () => {
        kick();
        setTimeout(kick, 800);
    }, { once: true });
    setTimeout(kick, 1500);
    setTimeout(kick, 3500);
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
