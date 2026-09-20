'use strict';

// Состояние работы и связь с расширением.
//
// Здесь же обработка обрыва контекста: после перезагрузки расширения на уже
// открытых вкладках остаётся жить старая копия скрипта, и любое обращение к
// chrome.* из неё бросает исключение.

let settings = { ...DEFAULTS };
let noStretchGames = [];
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

// Диагностические сообщения от sdk-hook.js, в том числе из фрейма игры.
// Слушателя ставим синхронно, до чтения настроек: хук рапортует о загрузке
// сразу на document_start.
const sdkEvents = [];
window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.__ygab !== 'string') {
        return;
    }
    if (sdkEvents.length < 30) {
        sdkEvents.push({ kind: data.__ygab, detail: data.detail, href: data.href });
    }
});


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
