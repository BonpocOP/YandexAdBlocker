// Работает в MAIN world, то есть в контексте самой страницы игры: только
// оттуда видно объект Yandex Games SDK.
//
// Задача — перехватить показ рекламы до того, как SDK уйдёт в сеть, и сразу
// вызвать колбэки завершения. Игра получает привычную последовательность
// событий и не зависает на «реклама скоро закончится».
//
// Надёжность важнее незаметности. SDK ловим, как в 1.5.5, перехватом
// присваивания window.YaGames: только так хук успевает раньше, чем игра
// вызовет YaGames.init(), даже если SDK встроен в код игры и события
// загрузки скрипта между ними нет. Цена — YaGames и ysdk на window
// становятся свойствами-аксессорами.
//
// Остальные следы не оставляем (из 1.6.0):
//   * ни одного глобала и ни одного свойства-метки на чужих объектах —
//     всё, что нужно помнить, лежит в замыкании;
//   * подменённый метод остаётся там же, где был (на объекте или в
//     прототипе), с тем же дескриптором, именем и длиной — это Proxy
//     вокруг оригинала; если так не вышло — простое присваивание;
//   * связь с расширением — события на document с ничего не говорящими
//     именами, а не атрибуты и не postMessage на '*'.
//
// Награда выдаётся всегда, пока расширение включено; отдельного тумблера нет.
(() => {
    'use strict';

    // Имена каналов — те же, что в content/config.js и frame.js.
    const EV_CFG = 'hx7pfq';
    const EV_ASK = 'hx7pfr';
    const EV_DIAG = 'kt3wmz';

    // Берём нужное до того, как страница успеет что-то подменить: скрипт
    // стартует на document_start, раньше кода страницы.
    const CustomEventCtor = window.CustomEvent;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const listen = EventTarget.prototype.addEventListener;
    const toJSON = JSON.stringify;
    const fromJSON = JSON.parse;
    const hasOwn = Object.prototype.hasOwnProperty;
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const defineProperty = Object.defineProperty;
    const getPrototype = Object.getPrototypeOf;
    const reflectApply = Reflect.apply;
    const ProxyCtor = Proxy;
    const resolved = value => Promise.resolve(value);

    // Пароль канала диагностики. Первое событие (sdk-hook-loaded) уходит
    // синхронно на document_start: его слышит только наш изолированный мир
    // — скрипты страницы ещё не запущены. Дальше наш мир принимает только
    // события с этим паролем, и страница не может подложить мусор в отчёт.
    const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(36)).join('');

    // Настройки приходят из изолированного мира (content script на
    // странице Яндекса или frame.js во фрейме игры). Пока не пришли —
    // считаем всё включённым.
    let config = null;
    reflectApply(listen, document, [EV_CFG, event => {
        try {
            config = fromJSON(event.detail);
        } catch (e) {
            /* битые настройки — остаёмся на значениях по умолчанию */
        }
    }]);

    function isOn(key) {
        return !config || (config.enabled !== false && config[key] !== false);
    }

    // Диагностика для отчёта — в изолированный мир того же документа.
    function notify(kind, detail) {
        try {
            const payload = toJSON({ k: token, kind, detail: detail === undefined ? null : detail, href: location.href, at: Date.now() });
            reflectApply(dispatch, document, [new CustomEventCtor(EV_DIAG, { detail: payload })]);
        } catch (e) {
            /* диагностика не критична */
        }
    }

    const call = (fn, ...args) => {
        if (typeof fn !== 'function') {
            return;
        }
        try {
            fn(...args);
        } catch (e) {
            /* ошибка в колбэке игры — не наша забота */
        }
    };

    // Подмена метода там, где он определён, с тем же дескриптором. Proxy
    // сохраняет имя, длину и typeof оригинала. Если метод устроен иначе
    // (аксессор, запрет на переопределение) — присваиваем на сам объект,
    // как в 1.5.5: работоспособность важнее.
    //
    // Метод ищем по дескрипторам, а не чтением obj[name]: SDK v2 заворачивает
    // ysdk.adv в Proxy, который сообщает платформе, какие методы читала
    // игра, и наше чтение попало бы в этот список.
    function replaceMethod(obj, name, makeApply) {
        let owner = obj;
        let descriptor;
        while (owner && !(descriptor = getDescriptor(owner, name))) {
            owner = getPrototype(owner);
        }
        if (!descriptor) {
            return false;
        }
        // Аксессор: значение можно узнать только чтением.
        const current = reflectApply(hasOwn, descriptor, ['value']) ? descriptor.value : obj[name];
        if (typeof current !== 'function') {
            return false;
        }
        if (descriptor.value === current) {
            try {
                defineProperty(owner, name, {
                    value: new ProxyCtor(current, { apply: makeApply(current) }),
                    writable: descriptor.writable,
                    enumerable: descriptor.enumerable,
                    configurable: descriptor.configurable
                });
                return true;
            } catch (e) {
                /* не вышло — ниже простое присваивание */
            }
        }
        try {
            const apply = makeApply(current);
            const replacement = function (...args) {
                return apply(current, this, args);
            };
            obj[name] = replacement;
            const now = getDescriptor(obj, name);
            return Boolean(now) && now.value === replacement;
        } catch (e) {
            return false;
        }
    }

    const patched = new WeakSet();

    function patchAdv(adv) {
        if (!adv || typeof adv !== 'object' || patched.has(adv)) {
            return;
        }
        patched.add(adv);
        const done = [];

        if (replaceMethod(adv, 'showFullscreenAdv', original => (target, self, args) => {
            notify('sdk-call', 'showFullscreenAdv');
            if (!isOn('fullscreen')) {
                return reflectApply(original, self, args);
            }
            const cb = (args[0] && args[0].callbacks) || {};
            // Асинхронно, как у настоящей рекламы: игра успевает доиграть
            // свой код до колбэка.
            setTimeout(() => {
                call(cb.onOpen);
                // wasShown = false: рекламу мы не показали, и игра не должна
                // считать её просмотренной.
                call(cb.onClose, false);
            }, 0);
            return resolved();
        })) {
            done.push('showFullscreenAdv');
        }

        if (replaceMethod(adv, 'showRewardedVideo', original => (target, self, args) => {
            notify('sdk-call', 'showRewardedVideo');
            if (!isOn('enabled')) {
                return reflectApply(original, self, args);
            }
            const cb = (args[0] && args[0].callbacks) || {};
            setTimeout(() => {
                call(cb.onOpen);
                // Награду выдаём сразу: иначе игрок остаётся без обещанного
                // бонуса, ради которого и нажимал кнопку.
                call(cb.onRewarded);
                call(cb.onClose);
            }, 0);
            return resolved();
        })) {
            done.push('showRewardedVideo');
        }

        // Sticky-баннер: сообщаем игре, что он не показан. DOM-часть его всё
        // равно прячет, но без этого некоторые игры двигают свой интерфейс.
        if (replaceMethod(adv, 'showBannerAdv', original => (target, self, args) =>
            (isOn('enabled') ? resolved({ stickyAdvIsShowing: false, reason: 'ADV_IS_NOT_CONNECTED' }) : reflectApply(original, self, args)))) {
            done.push('showBannerAdv');
        }
        if (replaceMethod(adv, 'getBannerAdvStatus', original => (target, self, args) =>
            (isOn('enabled') ? resolved({ stickyAdvIsShowing: false }) : reflectApply(original, self, args)))) {
            done.push('getBannerAdvStatus');
        }

        notify('sdk-patched', done.join(','));
    }

    function patchYsdk(ysdk) {
        if (ysdk && typeof ysdk === 'object' && ysdk.adv) {
            patchAdv(ysdk.adv);
        }
        return ysdk;
    }

    // В SDK v2 YaGames — класс со статическим init, то есть функция; у
    // загрузчика /sdk.js и старых SDK — обычный объект.
    function patchYaGames(yaGames) {
        if (!yaGames || (typeof yaGames !== 'object' && typeof yaGames !== 'function') || patched.has(yaGames)) {
            return yaGames;
        }
        patched.add(yaGames);
        replaceMethod(yaGames, 'init', original => (target, self, args) => {
            const result = reflectApply(original, self, args);
            return result && typeof result.then === 'function'
                ? result.then(patchYsdk)
                : patchYsdk(result);
        });
        return yaGames;
    }

    // Перехват присваивания глобала: скрипт стартует на document_start,
    // раньше SDK, и получает объект в момент появления — до первого вызова.
    function intercept(name, patch) {
        let value = window[name];
        if (value) {
            patch(value);
        }
        try {
            defineProperty(window, name, {
                configurable: true,
                enumerable: true,
                get: () => value,
                set: next => {
                    value = next;
                    patch(next);
                }
            });
        } catch (e) {
            /* не удалось — остаются проверки ниже */
        }
    }

    intercept('YaGames', patchYaGames);
    // Часть игр складывает готовый ysdk в глобальную переменную.
    intercept('ysdk', patchYsdk);

    function check() {
        try {
            if (window.YaGames) {
                patchYaGames(window.YaGames);
            }
            if (window.ysdk) {
                patchYsdk(window.ysdk);
            }
        } catch (e) {
            /* чужой геттер бросил исключение — попробуем позже */
        }
    }

    // Страховка на случай, если SDK объявил свойство сам (перезаписал наш
    // перехват) или пришёл модулем: проверяем после загрузки каждого скрипта
    // и по таймеру.
    reflectApply(listen, document, ['load', event => {
        if (event.target && event.target.tagName === 'SCRIPT') {
            check();
        }
    }, true]);
    [50, 200, 1000, 3000, 8000].forEach(delay => setTimeout(check, delay));
    reflectApply(listen, document, ['DOMContentLoaded', check]);

    // Сводка сообщений платформы во фрейм игры — для отчёта. Платформа
    // ставит игру на паузу и снимает с паузы сообщениями через postMessage, и
    // без этой сводки не понять, почему игра стоит, когда на экране пусто.
    // Пишем только тип сообщения и время, без содержимого.
    const SKIP_KEY = /id$|Id$|token|hash|url|href|origin/i;
    function shortFields(obj, prefix) {
        const out = [];
        if (!obj || typeof obj !== 'object') {
            return out;
        }
        for (const key of Object.keys(obj).slice(0, 12)) {
            const value = obj[key];
            if (typeof value === 'string' && value.length <= 40 && !SKIP_KEY.test(key)) {
                out.push(prefix + key + '=' + value);
            }
        }
        return out;
    }

    function messageType(data) {
        if (!data) {
            return null;
        }
        if (typeof data === 'string') {
            return 'str:' + data.slice(0, 40);
        }
        if (typeof data !== 'object') {
            return null;
        }
        const fields = shortFields(data, '')
            .concat(shortFields(data.data, 'data.'), shortFields(data.payload, 'payload.'))
            .slice(0, 4);
        return fields.length
            ? fields.join(' ').slice(0, 120)
            : 'keys:' + Object.keys(data).slice(0, 5).join(',');
    }

    if (window.parent !== window) {
        const seen = new Map();
        let dirty = false;
        reflectApply(listen, window, ['message', event => {
            if (event.source !== window.parent) {
                return;
            }
            const type = messageType(event.data);
            if (!type) {
                return;
            }
            const now = Date.now();
            const entry = seen.get(type);
            if (entry) {
                entry.count += 1;
                entry.last = now;
            } else if (seen.size < 40) {
                seen.set(type, { count: 1, first: now, last: now });
            } else {
                return;
            }
            dirty = true;
        }]);
        setInterval(() => {
            if (dirty) {
                dirty = false;
                notify('frame-messages', Object.fromEntries(seen));
            }
        }, 3000);
    }

    // Попросить настройки: изолированный мир мог запуститься раньше нас и
    // уже разослать их впустую.
    reflectApply(dispatch, document, [new CustomEventCtor(EV_ASK)]);
    notify('sdk-hook-loaded', window.parent === window ? 'top' : 'iframe');
})();
