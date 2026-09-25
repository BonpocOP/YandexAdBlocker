// Типовые детекторы блокировщиков — то, что запускают сайты. Подключается в
// тестовые страницы (dev/test-detectors.mjs) и работает в MAIN world, как
// скрипт сайта. Результат — window.__detectors: { имя: true/false }.
//
// Это не исчерпывающий список, а самые частые приёмы: если на них нас
// ловят, поймает любой.
(() => {
    const result = {};
    const done = [];

    // 1. Приманка: блок с «рекламными» классами. Блокировщик прячет его общим
    //    правилом — детектор смотрит на высоту.
    const bait = document.createElement('div');
    bait.className = 'adsbox ad-banner ad_box pub_300x250 textads banner_ad';
    bait.id = 'ad-banner';
    bait.style.cssText = 'position:absolute;left:-9999px;top:0;width:300px;height:250px';
    bait.innerHTML = '&nbsp;';
    (document.body || document.documentElement).append(bait);
    done.push(new Promise(resolve => setTimeout(() => {
        const style = getComputedStyle(bait);
        result.bait = bait.offsetHeight === 0 || style.display === 'none' || style.visibility === 'hidden';
        resolve();
    }, 300)));

    // 1б. Точная копия приманки со страницы Яндекс.Игр (видна во всех
    //     отчётах): #AdBanner.AdsBox.ad_box.ad_banner.ad_300x100.Ad_container.
    const yandexBait = document.createElement('div');
    yandexBait.id = 'AdBanner';
    yandexBait.className = 'AdsBox ad_box ad_banner ad_300x100 Ad_container';
    yandexBait.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px';
    (document.body || document.documentElement).append(yandexBait);
    done.push(new Promise(resolve => setTimeout(() => {
        const style = getComputedStyle(yandexBait);
        result.yandexBait = style.display === 'none' || style.visibility === 'hidden' || yandexBait.getClientRects().length === 0;
        resolve();
    }, 1500)));

    // 1в. Контроль: узел, который общие правила EasyList прячут точно. Если
    //     он НЕ спрятан, косметика соседа на этой странице не работает, и
    //     «приманку не тронули» ничего не значит.
    const control = document.createElement('div');
    control.id = 'div-gpt-ad-1234567890-0';
    control.style.cssText = 'width:300px;height:250px';
    control.innerHTML = '&nbsp;';
    (document.body || document.documentElement).append(control);
    done.push(new Promise(resolve => setTimeout(() => {
        const style = getComputedStyle(control);
        result.controlHidden = style.display === 'none' || style.visibility === 'hidden' || control.getClientRects().length === 0;
        resolve();
    }, 1500)));

    // 2. Рекламный скрипт: если его режут, срабатывает onerror.
    done.push(new Promise(resolve => {
        const s = document.createElement('script');
        s.src = 'https://an.yandex.ru/system/context.js';
        s.onload = () => { result.adScriptBlocked = false; resolve(); };
        s.onerror = () => { result.adScriptBlocked = true; resolve(); };
        document.head.append(s);
        setTimeout(() => { if (!('adScriptBlocked' in result)) { result.adScriptBlocked = true; resolve(); } }, 3000);
    }));

    // 3. Подменённые встроенные функции: у нативных toString даёт [native code].
    const natives = {
        addEventListener: EventTarget.prototype.addEventListener,
        dispatchEvent: EventTarget.prototype.dispatchEvent,
        postMessage: window.postMessage,
        fetch: window.fetch,
        xhrOpen: XMLHttpRequest.prototype.open,
        defineProperty: Object.defineProperty,
        getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
        setTimeout: window.setTimeout,
        querySelector: Document.prototype.querySelector,
        toString: Function.prototype.toString,
        jsonStringify: JSON.stringify,
        attachShadow: Element.prototype.attachShadow
    };
    result.patchedNatives = Object.entries(natives)
        .filter(([, fn]) => !/\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn)))
        .map(([name]) => name);

    // 4. Чужие стили: правила, которых сайт не писал (видны только
    //    вставленные в документ, CSS расширений через insertCSS не виден).
    let foreignRules = 0;
    for (const sheet of document.styleSheets) {
        try {
            for (const rule of sheet.cssRules) {
                if (/display\s*:\s*none\s*!important/.test(rule.cssText) && /ad|banner|sponsor/i.test(rule.selectorText || '')) {
                    foreignRules += 1;
                }
            }
        } catch (e) { /* чужой домен */ }
    }
    result.foreignStyleRules = foreignRules;

    // 5. Глобальные переменные и атрибуты с характерными именами.
    result.suspiciousGlobals = Object.keys(window).filter(k => /adblock|ublock|ygab|__ab|abp/i.test(k));
    const attrs = [];
    for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes) {
            if (/ygab|adblock|ublock|abp-/i.test(a.name)) attrs.push(a.name);
        }
    }
    result.suspiciousAttributes = [...new Set(attrs)];

    window.__detectorsReady = Promise.all(done).then(() => {
        window.__detectors = result;
        return result;
    });
})();
