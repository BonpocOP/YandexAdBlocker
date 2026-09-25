// Собрано dev/build.mjs из src/content/*.js — не править руками.
// Правки — в исходниках, затем `node dev/build.mjs`.
(() => {
'use strict';

// ===== src/content/config.js =====

// Настройки по умолчанию, имена атрибутов и все зацепки за разметку Яндекса.
//
// Зацепки держим в одном месте намеренно: они живут ровно столько, сколько
// Яндекс не трогает вёрстку, и правятся чаще всего остального кода. По отчёту
// из попапа правится этот файл, а не поиск по всему проекту.

const DEFAULTS = {
    enabled: true,
    sticky: true,
    fullscreen: true,
    rewarded: true,
    catalog: true
};

// Модал, который игрок вернул кнопкой «Показать рекламу».
const REVEALED_ATTR = 'data-ygab-revealed';

// Каналы связи с хуком SDK в MAIN world (sdk-hook.js, frame.js) — события на
// document. Раньше настройки лежали атрибутом на <html>, а диагностика
// рассылалась postMessage на '*': и то и другое видно странице без всяких
// усилий. Событие видно только тому, кто заранее знает его имя, поэтому имена
// ничего не говорят. Менять — синхронно во всех трёх файлах.
const EV_CFG = 'hx7pfq';
const EV_ASK = 'hx7pfr';
const EV_DIAG = 'kt3wmz';

// Sticky-баннер внутри запущенной игры. Совпадение по подстроке, а не по
// полному классу: Яндекс регулярно меняет модификаторы вроде
// yandex-sticky-adv-banner__desktop-wrapper_with-disable-ad-button.
const STICKY_SELECTORS = [
    '[class*="sticky-adv-banner"]',
    '[class*="yandex-sticky-adv"]',
    '[class*="adv-banner"]',
    '[class*="AdvBanner"]',
    // Боковая рекламная колонка 315px справа от игры: id вида
    // yandex-<hash>-desktop плюс класс adv-focusable.
    'div.adv-focusable[id^="yandex-"]',
    'iframe[src*="an.yandex.ru"]',
    'iframe[src*="yabs.yandex"]',
    'iframe[src*="adfox"]'
];
const STICKY_SELECTOR = STICKY_SELECTORS.join(', ');

// Рекламные вставки в каталоге игр и общие контейнеры рекламной сети.
const CATALOG_SELECTORS = [
    '[id^="adfox_"]',
    '[id*="yandex_rtb"]',
    '[class*="AdvCard"]',
    '[class*="adv-card"]',
    '[class*="promo-banner"]',
    'ins.adsbygoogle'
];

// Полноэкранный модал, который платформа показывает поверх игры сама, без
// участия игрового SDK. Хешированные классы вида play-yandex-wCRrBuz4aqZ...
// не используем — они меняются от сборки к сборке.
const FULLSCREEN_MODAL_SELECTORS = [
    '.play-modal.adv-focusable',
    '[class*="play-modal_fullscreen"]',
    '[class*="modal"][class*="adv-focusable"]'
];
const FULLSCREEN_MODAL_SELECTOR = FULLSCREEN_MODAL_SELECTORS.join(', ');

// Интерстишл платформы: во весь экран, с блюром и паузой игры, но внутри
// не реклама сети, а собственное промо Яндекса — «Одно приложение вместо
// тысячи», «50+ топ-игр».
//
// Класс именно `prowo-container`, через «w». Это не опечатка в коде:
// платформа так пишет его в разметке, чтобы слот не ловился на слово
// «promo» в фильтрах блокировщиков. Вариант с обычным написанием оставлен
// на случай, если его вернут, но с обязательным `advType` — иначе под
// раздачу попадёт любой промо-контейнер каталога.
const PROMO_INTERSTITIAL_SELECTORS = [
    '[class*="prowo-container"]',
    '[class*="promo-container_advType"]'
];
const PROMO_INTERSTITIAL_SELECTOR = PROMO_INTERSTITIAL_SELECTORS.join(', ');

// Содержимое интерстишла. Проверка та же по смыслу, что и для рекламного
// модала: платформа держит контейнер смонтированным и пустым между
// показами, и без этого условия расширение считало бы показ там, где его
// нет. Только искать надо не iframe рекламы, а слайд промо — своё промо
// Яндекс рисует прямо в документе.
const PROMO_CONTENT_SELECTOR = '[class*="promo-slide"], iframe, video';

// Кнопка закрытия интерстишла. Отдельный список: расширять общий нельзя,
// в рекламном модале широкое совпадение нажмёт не то. Ссылки исключены
// отдельно в findCloseButton — внутри слайда лежит «Играть на сайте»
// с target="_blank", и клик по ней открыл бы вкладку.
const PROMO_CLOSE_SELECTOR = [
    'button[aria-label="Закрыть"]',
    'button[data-testid*="close"]',
    'button[class*="close-button"]',
    'button[class*="closeButton"]'
].join(', ');

// Кнопку закрытия ищем по testid и по типу — они переживают рефакторинг
// разметки, в отличие от классов-хешей.
const CLOSE_BUTTON_SELECTOR = [
    '[data-testid="yandex-fullscreen-render-button"]',
    '[data-testid*="fullscreen-render-button"]',
    '[class*="close-button_type_adv"]',
    'button[aria-label="Закрыть"]'
].join(', ');

// Признаки, по которым модал считается рекламным. Без этой проверки под
// раздачу попадут обычные диалоги платформы — пауза, вход в аккаунт.
const ADV_MARKER_SELECTOR = '[id*="_R-A-"], [class*="adv"], [data-testid*="adv"], ' + CLOSE_BUTTON_SELECTOR;

// Строгие признаки рекламной оболочки — для модала, внутри которого пусто.
// Общий ADV_MARKER_SELECTOR тут не годится: adv-focusable — это focus-trap
// платформы, он стоит на любом её окне, и [class*="adv"] находит его у
// потомков меню игры. Пустое меню без фрейма выглядело «зависшей рекламой»
// и через пару секунд закрывалось само. Отличает оболочку рекламы её
// собственный крестик или блок РСЯ; «Закрыть» по aria-label есть у всех.
const AD_SHELL_MARKER_SELECTOR = [
    '[data-testid*="fullscreen-render-button"]',
    '[class*="close-button_type_adv"]',
    '[id*="_R-A-"]'
].join(', ');

const DISMISS_INTERVAL_MS = 250;
const DISMISS_ATTEMPTS = 32;

// Сколько модал должен простоять пустым, прежде чем считать его зависшей
// оболочкой. Между показами платформа тоже держит его пустым, и содержимое
// появляется не мгновенно, — выдержка отделяет одно от другого.
const STUCK_MODAL_MS = 2500;

// То же для интерстишла с промо. Выдержка короче: слайд Яндекс рисует прямо
// в документе, а не грузит рекламным фреймом, и ждать его долго незачем.
// Пустой интерстишл держит игру на паузе под блюром — каждая секунда тут на
// виду у игрока.
const STUCK_PROMO_MS = 1500;

// Сколько тиков даём платформе закрыть зависшую оболочку после клика по её
// крестику. Если крестика нет вовсе, оболочка убирается сразу: ни рекламы,
// ни кнопки не будет, и восемь секунд попыток только держали игру на паузе.
const STUCK_DISMISS_ATTEMPTS = 4;

// Редкий контрольный проход. Разметку расширение смотрит по мутациям, но
// мутаций может не быть вовсе: модал уже стоит в дереве и лишь меняет классы.
// Цена пропуска высока — зависшая игра, — поэтому перепроверяем по таймеру.
const HEARTBEAT_MS = 2000;

// Реклама за награду обычно разрешает закрытие с зачётом бонуса секунд
// через 15. Это запасной отсчёт — если удастся прочитать таймер самой
// рекламы, ориентируемся на него.
const REWARDED_MIN_WAIT_MS = 15000;
const REWARDED_MAX_WAIT_MS = 60000;

// Свойства, которыми страница резервирует место под баннер. Значение,
// совпавшее с высотой баннера, обнуляем.
const SIZE_PROPS = ['height', 'min-height', 'max-height', 'padding-bottom', 'margin-bottom', 'bottom'];

// Имя CSS-переменной разбираем по сегментам между дефисами. Подстроку
// искать нельзя: «ad» сидит внутри b-ad-ge, r-ad-ius, p-ad-ding, he-ad-er,
// и прошлая версия регулярки обнулила полтора десятка чужих переменных.
// Без «sticky»: так Яндекс зовёт и обычную шапку, из-за чего под нож попала
// переменная --sticky-header-wrap-bg-size, не имеющая к рекламе отношения.
const CUSTOM_PROP_RE = /(^|-)(adv|ads|advert|banner)(-|$)/i;

// Ниже этой высоты блок баннером не считаем: иначе под «резерв места»
// попадают нулевые и почти нулевые значения по всей странице.
const MIN_BANNER_HEIGHT = 20;

// Платформенная кнопка «Отключить рекламу» (предложение убрать рекламу за
// деньги). Скрываем вместе с её слотом в разметке, иначе на месте кнопки
// остаётся пустая полоса 315x32 в правом верхнем углу.
const DISABLE_ADV_SELECTORS = [
    '[data-testid="disable-adv-button-sticky"]',
    '[class*="disable-adv-button-sticky"]',
    '[class*="disableAdButtonContainer"]',
    '[class*="disableAdButtonSlot"]'
];
const DISABLE_ADV_SELECTOR = DISABLE_ADV_SELECTORS.join(', ');
const DISABLE_ADV_WRAPPER_SELECTOR = '[class*="disableAdButtonSlot"], [class*="disableAdButtonContainer"]';

// Всплывашка «Обменяйте яны на отключение рекламы». То же предложение, что
// и кнопка выше, только подсовывается поверх игры отдельным попапом.
//
// Цепляемся за корень: `no-ads-popup__popup` есть только на нём, у детей
// внутри имена вида `no-ads-popup__content`, `no-ads-popup__text`. Класс
// `popup-module__popup--mv7Tz` не годится — он хешированный и общий для
// всех попапов платформы, включая нерекламные.
const NO_ADS_POPUP_SELECTORS = [
    '[data-testid="no-ads-popup-popup"]',
    '[class*="no-ads-popup__popup"]'
];
const NO_ADS_POPUP_SELECTOR = NO_ADS_POPUP_SELECTORS.join(', ');
// Блок целиком, вместе с возможной обёрткой-якорем: у попапа те же классы
// по схеме БЭМ (`no-ads-popup`), а держать место может родитель.
const NO_ADS_POPUP_BLOCK_SELECTOR = '[class*="no-ads-popup"]';

// Приманка детектора блокировщиков: элемент 1x1 за краем экрана с
// «рекламными» именами. Если его скрыть, Яндекс решит, что включён
// адблок, и потребует его отключить. Не трогаем никогда.
const BAIT_SELECTOR = '#AdBanner, .AdsBox, [class*="ad_box"], [class*="ad_banner"], [class*="Ad_container"]';

// Растягивание по ширине выключается для отдельной игры, а не для всех
// сразу: одни игры пересчитывают канвас по новому размеру и занимают место
// целиком, другие держат свои пропорции и оказываются в рамке не по
// центру. Со стороны страницы это не отличить — канвас лежит в
// кросс-доменном фрейме, его геометрию не измерить. Поэтому решение за
// игроком, а расширение помнит его для каждой игры.
const NO_STRETCH_KEY = 'noStretchGames';

// ===== src/content/state.js =====

// Состояние работы и связь с расширением.
//
// Здесь же обработка обрыва контекста: после перезагрузки расширения на уже
// открытых вкладках остаётся жить старая копия скрипта, и любое обращение к
// chrome.* из неё бросает исключение.

let settings = { ...DEFAULTS };
let noStretchGames = [];
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
function handleHookEvent(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return;
    }
    if (!data || typeof data.kind !== 'string') {
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
if (window.top === window) {
    document.addEventListener(EV_DIAG, event => handleHookEvent(event.detail));
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

// ===== src/content/dom.js =====

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

// ===== src/content/layout.js =====

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
    activity.kicks += 1;
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
    shellObserver = new MutationObserver(records => {
        activity.shellMutations += records.length;
        scheduleScan();
    });
    // Каждое изменение размера фрейма игры — повод для игры заново выделить
    // холст. Пишем первые 20 разных размеров в журнал, остальные — счётчиком.
    if (typeof ResizeObserver === 'function') {
        let lastSize = '';
        let logged = 0;
        frameResizeObserver = new ResizeObserver(entries => {
            const rect = entries[0].contentRect;
            const size = Math.round(rect.width) + 'x' + Math.round(rect.height);
            if (size === lastSize) {
                return;
            }
            lastSize = size;
            activity.frameResizes += 1;
            if (logged < 20) {
                logged += 1;
                note('frame-resize', size);
            }
        });
        frameResizeObserver.observe(frame);
    }
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

// ===== src/content/ui.js =====

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

// ===== src/content/modals.js =====

// Распознавание и закрытие рекламных модалов.
//
// Модал гасится через opacity, а не display: при display: none рекламный плеер
// не досчитает показ, кнопка «Закрыть» не станет активной и игра останется на
// паузе за блюром.

/* ---------- полноэкранный модал ---------- */

// Состояние закрытия держим на самом узле: модал создаётся заново на
// каждый показ, WeakMap не мешает сборщику мусора его забрать.
const dismissing = new WeakMap();
// Отдельный список таймеров: WeakMap не обойти, а гасить их при выключении
// расширения нужно.
let dismissTimers = [];
// Наблюдатели за модалами, убранными силой, — см. holdUntilReused.
let reuseWatchers = [];

function stopDismissing() {
    dismissTimers.forEach(clearInterval);
    dismissTimers = [];
    reuseWatchers.forEach(watcher => watcher.disconnect());
    reuseWatchers = [];
    removeOverlay();
    removeToast();
}

// Признак реального показа рекламы: отрисованный фрейм, видео или блок РСЯ
// с id вида ..._R-A-19087429-35_2.
const AD_CONTENT_SELECTOR = 'iframe, video, [id*="_R-A-"]';

function isAdvModal(modal) {
    return modal.classList.contains('adv-focusable') || Boolean(modal.querySelector(ADV_MARKER_SELECTOR));
}

// Платформа держит модал смонтированным между показами — пустым, но во всю
// ширину экрана. Проверять только размер нельзя: из-за этого таймер
// всплывал при запуске игры, когда никакой рекламы ещё не было.
//
// Признак реального показа — отрисованное содержимое внутри: рекламный
// фрейм, видео или блок РСЯ с id вида ..._R-A-19087429-35_2.
// Модал занимает экран: он большой, он в поле зрения и он отрисован.
//
// Проверка попадания во вьюпорт обязательна. Платформа не удаляет
// неиспользуемые модалы, а отодвигает их за край экрана в полный размер — в
// отчёте они стоят на x = -10200. Без этой проверки припаркованный контейнер
// считался бы показом: расширение накручивало бы счётчик, а через восемь
// секунд убивало бы узел, который платформе ещё пригодится.
function isModalOnScreen(modal) {
    const rect = modal.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) {
        return false;
    }
    if (rect.right <= 0 || rect.bottom <= 0 ||
        rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
        return false;
    }

    let computed;
    try {
        computed = getComputedStyle(modal);
    } catch (e) {
        return false;
    }
    return computed.display !== 'none' && computed.visibility !== 'hidden';
}

// Внутри модала действительно что-то отрисовано: рекламный фрейм, видео,
// блок РСЯ с id вида ..._R-A-19087429-35_2 или слайд промо.
function hasRenderedContent(modal, contentSelector = AD_CONTENT_SELECTOR) {
    const content = modal.querySelector(contentSelector);
    if (!content) {
        return false;
    }
    const rect = content.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

// Идёт настоящий показ: модал на экране и внутри него что-то есть.
function isModalShown(modal, contentSelector = AD_CONTENT_SELECTOR) {
    return isModalOnScreen(modal) && hasRenderedContent(modal, contentSelector);
}

// Зависшая оболочка: модал занял экран, блюр наложен, игра на паузе — а внутри
// пусто. Так выглядит реклама, которая не догрузилась: игрок видит размытую
// игру и одинокий крестик посреди экрана.
//
// Раньше такой модал расширение обходило стороной: признаком показа считалось
// отрисованное содержимое. CSS при этом успевал погасить оболочку по
// :has(iframe), и получалось худшее из двух — рекламы не видно, а игра стоит.
//
// Сразу вмешиваться нельзя: между показами платформа держит модал пустым, и
// содержимое появляется не мгновенно. Поэтому ждём: пусто дольше выдержки —
// значит, не дождёмся.
const stuckSince = new WeakMap();

// Пустой модал ещё не значит рекламу: меню игры, пауза, вход в аккаунт —
// тоже модалы платформы с тем же adv-focusable и без фрейма внутри.
// Оболочкой рекламы считаем только тот, где есть её собственный след.
function isAdShell(modal) {
    return isRewardedModal(modal) || Boolean(modal.querySelector(AD_SHELL_MARKER_SELECTOR));
}

function isStuckModal(modal, contentSelector = AD_CONTENT_SELECTOR, threshold = STUCK_MODAL_MS) {
    if (!isModalOnScreen(modal) || hasRenderedContent(modal, contentSelector)) {
        stuckSince.delete(modal);
        return false;
    }

    const since = stuckSince.get(modal);
    if (!since) {
        stuckSince.set(modal, Date.now());
        note('stuck-wait', modalLabel(modal));
        // Проход ровно к концу выдержки. Без него решение ждало бы следующего
        // изменения страницы или контрольного прохода раз в 2 секунды — у
        // пустой оболочки без крестика это давало до 4 секунд вместо 1,5.
        setTimeout(scheduleScan, threshold + 50);
        return false;
    }
    return Date.now() - since >= threshold;
}

// Журнал состояний рекламных контейнеров для отчёта. Наши действия журнал
// видит и так, а что делала страница до них — нет. Из-за этого 15 секунд
// между возвратом во вкладку и закрытием промо в отчёте остались пустым
// местом. Пишем каждое изменение: размер, положение, видимость, есть ли
// содержимое и что лежит в центре экрана, — и включение «режима окна»
// платформы на body.
const lastModalState = new WeakMap();
let lastPlatformModal = null;

function centerLabel() {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (!el) {
        return null;
    }
    const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\s+/)[0]
        : '';
    return el.tagName + (el.id ? '#' + el.id : '') + cls;
}

function modalState(modal, contentSelector) {
    let style;
    try {
        style = getComputedStyle(modal);
    } catch (e) {
        return null;
    }
    const rect = modal.getBoundingClientRect();
    return {
        onScreen: isModalOnScreen(modal),
        content: hasRenderedContent(modal, contentSelector),
        size: Math.round(rect.width) + 'x' + Math.round(rect.height),
        at: Math.round(rect.left) + ',' + Math.round(rect.top),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity
    };
}

// Платформа показывает свои окна, меняя класс или стиль уже существующего
// узла, а не вставляя новый. Основной наблюдатель смотрит только на
// добавление узлов, и такое появление замечал лишь контрольный проход раз в
// 2 секунды. Поэтому за самими окнами следим по атрибутам.
// Сбрасывается вместе с наблюдателем в stopObserver: после смены настроек
// за окнами надо следить заново.
let watchedModals = new WeakSet();

function watchModal(modal) {
    if (watchedModals.has(modal)) {
        return;
    }
    if (!modalObserver) {
        modalObserver = new MutationObserver(scheduleScan);
    }
    watchedModals.add(modal);
    modalObserver.observe(modal, { attributes: true, attributeFilter: ['class', 'style'] });
}

function traceModalStates() {
    const platformModal = document.body.classList.contains('main-body_modal_yes');
    if (platformModal !== lastPlatformModal) {
        lastPlatformModal = platformModal;
        note('platform-modal', platformModal);
    }

    const candidates = [];
    document.querySelectorAll(FULLSCREEN_MODAL_SELECTOR).forEach(el => {
        candidates.push([el, AD_CONTENT_SELECTOR]);
    });
    document.querySelectorAll(PROMO_INTERSTITIAL_SELECTOR).forEach(el => {
        candidates.push([outermost(el, PROMO_INTERSTITIAL_SELECTOR), PROMO_CONTENT_SELECTOR]);
    });

    for (const [modal, contentSelector] of candidates) {
        watchModal(modal);
        const state = modalState(modal, contentSelector);
        if (!state) {
            continue;
        }
        const key = JSON.stringify(state);
        if (lastModalState.get(modal) === key) {
            continue;
        }
        const first = !lastModalState.has(modal);
        lastModalState.set(modal, key);
        // Припаркованные за краем экрана модалы есть всегда; первую встречу
        // с ними не пишем, иначе журнал забьётся. Их выход на экран — пишем.
        if (first && !state.onScreen) {
            continue;
        }
        note('modal-state', { modal: modalLabel(modal), ...state, center: centerLabel() });
    }
}

// Звук рекламы в скрытом модале продолжает играть. Для медиа в самом
// документе это лечится, для кросс-доменного iframe — нет.
function muteMedia(root) {
    root.querySelectorAll('video, audio').forEach(media => {
        media.muted = true;
        media.volume = 0;
    });
}

function findCloseButton(modal, selector = CLOSE_BUTTON_SELECTOR) {
    const buttons = modal.querySelectorAll(selector);
    for (const button of buttons) {
        // disabled-кнопку жать бесполезно: рекламный плеер включает её
        // сам, когда отсчитает свои секунды.
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
            continue;
        }
        // Ссылку не жмём никогда: клик по ней уводит со страницы или
        // открывает вкладку. В промо-слайде такая лежит рядом с крестиком
        // — «Играть на сайте» с target="_blank".
        if (button.tagName === 'A') {
            continue;
        }
        return button;
    }
    return null;
}

// Реклама за награду. Отличается от обычной тем, что ранний клик по
// «Закрыть» отменяет бонус, ради которого игрок её и запустил.
function isRewardedModal(modal) {
    return /rewarded/i.test(modal.getAttribute('class') || '');
}

// Модал для журнала: первый класс и отличительные модификаторы. Полный класс
// с хешами тут только мешает читать.
function modalLabel(modal) {
    const classes = (modal.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const kinds = classes.filter(name => /fullscreen|rewarded|prowo|promo/i.test(name)).slice(0, 2);
    return [classes[0]].concat(kinds).filter(Boolean).join(' ');
}

// Пытаемся прочитать таймер самой рекламы. Получится, только если отсчёт
// рисует платформа: внутри кросс-доменного iframe текст недоступен.
function readAdCountdown(modal) {
    const nodes = modal.querySelectorAll('div, span, button, p');
    for (const node of nodes) {
        const own = Array.from(node.childNodes)
            .filter(child => child.nodeType === Node.TEXT_NODE)
            .map(child => child.textContent)
            .join(' ')
            .trim();
        const match = own.match(/^(\d{1,2})\s*(?:с|сек|секунд[аы]?|s|sec)?\.?$/i);
        if (match) {
            const value = Number(match[1]);
            if (value <= 60) {
                return value;
            }
        }
    }
    return null;
}


/* ---------- закрытие модала ---------- */

// Одно закрытие описывается состоянием на самом узле: модал создаётся заново
// на каждый показ, и WeakMap не мешает сборщику мусора его забрать.
//
// Всё, что различается между обычной рекламой, рекламой за награду и промо
// платформы, складывается сюда же — дальше тики работают с одним состоянием и
// не разбираются, кого закрывают.
function beginDismiss(modal, options) {
    // У зависшей оболочки ждать нечего: рекламы нет, а значит, нет и награды.
    // Карточку с отсчётом показывать было бы враньём.
    const rewarded = !options.stuck && isRewardedModal(modal);
    const state = {
        attempts: 0,
        rewarded,
        startedAt: Date.now(),
        // Интерстишл с промо закрывается той же машинкой, что и реклама, но
        // смотрит на своё содержимое и на свою кнопку.
        contentSelector: options.contentSelector || AD_CONTENT_SELECTOR,
        closeSelector: options.closeSelector || CLOSE_BUTTON_SELECTOR,
        label: options.label || (rewarded ? 'Реклама за награду' : 'Реклама'),
        stuck: Boolean(options.stuck)
    };
    dismissing.set(modal, state);
    note('dismiss-start', { label: state.label, modal: modalLabel(modal), stuck: state.stuck, hidden: document.hidden });

    // Гасим визуально, но оставляем в потоке и в отрисовке: рекламный плеер
    // должен считать себя показанным, иначе кнопка закрытия не станет активной
    // и игра останется на паузе за блюром.
    force(modal, 'opacity', '0');
    force(modal, 'pointer-events', 'none');
    muteMedia(modal);

    pageBlocked += 1;
    pendingTotal += 1;
    scheduleTotalFlush();

    if (rewarded) {
        removeOverlay();
        overlay = buildOverlay(() => revealAd(modal, state));
    } else {
        showToast(state.label + ': закрываем…');
    }

    return state;
}

// Узел переиспользуется между показами, поэтому состояние обязательно
// снимаем: иначе следующая реклама в том же модале будет пропущена.
//
// Стили снимаем тоже. В том же узле платформа потом открывает свои окна —
// меню игры в том числе, — и оставленные opacity: 0 и pointer-events: none
// делали их невидимыми и прозрачными для кликов: кнопка меню «не работала».
function finishDismiss(modal, state) {
    clearInterval(state.timer);
    dismissing.delete(modal);
    removeOverlay();
    note('dismiss-end', {
        label: state.label,
        forced: Boolean(state.forced),
        clicks: state.clicks || 0,
        ms: Date.now() - state.startedAt,
        hidden: document.hidden
    });
    if (state.forced) {
        holdUntilReused(modal);
    } else {
        restoreStylesOf(modal);
    }
    fadeToast(state.forced
        ? state.label + ': убрана принудительно'
        : state.label + ' пропущена');
    // Фокус возвращаем в игру: без этого управление с клавиатуры после
    // закрытия рекламы не работает.
    refocusGame();
}

// Крестик не нашёлся за отведённые попытки. Игра может остаться на паузе, но
// экран будет свободен — это лучше, чем висеть под невидимым модалом.
function forceHideModal(modal, state) {
    force(modal, 'display', 'none');
    state.forced = true;
    finishDismiss(modal, state);
}

// Модал, убранный силой, держим скрытым, пока платформа его не тронет. Снять
// display: none сразу нельзя — оболочка вернётся на экран и снова встанет
// поверх игры. Оставить навсегда тоже нельзя: следующее окно в этом узле
// так и не покажется. Смена класса или содержимого — знак, что платформа
// пустила узел под новый показ: возвращаем стили и даём проходу решить
// заново, реклама там или нет.
//
// Смотрим только class и дерево, не style: display ставим мы сами.
function holdUntilReused(modal) {
    const watcher = new MutationObserver(() => {
        watcher.disconnect();
        reuseWatchers = reuseWatchers.filter(item => item !== watcher);
        note('hold-release', modalLabel(modal));
        restoreStylesOf(modal);
        scheduleScan();
    });
    watcher.observe(modal, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    reuseWatchers.push(watcher);
}

// Аварийный выход из рекламы за награду: если отсчёт врёт или награда не
// приходит, игрок возвращает рекламу и досматривает её сам.
function revealAd(modal, state) {
    note('reveal', state.label);
    modal.style.setProperty('opacity', '1', 'important');
    modal.style.setProperty('pointer-events', 'auto', 'important');
    modal.setAttribute(REVEALED_ATTR, '1');
    clearInterval(state.timer);
    dismissing.delete(modal);
    removeOverlay();

    // Метку снимаем, когда показ закончится: узел переиспользуется, и
    // следующую рекламу расширение снова должно скрыть.
    const watcher = setInterval(() => {
        if (!modal.isConnected || !isModalShown(modal)) {
            clearInterval(watcher);
            modal.removeAttribute(REVEALED_ATTR);
            // Возвращаем стили, какими они были до beginDismiss, и заодно
            // вычищаем его правки из журнала.
            restoreStylesOf(modal);
        }
    }, DISMISS_INTERVAL_MS);
    dismissTimers.push(watcher);
}

// Обычная реклама и промо платформы: жать «Закрыть», пока не сработает.
function tickPlainAd(modal, state, elapsed) {
    // Счётчик в плашке: если закрытие затянулось, по нему видно, что
    // расширение всё ещё работает, а не зависло.
    const waiting = Math.ceil(elapsed / 1000);
    showToast(waiting > 1
        ? state.label + ': закрываем… ' + waiting + ' с'
        : state.label + ': закрываем…');

    const button = findCloseButton(modal, state.closeSelector);
    if (button) {
        button.click();
        state.clicks = (state.clicks || 0) + 1;
    }

    // Зависшая оболочка пуста изначально: крестик если и есть, то уже
    // отрисован, и ждать, пока он появится, нечего. Нет его — убираем сразу,
    // есть — даём платформе секунду отреагировать на клик.
    if (state.stuck && !button) {
        forceHideModal(modal, state);
        return;
    }
    const limit = state.stuck ? STUCK_DISMISS_ATTEMPTS : DISMISS_ATTEMPTS;
    if (state.attempts >= limit) {
        forceHideModal(modal, state);
    }
}

// Реклама за награду. Ранний клик по «Закрыть» отменяет бонус, ради которого
// игрок её и запустил, поэтому сначала ждём отсчёт и только потом закрываем.
function tickRewardedAd(modal, state, elapsed) {
    // Если платформа рисует отсчёт в самом документе, читаем его; если нет —
    // отсчитываем сами от типичных 15 секунд.
    const adCountdown = readAdCountdown(modal);
    const ownRemaining = Math.max(0, Math.ceil((REWARDED_MIN_WAIT_MS - elapsed) / 1000));
    const remaining = adCountdown !== null ? adCountdown : ownRemaining;

    if (overlay) {
        overlay.timer.textContent = remaining > 0 ? String(remaining) : '0';
        overlay.hint.textContent = remaining > 0
            ? 'Награда придёт автоматически'
            : 'Забираем награду…';
    }

    if (remaining > 0) {
        return;
    }

    // Отсчёт кончился — награда засчитана, можно закрывать.
    const button = findCloseButton(modal);
    if (button) {
        button.click();
        state.clicks = (state.clicks || 0) + 1;
    }

    if (elapsed >= REWARDED_MAX_WAIT_MS) {
        forceHideModal(modal, state);
    }
}

function dismissModal(modal, options = {}) {
    if (dismissing.has(modal)) {
        return;
    }

    const state = beginDismiss(modal, options);

    state.timer = setInterval(() => {
        state.attempts += 1;
        const elapsed = Date.now() - state.startedAt;

        // Платформа убрала модал или опустошила его сама — наша работа
        // закончена. У зависшей оболочки внутри пусто изначально, поэтому для
        // неё признак конца другой: ушла с экрана.
        const gone = state.stuck
            ? !isModalOnScreen(modal)
            : !isModalShown(modal, state.contentSelector);
        if (!modal.isConnected || gone) {
            finishDismiss(modal, state);
            return;
        }

        muteMedia(modal);
        (state.rewarded ? tickRewardedAd : tickPlainAd)(modal, state, elapsed);
    }, DISMISS_INTERVAL_MS);
    dismissTimers.push(state.timer);
}

// ===== src/content/scan.js =====

// Проходы по странице и реакция на изменения разметки.
//
// Разметка прилетает пачками мутаций, поэтому проходы склеиваются в один по
// таймеру, а не запускаются на каждую мутацию.

/* ---------- сканирование ---------- */

function scanSticky() {
    if (!settings.sticky) {
        return;
    }
    document.querySelectorAll(STICKY_SELECTOR).forEach(el => {
        const outer = outermost(el, STICKY_SELECTOR);
        const rect = outer.getBoundingClientRect();
        const height = rect.height;
        if (hide(outer) && height >= MIN_BANNER_HEIGHT) {
            lastBannerParent = outer.parentElement;
            hideEmptyColumn(outer, rect);
            relayout(height);
        }
    });
}

// Боковой блок лежит в собственной обёртке, и она остаётся в потоке даже
// после того, как содержимое скрыто: в отчёте это 315x948 на x = 1597,
// ровно поверх правого края растянутой игры. Полоса невидима, но занимает
// место и перехватывает клики.
//
// Ищем по измерениям, а не по классу: класс обёртки хеширован. Признак —
// родитель той же ширины, что и скрытый блок, узкий по меркам экрана и без
// фрейма игры внутри. Последнее условие обязательно: без него под нож
// попала бы обёртка самой игры.
function hideEmptyColumn(el, rect) {
    if (rect.width < 100 || rect.width > window.innerWidth * 0.4) {
        return;
    }

    let parent = el.parentElement;
    let depth = 0;
    while (parent && parent !== document.body && depth < 3) {
        const parentRect = parent.getBoundingClientRect();
        if (!near(parentRect.width, rect.width, 8) || parent.querySelector('iframe')) {
            return;
        }
        hide(parent, { allowButtons: true });
        parent = parent.parentElement;
        depth += 1;
    }
}

function scanDisableAdvButton() {
    if (!settings.sticky) {
        return;
    }
    document.querySelectorAll(DISABLE_ADV_SELECTOR).forEach(el => {
        // Поднимаемся до слота: сама кнопка лежит в контейнере, который
        // держит высоту, даже когда внутри уже ничего не видно.
        const outer = el.closest(DISABLE_ADV_WRAPPER_SELECTOR) || el;
        hide(outer, { allowButtons: true });
    });

    scanNoAdsPopup();
}

// Всплывашка с предложением обменять яны. Здесь display: none без оговорок:
// это промо платформы, а не рекламный показ, — досчитывать нечего.
function scanNoAdsPopup() {
    document.querySelectorAll(NO_ADS_POPUP_SELECTOR).forEach(el => {
        // Сам попап позиционируется внутри обёртки, которая переживёт
        // скрытие ребёнка и продолжит перехватывать клики.
        hide(outermost(el, NO_ADS_POPUP_BLOCK_SELECTOR), { allowButtons: true });
    });
}


function scanFullscreen() {
    traceModalStates();
    document.querySelectorAll(FULLSCREEN_MODAL_SELECTOR).forEach(modal => {
        if (!isAdvModal(modal) || modal.hasAttribute(REVEALED_ATTR)) {
            return;
        }
        const rewarded = isRewardedModal(modal);
        if (!(rewarded || settings.fullscreen)) {
            return;
        }

        if (isModalShown(modal)) {
            dismissModal(modal);
            return;
        }

        // Реклама не догрузилась, но оболочка заняла экран и держит игру на
        // паузе. Закрываем как обычную — ждать тут нечего. Только если это
        // действительно оболочка рекламы: пустым модалом выглядит и меню игры.
        if (isAdShell(modal) && isStuckModal(modal)) {
            dismissModal(modal, { label: 'Зависшая реклама', stuck: true });
        }
    });

    scanPromoInterstitial();
}

// Интерстишл с промо Яндекса поверх игры. Закрываем так же, как рекламный
// модал, а не через display: none: контейнер держит блюр и паузу, и уйти
// из этого состояния платформа должна сама — по клику на крестик. Если за
// отведённые попытки крестик не нашёлся, контейнер убирается силой.
function scanPromoInterstitial() {
    if (!settings.fullscreen) {
        return;
    }
    document.querySelectorAll(PROMO_INTERSTITIAL_SELECTOR).forEach(el => {
        // Внешний контейнер: блюр и перехват кликов держит он, а не слайд.
        const outer = outermost(el, PROMO_INTERSTITIAL_SELECTOR);

        if (outer.hasAttribute(REVEALED_ATTR)) {
            return;
        }

        const shown = isModalShown(outer, PROMO_CONTENT_SELECTOR);
        if (!shown && !isStuckModal(outer, PROMO_CONTENT_SELECTOR, STUCK_PROMO_MS)) {
            return;
        }

        dismissModal(outer, {
            contentSelector: PROMO_CONTENT_SELECTOR,
            closeSelector: PROMO_CLOSE_SELECTOR,
            label: shown ? 'Промо платформы' : 'Зависшее промо',
            stuck: !shown
        });
    });
}

function scanCatalog() {
    if (!settings.catalog || isGameAppPage()) {
        return;
    }
    CATALOG_SELECTORS.forEach(selector => {
        document.querySelectorAll(selector).forEach(hide);
    });
}

function scan() {
    if (orphaned || !settings.enabled || !document.body) {
        return;
    }
    // Проверяем мост на каждом проходе: сканирование запускает
    // MutationObserver, и после перезагрузки расширения это самый частый
    // путь к «Extension context invalidated».
    if (!extensionAlive()) {
        shutdownOrphan();
        return;
    }
    scanSticky();
    scanDisableAdvButton();
    scanFullscreen();
    scanCatalog();
    // Не зависит от того, нашёлся ли баннер: резерв в calc остаётся на
    // месте, даже когда рекламный блок ещё не отрисован.
    if (settings.sticky && isGameAppPage()) {
        fixGameShell();
        if (!widthStretchAllowed()) {
            centerGameShell();
        }
        watchShell();
        armLateKicks();
    }
}

function scheduleScan() {
    if (scanTimer) {
        return;
    }
    // Разметка прилетает пачками мутаций — склеиваем их в один проход.
    scanTimer = setTimeout(() => {
        scanTimer = null;
        const started = performance.now();
        scan();
        const spent = performance.now() - started;
        activity.scans += 1;
        activity.scanMs += spent;
        activityTotal.scans += 1;
        activityTotal.scanMs += spent;
        activityTotal.maxScanMs = Math.max(activityTotal.maxScanMs, spent);
    }, 150);
}

// Возврат во вкладку — отдельный повод пересмотреть страницу.
//
// Пока вкладка в фоне, браузер душит таймеры: отложенный проход может не
// состояться, а новых мутаций к возвращению игрока уже не будет — реклама
// всплыла, пока его не было. Получалось худшее из двух: оболочку погасил наш
// CSS, а закрыть её некому, и игра стоит на паузе за блюром.
//
// Заодно возвращаем игре фокус, если он потерялся, пока вкладка была в фоне.
// С задержкой: сначала браузер восстанавливает фокус сам, и решать, отдавать
// ли его игре, надо уже по итогу.
function onTabVisible() {
    note(document.hidden ? 'tab-hidden' : 'tab-visible', focusLabel());
    if (document.hidden) {
        clearInterval(wakeTimer);
        wakeTimer = null;
        resetActivity();
        return;
    }
    // Что мы успели натворить, пока вкладка спала.
    note('hidden-activity', activitySnapshot());
    startWakeSampler();
    scheduleScan();
    setTimeout(restoreGameFocus, 200);
}

// Первые 20 секунд после возврата — посекундная картина нашей активности,
// по одной записи на 2 секунды.
let wakeTimer = null;
function startWakeSampler() {
    clearInterval(wakeTimer);
    resetActivity();
    let ticks = 0;
    wakeTimer = setInterval(() => {
        ticks += 1;
        note('wake', activitySnapshot());
        resetActivity();
        if (ticks >= 10) {
            clearInterval(wakeTimer);
            wakeTimer = null;
        }
    }, 2000);
}

// Фокус окна без смены вкладки — например, возврат из другого окна. Здесь
// фокус трогаем, только если возврат был отложен: иначе клик по шапке
// страницы уводил бы его обратно в игру.
function onWindowFocus() {
    scheduleScan();
    if (refocusPending) {
        restoreGameFocus();
    }
}

// Контрольный проход. Мутаций может не быть вовсе: модал уже стоит в дереве и
// лишь меняет классы. Зависшая игра дороже редкого лишнего прохода.
let heartbeat = null;

function startHeartbeat() {
    if (!heartbeat) {
        heartbeat = setInterval(scheduleScan, HEARTBEAT_MS);
    }
}

function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = null;
}

function startObserver() {
    if (observer) {
        return;
    }
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // SPA-навигация между играми и каталогом: баннер вставляют заново.
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('pageshow', scheduleScan);
    document.addEventListener('visibilitychange', onTabVisible);
    window.addEventListener('focus', onWindowFocus);
    startHeartbeat();
}

function stopObserver() {
    lateKicksArmed = false;
    stopHeartbeat();
    // Снимаем всё, что навесил startObserver. Раньше popstate и pageshow
    // оставались висеть, и каждая смена настроек добавляла ещё по одному.
    window.removeEventListener('popstate', scheduleScan);
    window.removeEventListener('pageshow', scheduleScan);
    document.removeEventListener('visibilitychange', onTabVisible);
    window.removeEventListener('focus', onWindowFocus);
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    clearInterval(wakeTimer);
    wakeTimer = null;
    if (frameResizeObserver) {
        frameResizeObserver.disconnect();
        frameResizeObserver = null;
    }
    if (modalObserver) {
        modalObserver.disconnect();
        modalObserver = null;
    }
    watchedModals = new WeakSet();
    if (shellObserver) {
        shellObserver.disconnect();
        shellObserver = null;
    }
}

/* ---------- состояние и связь с попапом ---------- */

// MAIN-world скрипт не имеет доступа к chrome.storage, поэтому настройки
// ему отдаём событием EV_CFG. Хук может запуститься позже нас — тогда он сам
// попросит их событием EV_ASK.
function publishSdkSettings() {
    document.dispatchEvent(new CustomEvent(EV_CFG, {
        detail: JSON.stringify({
            enabled: settings.enabled,
            fullscreen: settings.fullscreen,
            rewarded: settings.rewarded
        })
    }));
}
document.addEventListener(EV_ASK, () => {
    if (settings) {
        publishSdkSettings();
    }
});

// Атрибуты на <html> управляют правилами blocker.css: так выключенный
// тумблер возвращает рекламу на место без перезагрузки страницы.
function publishCssFlags() {
    const root = document.documentElement;
    const flag = (attr, on) => on ? root.removeAttribute(attr) : root.setAttribute(attr, 'off');
    flag('data-ygab', settings.enabled);
    flag('data-ygab-sticky', settings.sticky);
    flag('data-ygab-catalog', settings.catalog);
    flag('data-ygab-fullscreen', settings.fullscreen);
    flag('data-ygab-rewarded', true);
    // Растягивание фрейма относится к тому же тумблеру, что и баннер:
    // без баннера место всё равно надо отдать игре.
    flag('data-ygab-layout', settings.sticky);
    // Отдельно — растягивание по ширине: его игрок выключает для
    // конкретной игры, если та смотрится в рамке не по центру.
    flag('data-ygab-stretch', widthStretchAllowed());
}

function applyState() {
    publishSdkSettings();
    publishCssFlags();

    // Настройки могли сузиться, поэтому сначала возвращаем страницу в
    // исходный вид, а потом скрываем заново уже по новым правилам.
    stopObserver();
    stopDismissing();
    restoreStyles();
    unhideAll();

    if (!settings.enabled) {
        pageBlocked = 0;
        kickResize();
        return;
    }

    suppressCount = pageBlocked > 0;
    startObserver();
    scan();
    suppressCount = false;
    // После пересканирования счётчик приводим к тому, что реально скрыто:
    // набор правил мог сузиться.
    pageBlocked = Array.from(hiddenNodes).filter(el => el.isConnected).length;
    kickResize();
}

// Отчёт для разбора нерабочих селекторов: попап кладёт его в буфер обмена.

// ===== src/content/report.js =====

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
    try {
        version = chrome.runtime.getManifest().version;
    } catch (e) {
        /* контекст расширения оборван — версия не критична */
    }

    return {
        // Без версии не отличить «баг не исправлен» от «расширение не
        // перезагружено после обновления».
        version,
        url: location.href,
        blockedOnPage: pageBlocked,
        settings,
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

// ===== src/content/main.js =====

// Точка входа: связь с попапом и чтение настроек.
//
// Загружается последней — к этому моменту всё остальное уже объявлено.

if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || orphaned) {
            return;
        }
        if (request.what === 'ygab:frame-diag') {
            handleHookEvent(request.event);
            return;
        }
        if (request.action === 'getStats') {
            sendResponse({
                blockedOnPage: pageBlocked,
                isGamePage: isTopGamePage(),
                // Попапу нужно знать, есть ли на этой вкладке игра и
                // растягивается ли она: тумблер показывается только там.
                gameId: gameId(),
                isGameApp: isGameAppPage(),
                widthStretch: widthStretchAllowed()
            });
        } else if (request.action === 'getReport') {
            sendResponse({ report: buildReport() });
        }
    });
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || orphaned) {
        return;
    }
    let dirty = false;
    for (const key of Object.keys(DEFAULTS)) {
        if (key in changes) {
            settings[key] = changes[key].newValue;
            dirty = true;
        }
    }
    if (NO_STRETCH_KEY in changes) {
        const next = changes[NO_STRETCH_KEY].newValue;
        noStretchGames = Array.isArray(next) ? next : [];
        dirty = true;
    }
    if (dirty) {
        applyState();
    }
});

callExtension(() => {
    chrome.storage.sync.get({ ...DEFAULTS, [NO_STRETCH_KEY]: [] }, stored => {
        settings = { ...DEFAULTS, ...stored };
        noStretchGames = Array.isArray(stored[NO_STRETCH_KEY]) ? stored[NO_STRETCH_KEY] : [];
        applyState();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scan, { once: true });
        }
    });
});

})();
