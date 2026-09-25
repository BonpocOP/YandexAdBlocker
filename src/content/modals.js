'use strict';

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
