// Попап сборки Cleathernet.
//
// Главное — «работает на этом сайте»: одна кнопка выключает оба слоя.
//   * Движок uBO Lite: режим сайта «без фильтрации» (level 0). Новые
//     запросы сразу идут без блокировки, но его CSS и скриптлеты уже на
//     странице — они уйдут после перезагрузки, об этом честная строка.
//   * Наш слой: хост попадает в ygab.offSites, content script и frame.js
//     видят это через storage.onChanged и откатывают свои правки на лету.
// Настройки Яндекс.Игр показываются только там, где работает их слой.

import { ensureSetup } from '../setup.js';

const OFF_SITES_KEY = 'ygab.offSites';
const NO_STRETCH_KEY = 'noStretchGames';
const GAME_KEYS = { sticky: true, fullscreen: true, catalog: true };
const MODE_NONE = 0;

const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);

// Страница первого запуска могла не успеть — донастраиваем здесь.
ensureSetup().catch(() => { /* повторим при следующем открытии */ });

// ?tab=<id> — открыть попап для другой вкладки: так его открывают тесты
// (страница расширения во вкладке сама была бы активной вкладкой).
const forcedTab = Number(new URLSearchParams(location.search).get('tab')) || 0;
const tab = forcedTab
    ? await chrome.tabs.get(forcedTab).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
const url = tab && tab.url ? new URL(tab.url) : null;
const isWeb = Boolean(url && /^https?:$/.test(url.protocol));
// www. не различаем: выключили на www.avito.ru — выключено и на avito.ru.
const host = isWeb ? url.hostname.replace(/^www\./, '') : '';

const covers = (site, hostname) => hostname === site || hostname.endsWith('.' + site);

// Список — в local, как и выключенные сайты движка (см. content/config.js).
async function offSites() {
    const stored = await chrome.storage.local.get({ [OFF_SITES_KEY]: [] });
    return Array.isArray(stored[OFF_SITES_KEY]) ? stored[OFF_SITES_KEY] : [];
}

/* ---------- сайт ---------- */

async function siteState() {
    const [level, list] = await Promise.all([
        send({ what: 'getFilteringMode', hostname: host }),
        offSites()
    ]);
    return { engineOff: level === MODE_NONE, oursOff: list.some(site => covers(site, host)) };
}

function renderSite(state, justChanged, alsoEnabled = []) {
    const on = !state.engineOff && !state.oursOff;
    $('siteOn').checked = on;
    $('site').classList.toggle('site_off', !on);
    $('siteState').textContent = on ? 'Работает на этом сайте' : 'Выключено на этом сайте';
    $('options').classList.toggle('options_disabled', !on);

    // Строка про перезагрузку — только после переключения: при обычном
    // открытии попапа она ни к чему.
    const note = $('siteNote');
    if (!justChanged) {
        note.hidden = true;
        return;
    }
    const parents = alsoEnabled.filter(site => site !== host);
    $('siteNoteText').textContent = on
        ? (parents.length ? `Включено на всём ${parents.join(', ')}. ` : 'Включено. ') + 'Реклама, которая уже на странице, скроется после обновления.'
        : 'Наши правки убраны. Чтобы вернулось то, что не загрузилось, обновите страницу.';
    note.hidden = false;
}

// Значок движок перекрашивает только при загрузке страницы (его скрипт на
// выключенном сайте сообщает об этом) — меняем сразу, чтобы серая «C»
// появлялась в момент выключения. Картинки — наши, на месте его img/.
const icon = on => Object.fromEntries([16, 32, 64, 128].map(size => [size, `/img/icon_${size}${on ? '' : '_off'}.png`]));

// Возвращает сайты, выключение которых сняли (сам сайт и его родители).
async function setSite(on) {
    const list = await offSites();
    let enabled = [];
    if (on) {
        // Движок не даёт включить поддомен, пока выключен родительский
        // домен, — поэтому включаем и все записи, которые накрывают сайт,
        // у движка и у нас одинаково.
        const level = await send({ what: 'getDefaultFilteringMode' });
        const modes = await send({ what: 'getFilteringModeDetails' });
        const engineOff = (modes && Array.isArray(modes.none) ? modes.none : []).filter(site => site !== 'all-urls');
        enabled = [...new Set(engineOff.concat(list).filter(site => covers(site, host)).concat(host))];
        for (const site of enabled) {
            await send({ what: 'setFilteringMode', hostname: site, level });
        }
        await chrome.storage.local.set({ [OFF_SITES_KEY]: list.filter(site => !covers(site, host)) });
    } else {
        await send({ what: 'setFilteringMode', hostname: host, level: MODE_NONE });
        if (!list.includes(host)) {
            await chrome.storage.local.set({ [OFF_SITES_KEY]: list.concat(host) });
        }
    }
    if (tab && tab.id) {
        chrome.action.setIcon({ tabId: tab.id, path: icon(on) }).catch(() => {});
    }
    return enabled;
}

$('siteOn').addEventListener('change', async () => {
    const input = $('siteOn');
    input.disabled = true;
    let enabled = [];
    try {
        enabled = await setSite(input.checked);
    } finally {
        renderSite(await siteState(), true, enabled);
        input.disabled = false;
    }
});

$('reloadTab').addEventListener('click', () => {
    if (tab && tab.id) {
        chrome.tabs.reload(tab.id);
        window.close();
    }
});

// Самопроверка: движок отвечает на сообщения. Если нет (сломался после
// обновления или не запустился) — говорим прямо, а не делаем вид, что всё
// работает.
const engineAlive = typeof await send({ what: 'getDefaultFilteringMode' }).catch(() => undefined) === 'number';

if (isWeb && !engineAlive) {
    $('host').textContent = host;
    $('siteState').textContent = 'Фильтры не отвечают — перезапустите браузер или переустановите расширение';
    $('site').classList.add('site_off');
} else if (isWeb) {
    $('host').textContent = host;
    renderSite(await siteState(), false);
    $('siteOn').disabled = false;
} else {
    $('host').textContent = url ? url.protocol.replace(/:$/, '') : 'Эта вкладка';
    $('siteState').textContent = 'На служебных страницах браузера расширение не работает';
}

function ask(action) {
    return chrome.tabs.sendMessage(tab.id, { action }, { frameId: 0 }).catch(() => null);
}

/* ---------- Яндекс.Игры ---------- */

const stats = isWeb && tab.id ? await ask('getStats') : null;
if (stats) {
    $('games').hidden = false;

    const stored = await chrome.storage.sync.get(GAME_KEYS);
    for (const key of Object.keys(GAME_KEYS)) {
        $(key).checked = stored[key] !== false;
        $(key).addEventListener('change', () => chrome.storage.sync.set({ [key]: $(key).checked }));
    }

    // Растягивание по ширине — для каждой игры отдельно.
    if (stats.isGameApp && stats.gameId) {
        $('stretchOption').hidden = false;
        $('widthStretch').checked = stats.widthStretch !== false;
        $('gameHint').textContent = 'Только для этой игры (#' + stats.gameId + ')';
        $('widthStretch').addEventListener('change', async () => {
            const current = await chrome.storage.sync.get({ [NO_STRETCH_KEY]: [] });
            const list = Array.isArray(current[NO_STRETCH_KEY]) ? current[NO_STRETCH_KEY] : [];
            const next = $('widthStretch').checked
                ? list.filter(id => id !== stats.gameId)
                : list.concat(list.includes(stats.gameId) ? [] : [stats.gameId]);
            chrome.storage.sync.set({ [NO_STRETCH_KEY]: next });
        });
    }
}

/* ---------- сообщить о проблеме ---------- */

// Флажки «что ещё включено» — только для отчёта.
const envInputs = Array.from(document.querySelectorAll('[data-env]'));
const { environmentFlags = {} } = await chrome.storage.local.get({ environmentFlags: {} });
envInputs.forEach(input => {
    input.checked = Boolean(environmentFlags[input.dataset.env]);
    input.addEventListener('change', () => {
        const flags = {};
        envInputs.forEach(item => { flags[item.dataset.env] = item.checked; });
        chrome.storage.local.set({ environmentFlags: flags });
    });
});

// Отчёт на любом сайте: что за страница, что включено у движка, что
// сработало. На Яндекс.Играх к нему добавляется подробный отчёт их слоя.
async function buildReport() {
    const manifest = chrome.runtime.getManifest();
    const report = {
        product: manifest.name,
        version: manifest.version,
        url: tab && tab.url ? tab.url : null,
        browser: navigator.userAgent,
        language: navigator.language,
        environmentFlags: Object.fromEntries(envInputs.map(input => [input.dataset.env, input.checked]))
    };
    if (isWeb) {
        const [level, defaultLevel, rulesets, state] = await Promise.all([
            send({ what: 'getFilteringMode', hostname: host }),
            send({ what: 'getDefaultFilteringMode' }),
            send({ what: 'getEnabledRulesets' }),
            siteState()
        ]);
        report.engine = { level, defaultLevel, rulesets };
        report.site = { host, ...state };
        }
    const games = isWeb && tab.id ? await ask('getReport') : null;
    if (games && games.report) {
        report.games = games.report;
    }
    return report;
}

$('report').addEventListener('click', async () => {
    const button = $('report');
    let text;
    try {
        await navigator.clipboard.writeText(JSON.stringify(await buildReport(), null, 2));
        text = 'Скопировано — пришлите разработчику';
    } catch (e) {
        text = 'Не удалось скопировать';
    }
    button.textContent = text;
    setTimeout(() => { button.textContent = 'Скопировать отчёт'; }, 2000);
});

/* ---------- прочее ---------- */

$('advanced').addEventListener('click', event => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
});

// Новая версия: её находит фон (src/background.js).
const { 'ygab.update': update } = await chrome.storage.local.get({ 'ygab.update': null });
if (update && update.version) {
    $('update').textContent = 'Доступна версия ' + update.version + ' — скачать';
    $('update').href = update.url || 'https://github.com/BonpocOP/YandexAdBlocker/releases/latest';
    $('update').hidden = false;
}
