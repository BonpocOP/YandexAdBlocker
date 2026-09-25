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
    let config = null;

    function publish() {
        if (config) {
            document.dispatchEvent(new CustomEvent(EV_CFG, { detail: JSON.stringify(config) }));
        }
    }

    try {
        chrome.storage.sync.get(KEYS, stored => {
            config = { ...KEYS, ...stored };
            publish();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync' || !config) {
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

    document.addEventListener(EV_DIAG, event => {
        try {
            const sent = chrome.runtime.sendMessage({ what: 'ygab:frame-diag', event: event.detail });
            if (sent && typeof sent.catch === 'function') {
                sent.catch(() => {});
            }
        } catch (e) {
            /* контекст оборван — диагностика не критична */
        }
    });
})();
