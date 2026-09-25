'use strict';

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
    if (!settings.fullscreen && !settings.rewarded) {
        return;
    }
    document.querySelectorAll(FULLSCREEN_MODAL_SELECTOR).forEach(modal => {
        if (!isAdvModal(modal) || modal.hasAttribute(REVEALED_ATTR)) {
            return;
        }
        const rewarded = isRewardedModal(modal);
        if (!(rewarded ? settings.rewarded : settings.fullscreen)) {
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
        if (!shown && !isStuckModal(outer, PROMO_CONTENT_SELECTOR)) {
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
        scan();
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
    if (!document.hidden) {
        scheduleScan();
        setTimeout(restoreGameFocus, 200);
    }
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
    if (shellObserver) {
        shellObserver.disconnect();
        shellObserver = null;
    }
}

/* ---------- состояние и связь с попапом ---------- */

// MAIN-world скрипт не имеет доступа к chrome.storage, поэтому настройки
// для него кладём в атрибут <html>, а он читает их в момент вызова рекламы.
function publishSdkSettings() {
    document.documentElement.setAttribute(SDK_ATTR, JSON.stringify({
        enabled: settings.enabled,
        fullscreen: settings.fullscreen,
        rewarded: settings.rewarded
    }));
}

// Атрибуты на <html> управляют правилами blocker.css: так выключенный
// тумблер возвращает рекламу на место без перезагрузки страницы.
function publishCssFlags() {
    const root = document.documentElement;
    const flag = (attr, on) => on ? root.removeAttribute(attr) : root.setAttribute(attr, 'off');
    flag('data-ygab', settings.enabled);
    flag('data-ygab-sticky', settings.sticky);
    flag('data-ygab-catalog', settings.catalog);
    flag('data-ygab-fullscreen', settings.fullscreen);
    flag('data-ygab-rewarded', settings.rewarded);
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
    pageBlocked = document.querySelectorAll('[' + HIDDEN_ATTR + '="1"]').length;
    kickResize();
}

// Отчёт для разбора нерабочих селекторов: попап кладёт его в буфер обмена.
