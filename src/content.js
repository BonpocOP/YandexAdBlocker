// Content-script варианта B: прячет рекламные блоки, снимает зарезервированное
// под них место и заставляет игру пересчитать свой размер.
//
// Порядок шагов важен: сначала измеряем баннер (его ещё видно в потоке,
// blocker.css прячет его через visibility), потом убираем из потока, потом
// чиним геометрию родителей и только затем растягиваем фрейм игры.
(() => {
    'use strict';

    const DEFAULTS = {
        enabled: true,
        sticky: true,
        fullscreen: true,
        rewarded: true,
        catalog: true
    };

    const HIDDEN_ATTR = 'data-ygab-hidden';
    const SDK_ATTR = 'data-ygab-sdk';
    // Модал, который игрок вернул кнопкой «Показать рекламу».
    const REVEALED_ATTR = 'data-ygab-revealed';

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

    const DISMISS_INTERVAL_MS = 250;
    const DISMISS_ATTEMPTS = 32;

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

    let settings = { ...DEFAULTS };
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

    /* ---------- утилиты ---------- */

    const isTopGamePage = () => location.pathname.startsWith('/games') && window.top === window.self;
    const isGameAppPage = () => location.pathname.startsWith('/games/app');

    function force(el, prop, value) {
        touched.push({
            el,
            prop,
            prev: el.style.getPropertyValue(prop),
            priority: el.style.getPropertyPriority(prop)
        });
        el.style.setProperty(prop, value, 'important');
    }

    function restoreStyles() {
        while (touched.length) {
            const { el, prop, prev, priority } = touched.pop();
            if (prev) {
                el.style.setProperty(prop, prev, priority);
            } else {
                el.style.removeProperty(prop);
            }
        }
    }

    function pxOf(value) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
    }

    const near = (a, b, tolerance = 3) => a !== null && Math.abs(a - b) <= tolerance;

    /* ---------- скрытие ---------- */

    function hide(el, options = {}) {
        if (!el || el.getAttribute(HIDDEN_ATTR) === '1') {
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

        el.setAttribute(HIDDEN_ATTR, '1');
        // Дублируем CSS инлайном: страница перерисовывает баннер и может
        // навесить свои стили поверх нашего файла.
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
        document.querySelectorAll('[' + HIDDEN_ATTR + '="1"]').forEach(el => {
            el.removeAttribute(HIDDEN_ATTR);
            el.style.removeProperty('display');
        });
    }

    function scheduleTotalFlush() {
        if (flushTimer || !chrome.storage) {
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
            chrome.storage.local.get({ totalBlocked: 0 }, ({ totalBlocked }) => {
                chrome.storage.local.set({ totalBlocked: (Number(totalBlocked) || 0) + increment });
            });
        }, 300);
    }

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
        const shell = [frame].concat(ancestorChain(frame, 4));
        for (const el of shell) {
            for (const prop of ['width', 'height', 'max-width', 'max-height']) {
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

    /* ---------- сканирование ---------- */

    function scanSticky() {
        if (!settings.sticky) {
            return;
        }
        document.querySelectorAll(STICKY_SELECTOR).forEach(el => {
            // Берём самый внешний подходящий узел: скрывать внутренности
            // бесполезно, место в разметке держит именно обёртка.
            let outer = el;
            let parent = outer.parentElement;
            while (parent && parent.matches && parent.matches(STICKY_SELECTOR)) {
                outer = parent;
                parent = outer.parentElement;
            }

            const height = outer.getBoundingClientRect().height;
            if (hide(outer) && height >= MIN_BANNER_HEIGHT) {
                lastBannerParent = outer.parentElement;
                relayout(height);
            }
        });
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
            // Поднимаемся до внешнего узла блока: сам попап позиционируется
            // внутри обёртки, которая переживёт скрытие ребёнка и продолжит
            // перехватывать клики.
            let outer = el;
            let parent = outer.parentElement;
            while (parent && parent.matches && parent.matches(NO_ADS_POPUP_BLOCK_SELECTOR)) {
                outer = parent;
                parent = outer.parentElement;
            }
            hide(outer, { allowButtons: true });
        });
    }

    /* ---------- полноэкранный модал ---------- */

    // Состояние закрытия держим на самом узле: модал создаётся заново на
    // каждый показ, WeakMap не мешает сборщику мусора его забрать.
    const dismissing = new WeakMap();
    // Отдельный список таймеров: WeakMap не обойти, а гасить их при выключении
    // расширения нужно.
    let dismissTimers = [];

    function stopDismissing() {
        dismissTimers.forEach(clearInterval);
        dismissTimers = [];
        removeOverlay();
    }

    function isAdvModal(modal) {
        return modal.classList.contains('adv-focusable') || Boolean(modal.querySelector(ADV_MARKER_SELECTOR));
    }

    // Платформа держит модал смонтированным между показами — пустым, но во всю
    // ширину экрана. Проверять только размер нельзя: из-за этого таймер
    // всплывал при запуске игры, когда никакой рекламы ещё не было.
    //
    // Признак реального показа — отрисованное содержимое внутри: рекламный
    // фрейм, видео или блок РСЯ с id вида ..._R-A-19087429-35_2.
    function isModalShown(modal) {
        const rect = modal.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 100) {
            return false;
        }

        let computed;
        try {
            computed = getComputedStyle(modal);
        } catch (e) {
            return false;
        }
        if (computed.display === 'none' || computed.visibility === 'hidden') {
            return false;
        }

        const content = modal.querySelector('iframe, video, [id*="_R-A-"]');
        if (!content) {
            return false;
        }
        const contentRect = content.getBoundingClientRect();
        return contentRect.width > 0 && contentRect.height > 0;
    }

    // Звук рекламы в скрытом модале продолжает играть. Для медиа в самом
    // документе это лечится, для кросс-доменного iframe — нет.
    function muteMedia(root) {
        root.querySelectorAll('video, audio').forEach(media => {
            media.muted = true;
            media.volume = 0;
        });
    }

    function findCloseButton(modal) {
        const buttons = modal.querySelectorAll(CLOSE_BUTTON_SELECTOR);
        for (const button of buttons) {
            // disabled-кнопку жать бесполезно: рекламный плеер включает её
            // сам, когда отсчитает свои секунды.
            if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
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

    /* ---------- оверлей с таймером ---------- */

    let overlay = null;

    function buildOverlay(onReveal) {
        // Собираем через createElement, а не innerHTML: на странице включены
        // Trusted Types, и строковая разметка может быть отклонена.
        const root = document.createElement('div');
        root.className = 'ygab-overlay';

        const card = document.createElement('div');
        card.className = 'ygab-overlay__card';

        const title = document.createElement('div');
        title.className = 'ygab-overlay__title';
        title.textContent = 'Реклама за награду скрыта';

        const timer = document.createElement('div');
        timer.className = 'ygab-overlay__timer';
        timer.textContent = '—';

        const hint = document.createElement('div');
        hint.className = 'ygab-overlay__hint';
        hint.textContent = 'Награда придёт автоматически';

        const reveal = document.createElement('button');
        reveal.className = 'ygab-overlay__reveal';
        reveal.type = 'button';
        reveal.textContent = 'Показать рекламу';
        reveal.addEventListener('click', onReveal);

        card.append(title, timer, hint, reveal);
        root.append(card);
        document.body.append(root);

        return { root, timer, hint };
    }

    function removeOverlay() {
        if (overlay) {
            overlay.root.remove();
            overlay = null;
        }
    }

    /* ---------- закрытие модала ---------- */

    function dismissModal(modal) {
        if (dismissing.has(modal)) {
            return;
        }

        const rewarded = isRewardedModal(modal);
        const state = { attempts: 0, rewarded, startedAt: Date.now() };
        dismissing.set(modal, state);

        // Гасим визуально, но оставляем в потоке и в отрисовке: рекламный
        // плеер должен считать себя показанным, иначе кнопка закрытия не
        // станет активной и игра останется на паузе за блюром.
        force(modal, 'opacity', '0');
        force(modal, 'pointer-events', 'none');
        muteMedia(modal);

        pageBlocked += 1;
        pendingTotal += 1;
        scheduleTotalFlush();

        if (rewarded) {
            removeOverlay();
            overlay = buildOverlay(() => {
                // Аварийный выход: если отсчёт врёт или награда не приходит,
                // игрок возвращает рекламу и досматривает её сам.
                modal.style.setProperty('opacity', '1', 'important');
                modal.style.setProperty('pointer-events', 'auto', 'important');
                modal.setAttribute(REVEALED_ATTR, '1');
                clearInterval(state.timer);
                dismissing.delete(modal);
                removeOverlay();

                // Метку снимаем, когда показ закончится: узел переиспользуется,
                // и следующую рекламу расширение снова должно скрыть.
                const watcher = setInterval(() => {
                    if (!modal.isConnected || !isModalShown(modal)) {
                        clearInterval(watcher);
                        modal.removeAttribute(REVEALED_ATTR);
                        modal.style.removeProperty('opacity');
                        modal.style.removeProperty('pointer-events');
                    }
                }, DISMISS_INTERVAL_MS);
                dismissTimers.push(watcher);
            });
        }

        // Узел переиспользуется между показами, поэтому состояние обязательно
        // снимаем: иначе следующая реклама в том же модале будет пропущена.
        const finish = () => {
            clearInterval(state.timer);
            dismissing.delete(modal);
            removeOverlay();
        };

        state.timer = setInterval(() => {
            state.attempts += 1;
            const elapsed = Date.now() - state.startedAt;

            // Платформа убрала модал или опустошила его сама — наша работа
            // закончена.
            if (!modal.isConnected || !isModalShown(modal)) {
                finish();
                return;
            }

            muteMedia(modal);

            if (!rewarded) {
                const button = findCloseButton(modal);
                if (button) {
                    button.click();
                }
                // Кнопка так и не сработала: убираем модал силой. Игра может
                // остаться на паузе, но экран будет свободен.
                if (state.attempts >= DISMISS_ATTEMPTS) {
                    modal.style.setProperty('display', 'none', 'important');
                    finish();
                }
                return;
            }

            // Дальше — только реклама за награду.
            //
            // Ранний клик по «Закрыть» отменяет бонус, поэтому ждём. Если
            // платформа рисует отсчёт в самом документе, читаем его; если нет
            // — отсчитываем сами от типичных 15 секунд.
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
            }

            if (elapsed >= REWARDED_MAX_WAIT_MS) {
                modal.style.setProperty('display', 'none', 'important');
                finish();
            }
        }, DISMISS_INTERVAL_MS);
        dismissTimers.push(state.timer);
    }

    function scanFullscreen() {
        if (!settings.fullscreen && !settings.rewarded) {
            return;
        }
        document.querySelectorAll(FULLSCREEN_MODAL_SELECTOR).forEach(modal => {
            if (!isAdvModal(modal) || !isModalShown(modal) || modal.hasAttribute(REVEALED_ATTR)) {
                return;
            }
            const rewarded = isRewardedModal(modal);
            if (rewarded ? settings.rewarded : settings.fullscreen) {
                dismissModal(modal);
            }
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
        if (!settings.enabled || !document.body) {
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
            watchShell();
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

    function startObserver() {
        if (observer) {
            return;
        }
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // SPA-навигация между играми и каталогом: баннер вставляют заново.
        window.addEventListener('popstate', scheduleScan);
        window.addEventListener('pageshow', scheduleScan);
    }

    function stopObserver() {
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
    function buildReport() {
        const banner = document.querySelector(STICKY_SELECTOR);
        const frame = largestFrame();
        const describe = el => el ? {
            tag: el.tagName,
            class: el.getAttribute('class'),
            id: el.id || null,
            // src фрейма игры показывает, покрыт ли его origin в manifest:
            // без этого не понять, доехал ли хук SDK до нужного документа.
            src: el.getAttribute('src'),
            rect: el.getBoundingClientRect().toJSON(),
            inlineStyle: el.getAttribute('style')
        } : null;

        // Если селекторы промахнулись, выручают «подозреваемые»: всё, что
        // похоже на рекламу по классу, id или адресу фрейма. По ним видно,
        // как Яндекс назвал блок на самом деле.
        const suspectRe = /(adv|adfox|rtb|yabs|banner|promo)/i;
        const suspects = Array.from(document.querySelectorAll('div, section, aside, iframe, ins'))
            .filter(el => {
                const className = typeof el.className === 'string' ? el.className : '';
                return suspectRe.test(className) || suspectRe.test(el.id) || suspectRe.test(el.getAttribute('src') || '');
            })
            .slice(0, 20)
            .map(el => ({
                tag: el.tagName,
                class: typeof el.className === 'string' ? el.className : null,
                id: el.id || null,
                src: el.getAttribute('src'),
                rect: el.getBoundingClientRect().toJSON()
            }));

        return {
            url: location.href,
            blockedOnPage: pageBlocked,
            settings,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            // Пусто — значит sdk-hook.js не попал во фрейм игры и реклама
            // через SDK идёт мимо заглушки.
            sdkEvents,
            banner: describe(banner),
            bannerChain: ancestorChain(banner, 5).map(describe),
            gameFrame: describe(frame),
            gameFrameChain: ancestorChain(frame, 5).map(describe),
            // Соседи обёртки — там обычно и лежит боковой рекламный блок.
            frameSiblings: frame && frame.parentElement && frame.parentElement.parentElement
                ? Array.from(frame.parentElement.parentElement.children).map(describe)
                : [],
            suspects,
            bannerHTML: banner ? banner.outerHTML.slice(0, 1500) : null
        };
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (!request) {
                return;
            }
            if (request.action === 'getStats') {
                sendResponse({ blockedOnPage: pageBlocked, isGamePage: isTopGamePage() });
            } else if (request.action === 'getReport') {
                sendResponse({ report: buildReport() });
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') {
            return;
        }
        let dirty = false;
        for (const key of Object.keys(DEFAULTS)) {
            if (key in changes) {
                settings[key] = changes[key].newValue;
                dirty = true;
            }
        }
        if (dirty) {
            applyState();
        }
    });

    chrome.storage.sync.get(DEFAULTS, stored => {
        settings = { ...DEFAULTS, ...stored };
        applyState();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scan, { once: true });
        }
    });
})();
