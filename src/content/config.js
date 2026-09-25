'use strict';

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
