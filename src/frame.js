// Посредник во фрейме игры (изолированный мир).
//
// Сама игра живёт во фрейме на своём домене (cdn.games.yandex.net или
// games.s3.yandex.net), и там работает только хук SDK в MAIN world. Этот
// скрипт даёт ему две вещи, которых раньше не было:
//   * настройки из попапа — без них хук во фрейме всегда считал всё
//     включённым, и тумблер «реклама за награду» на игры не действовал;
//   * путь для диагностики в отчёт верхней страницы — через фоновый скрипт,
//     а не postMessage на '*', который видят скрипты страницы.
(() => {
    'use strict';

    // Имена каналов — те же, что в content/config.js и sdk-hook.js.
    const EV_CFG = 'hx7pfq';
    const EV_ASK = 'hx7pfr';
    const EV_DIAG = 'kt3wmz';

    const KEYS = { enabled: true, fullscreen: true, rewarded: true };
    // Сайты, где расширение выключено кнопкой в попапе (сборка Cleathernet);
    // тот же ключ, что OFF_SITES_KEY в content/config.js.
    const OFF_SITES_KEY = 'ygab.offSites';
    let config = null;
    let offSites = [];

    // Решает хост вкладки, а не фрейма игры: выключили на yandex.ru —
    // хук во фрейме пропускает рекламу к настоящему SDK.
    function topHostname() {
        try {
            const origins = location.ancestorOrigins;
            if (origins && origins.length) {
                return new URL(origins[origins.length - 1]).hostname;
            }
        } catch (e) {
            /* нет доступа — остаётся хост фрейма */
        }
        return location.hostname;
    }

    function siteIsOff() {
        const host = topHostname();
        return offSites.some(site => host === site || host.endsWith('.' + site));
    }

    function publish() {
        if (config) {
            const effective = { ...config, enabled: config.enabled !== false && !siteIsOff() };
            document.dispatchEvent(new CustomEvent(EV_CFG, { detail: JSON.stringify(effective) }));
        }
    }

    try {
        // Список выключенных сайтов — в local (см. content/config.js).
        chrome.storage.local.get({ [OFF_SITES_KEY]: [] }, local => {
            offSites = Array.isArray(local[OFF_SITES_KEY]) ? local[OFF_SITES_KEY] : [];
            chrome.storage.sync.get(KEYS, stored => {
                config = { ...KEYS, ...stored };
                publish();
            });
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (!config) {
                return;
            }
            if (area === 'local' && OFF_SITES_KEY in changes) {
                const next = changes[OFF_SITES_KEY].newValue;
                offSites = Array.isArray(next) ? next : [];
                publish();
                return;
            }
            if (area !== 'sync') {
                return;
            }
            let dirty = false;
            for (const key of Object.keys(KEYS)) {
                if (key in changes) {
                    config[key] = changes[key].newValue;
                    dirty = true;
                }
            }
            if (dirty) {
                publish();
            }
        });
    } catch (e) {
        /* контекст расширения оборван — хук останется на значениях по умолчанию */
    }

    document.addEventListener(EV_ASK, publish);

    // Пароль хука (см. sdk-hook.js): запоминаем из первого события — оно
    // приходит до запуска скриптов страницы — и дальше пересылаем только
    // события с ним. Остальную проверку делает верхний документ.
    let hookToken = null;
    document.addEventListener(EV_DIAG, event => {
        const raw = event.detail;
        if (typeof raw !== 'string' || raw.length > 16000) {
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
        try {
            const sent = chrome.runtime.sendMessage({ what: 'ygab:frame-diag', event: JSON.stringify(data) });
            if (sent && typeof sent.catch === 'function') {
                sent.catch(() => {});
            }
        } catch (e) {
            /* контекст оборван — диагностика не критична */
        }
    });
})();
