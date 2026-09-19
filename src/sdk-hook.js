// Работает в MAIN world, то есть в контексте самой страницы игры: только
// оттуда видно объект Yandex Games SDK.
//
// Задача — перехватить показ рекламы до того, как SDK уйдёт в сеть, и сразу
// вызвать колбэки завершения. Игра получает привычную последовательность
// событий и не зависает на «реклама скоро закончится».
(() => {
    'use strict';

    if (window.__ygabSdkPatched) {
        return;
    }
    window.__ygabSdkPatched = true;

    const SDK_ATTR = 'data-ygab-sdk';

    // Настройки читаем в момент вызова: content-script кладёт их в атрибут
    // <html> асинхронно, а порядок запуска скриптов в разных мирах не
    // гарантирован. До первой записи считаем блокировку включённой.
    function isOn(key) {
        try {
            const raw = document.documentElement.getAttribute(SDK_ATTR);
            if (!raw) {
                return true;
            }
            const state = JSON.parse(raw);
            return state.enabled !== false && state[key] !== false;
        } catch (e) {
            return true;
        }
    }

    // Диагностика: сообщаем верхнему документу, что хук доехал до этого фрейма
    // и что в нём происходит. content.js собирает эти события в отчёт — иначе
    // невозможно отличить «SDK не найден» от «фрейм вообще без нашего скрипта».
    function notify(kind, detail) {
        const message = { __ygab: kind, detail: detail || null, href: location.href };
        try {
            window.postMessage(message, '*');
            if (window.parent !== window) {
                window.parent.postMessage(message, '*');
            }
        } catch (e) {
            /* межфреймовая отправка запрещена — диагностика не критична */
        }
    }

    const call = fn => {
        if (typeof fn !== 'function') {
            return;
        }
        try {
            fn();
        } catch (e) {
            console.debug('[YGAB] колбэк игры бросил исключение', e);
        }
    };

    function patchAdv(adv) {
        if (!adv || adv.__ygabPatched) {
            return adv;
        }
        adv.__ygabPatched = true;
        notify('sdk-patched', Object.keys(adv).filter(key => typeof adv[key] === 'function').join(','));

        const originalFullscreen = typeof adv.showFullscreenAdv === 'function' ? adv.showFullscreenAdv.bind(adv) : null;
        const originalRewarded = typeof adv.showRewardedVideo === 'function' ? adv.showRewardedVideo.bind(adv) : null;

        adv.showFullscreenAdv = (options = {}) => {
            notify('sdk-call', 'showFullscreenAdv');
            if (!isOn('fullscreen')) {
                return originalFullscreen ? originalFullscreen(options) : Promise.resolve();
            }
            const cb = options.callbacks || {};
            // Асинхронно, чтобы игра успела доиграть свой код до колбэка —
            // так же, как это происходит с настоящей рекламой.
            setTimeout(() => {
                call(cb.onOpen);
                // wasShown = false: рекламу мы не показали, и игра не должна
                // считать её просмотренной.
                if (typeof cb.onClose === 'function') {
                    try {
                        cb.onClose(false);
                    } catch (e) {
                        console.debug('[YGAB] onClose бросил исключение', e);
                    }
                }
            }, 0);
            return Promise.resolve();
        };

        adv.showRewardedVideo = (options = {}) => {
            notify('sdk-call', 'showRewardedVideo');
            if (!isOn('rewarded')) {
                return originalRewarded ? originalRewarded(options) : Promise.resolve();
            }
            const cb = options.callbacks || {};
            setTimeout(() => {
                call(cb.onOpen);
                // Награду выдаём сразу: иначе игрок остаётся без обещанного
                // бонуса, ради которого и нажимал кнопку.
                call(cb.onRewarded);
                call(cb.onClose);
            }, 0);
            return Promise.resolve();
        };

        // Sticky-баннер: сообщаем игре, что он не показан. DOM-часть его всё
        // равно прячет, но без этого некоторые игры двигают свой интерфейс.
        if (typeof adv.showBannerAdv === 'function') {
            adv.showBannerAdv = () => Promise.resolve({ stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' });
        }
        if (typeof adv.getBannerAdvStatus === 'function') {
            adv.getBannerAdvStatus = () => Promise.resolve({ stickyAdvIsShowing: false });
        }

        return adv;
    }

    function patchYsdk(ysdk) {
        if (ysdk && ysdk.adv) {
            patchAdv(ysdk.adv);
        }
        return ysdk;
    }

    function patchYaGames(yaGames) {
        if (!yaGames || yaGames.__ygabPatched) {
            return yaGames;
        }
        yaGames.__ygabPatched = true;

        if (typeof yaGames.init === 'function') {
            const originalInit = yaGames.init.bind(yaGames);
            yaGames.init = (...args) => Promise.resolve(originalInit(...args)).then(patchYsdk);
        }
        return yaGames;
    }

    // Перехватываем присваивание глобалов: наш скрипт стартует на
    // document_start, то есть раньше, чем загрузится сам SDK.
    function intercept(name, patch) {
        let value = window[name];
        if (value) {
            patch(value);
        }
        try {
            Object.defineProperty(window, name, {
                configurable: true,
                get: () => value,
                set: next => {
                    value = patch(next);
                }
            });
        } catch (e) {
            console.debug('[YGAB] не удалось перехватить window.' + name, e);
        }
    }

    intercept('YaGames', patchYaGames);
    // Часть игр складывает готовый ysdk в глобальную переменную.
    intercept('ysdk', patchYsdk);

    // Перехват через defineProperty может не сработать: SDK способен объявить
    // свойство сам или прийти как ES-модуль, минуя window. Поэтому ещё
    // несколько раз проверяем глобалы напрямую.
    [50, 200, 1000, 3000, 8000].forEach(delay => {
        setTimeout(() => {
            if (window.YaGames) {
                patchYaGames(window.YaGames);
            }
            if (window.ysdk) {
                patchYsdk(window.ysdk);
            }
        }, delay);
    });

    notify('sdk-hook-loaded', window.parent === window ? 'top' : 'iframe');
})();
