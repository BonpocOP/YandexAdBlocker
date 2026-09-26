'use strict';

// Состояние работы и связь с расширением.
//
// Здесь же обработка обрыва контекста: после перезагрузки расширения на уже
// открытых вкладках остаётся жить старая копия скрипта, и любое обращение к
// chrome.* из неё бросает исключение.

let settings = { ...DEFAULTS };
let noStretchGames = [];
let offSites = [];

// Хост вкладки, а не фрейма: выключили расширение на yandex.ru — оно
// выключено и во фреймах игры на других доменах.
function topHostname() {
    try {
        if (window.top === window) {
            return location.hostname;
        }
        const origins = location.ancestorOrigins;
        if (origins && origins.length) {
            return new URL(origins[origins.length - 1]).hostname;
        }
    } catch (e) {
        /* нет доступа — остаётся хост фрейма */
    }
    return location.hostname;
}

// Выключили на yandex.ru — выключено и на www.yandex.ru.
function siteIsOff() {
    const host = topHostname();
    return offSites.some(site => host === site || host.endsWith('.' + site));
}

// Работаем ли мы на этой странице: общий выключатель и выключение на сайте.
function isActive() {
    return settings.enabled !== false && !siteIsOff();
}
let observer = null;
let shellObserver = null;
let frameResizeObserver = null;
let modalObserver = null;

// Счётчики нашей активности — для отчёта. После пробуждения вкладки игра
// тормозила и рвала звук, а без расширения — нет. Чтобы понять, не мы ли
// грузим страницу, считаем свои проходы, записи стилей, resize и изменения
// размера фрейма игры и пишем их в журнал посекундно после возврата.
const activity = { scans: 0, scanMs: 0, forces: 0, kicks: 0, shellMutations: 0, frameResizes: 0 };

// То же нарастающим итогом с загрузки страницы — для бюджета скорости в
// тестах и для отчёта.
const activityTotal = { scans: 0, scanMs: 0, maxScanMs: 0 };

function resetActivity() {
    for (const key of Object.keys(activity)) {
        activity[key] = 0;
    }
}

function activitySnapshot() {
    return { ...activity, scanMs: Math.round(activity.scanMs) };
}
let scanTimer = null;
let pageBlocked = 0;
let pendingTotal = 0;
let flushTimer = null;
let lastBannerParent = null;
let suppressCount = false;

// Каждая правка инлайн-стиля запоминается, чтобы тумблер «выключить»
// возвращал страницу в исходное состояние без перезагрузки.
const touched = [];

// Журнал последних событий для отчёта. Отчёт снимают уже после того, как всё
// случилось, и по снимку разметки не видно, что было минутой раньше: была ли
// реклама, чем кончилось её закрытие, куда ушёл фокус при смене вкладки.
const JOURNAL_LIMIT = 120;
const journal = [];
const journalStart = Date.now();

function note(kind, detail) {
    journal.push({
        // Секунды от загрузки страницы, с десятыми.
        t: Math.round((Date.now() - journalStart) / 100) / 10,
        kind,
        detail: detail === undefined ? null : detail
    });
    if (journal.length > JOURNAL_LIMIT) {
        journal.shift();
    }
}

// Куда сейчас идут нажатия клавиш — коротко, для журнала.
function focusLabel() {
    const el = document.activeElement;
    if (!el) {
        return null;
    }
    const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\s+/)[0]
        : '';
    return el.tagName + (el.id ? '#' + el.id : '') + cls;
}

// Диагностические сообщения от sdk-hook.js, в том числе из фрейма игры.
// Слушателя ставим синхронно, до чтения настроек: хук рапортует о загрузке
// сразу на document_start.
const sdkEvents = [];
// Сводка сообщений платформы во фрейм игры (см. sdk-hook.js). Время
// переводим в секунды журнала, чтобы сводка читалась на одной шкале с ним.
let frameMessages = null;

const journalTime = ms => Math.round((ms - journalStart) / 100) / 10;

// Событие хука — JSON-строка: объект из MAIN world через границу миров не
// проходит, строка проходит. Приходит двумя путями: из хука на этой же
// странице — событием EV_DIAG, из фрейма игры — через frame.js и фоновый
// скрипт (см. main.js).
// Какие события хука бывают. Всё остальное — не от него: отбрасываем.
const HOOK_EVENT_KINDS = ['sdk-hook-loaded', 'sdk-patched', 'sdk-call', 'frame-messages'];
const HOOK_EVENT_MAX = 16000;

function handleHookEvent(raw) {
    if (typeof raw !== 'string' || raw.length > HOOK_EVENT_MAX) {
        return;
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return;
    }
    if (!data || typeof data !== 'object' || !HOOK_EVENT_KINDS.includes(data.kind)) {
        return;
    }
    if (typeof data.href !== 'string' || typeof data.at !== 'number') {
        return;
    }
    if (data.kind === 'frame-messages' && data.detail && typeof data.detail === 'object') {
        frameMessages = {};
        for (const [type, entry] of Object.entries(data.detail)) {
            frameMessages[type] = { count: entry.count, first: journalTime(entry.first), last: journalTime(entry.last) };
        }
        return;
    }
    if (sdkEvents.length < 30) {
        sdkEvents.push({ t: journalTime(data.at || Date.now()), kind: data.kind, detail: data.detail, href: data.href });
    }
    // Вызов рекламы игрой — в общий журнал, чтобы видеть его рядом со сменой
    // вкладки и закрытием окон платформы.
    if (data.kind === 'sdk-call') {
        note('sdk-call', data.detail);
    }
}

// Отчёт собирается в верхнем документе. Во фреймах игр на games.s3 этот же
// скрипт тоже работает, но их хук отчитывается через frame.js — здесь его
// не слушаем, чтобы не считать события дважды.
//
// Пароль: хук кладёт его в каждое событие, первое событие приходит до
// запуска скриптов страницы. Запоминаем пароль из него и дальше принимаем
// только события с ним — подделку от страницы отбрасываем.
let hookToken = null;
function acceptFromHook(raw) {
    if (typeof raw !== 'string' || raw.length > HOOK_EVENT_MAX) {
        return;
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return;
    }
    if (!data || typeof data.k !== 'string') {
        return;
    }
    if (hookToken === null) {
        if (data.kind !== 'sdk-hook-loaded') {
            return;
        }
        hookToken = data.k;
    } else if (data.k !== hookToken) {
        return;
    }
    delete data.k;
    handleHookEvent(JSON.stringify(data));
}
if (window.top === window) {
    document.addEventListener(EV_DIAG, event => acceptFromHook(event.detail));
}

// Флажки из попапа «что ещё включено» — для отчёта. Кэш: отчёт собирается
// синхронно, а хранилище асинхронное.
let environmentFlags = {};
try {
    chrome.storage.local.get({ environmentFlags: {} }, stored => {
        environmentFlags = stored.environmentFlags || {};
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.environmentFlags) {
            environmentFlags = changes.environmentFlags.newValue || {};
        }
    });
} catch (e) {
    /* контекст оборван — флажки не критичны */
}

// Узлы, которые мы спрятали. Раньше они помечались атрибутом
// data-ygab-hidden — его видно в разметке любому скрипту страницы.
const hiddenNodes = new Set();


/* ---------- осиротевший скрипт ---------- */

// Когда расширение перезагружают в chrome://extensions, на уже открытых
// вкладках остаётся работать старая копия content-script — с живыми
// таймерами и наблюдателями, но с оборванным мостом в расширение. Первое
// же обращение к chrome.* бросает «Extension context invalidated», и
// ошибка всплывает в списке расширений как поломка, хотя лечится
// перезагрузкой вкладки.
//
// chrome.runtime.id у осиротевшей копии исчезает — по нему и проверяем.
// Само обращение к chrome.runtime тоже может бросить, поэтому в try.
function extensionAlive() {
    try {
        return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
        return false;
    }
}

// Мост оборван — дальше работать бессмысленно: настройки не прочитать,
// статистику не записать, попапу не ответить. Сворачиваемся тихо, не
// трогая страницу: уже скрытая реклама пусть остаётся скрытой, а не
// возвращается игроку на глаза посреди партии.
let orphaned = false;
function shutdownOrphan() {
    if (orphaned) {
        return;
    }
    orphaned = true;

    clearTimeout(flushTimer);
    flushTimer = null;
    clearTimeout(scanTimer);
    scanTimer = null;
    stopObserver();
    stopDismissing();
}

// Обёртка над вызовами расширения: вместо исключения — тихое сворачивание.
function callExtension(fn) {
    if (orphaned || !extensionAlive()) {
        shutdownOrphan();
        return false;
    }
    try {
        fn();
        return true;
    } catch (e) {
        // Контекст мог оборваться между проверкой и вызовом.
        shutdownOrphan();
        return false;
    }
}

function scheduleTotalFlush() {
    if (flushTimer || orphaned || !chrome.storage) {
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
        callExtension(() => {
            chrome.storage.local.get({ totalBlocked: 0 }, ({ totalBlocked }) => {
                // Колбэк приходит позже — к этому моменту контекст мог
                // оборваться, поэтому проверяем ещё раз уже внутри.
                callExtension(() => {
                    chrome.storage.local.set({
                        totalBlocked: (Number(totalBlocked) || 0) + increment
                    });
                });
            });
        });
    }, 300);
}
