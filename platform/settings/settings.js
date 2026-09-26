// Своя страница настроек вместо панели uBO Lite.
//
// Здесь только то, что безопасно менять: дополнительные списки и сайты,
// где расширение выключено. Режимов фильтрации нет намеренно: «Полный»
// прячет приманки детекторов, и нас начинают замечать. Панель uBO Lite
// остаётся в архиве (GPLv3), но мы на неё не ссылаемся.

const OFF_SITES_KEY = 'ygab.offSites';

const ANNOYANCES = [
    ['annoyances-cookies', 'Уведомления о cookie', 'Плашки и окна «Мы используем cookie»'],
    ['annoyances-overlays', 'Окна поверх страницы', 'Подписки, опросы и прочие перекрытия'],
    ['annoyances-notifications', 'Просьбы включить уведомления', 'Окна «Разрешите присылать уведомления»'],
    ['annoyances-social', 'Кнопки и виджеты соцсетей', 'Панели «Поделиться», встроенные ленты'],
    ['annoyances-widgets', 'Чаты поддержки', 'Кнопки онлайн-консультантов в углу'],
    ['annoyances-ai', 'ИИ-помощники', 'Встроенные на сайты чат-боты и подсказки'],
    ['annoyances-others', 'Прочее', 'Всё остальное назойливое; может задеть нужное']
];

const REGIONAL = [
    ['rus-0', 'RU AdList', 'Реклама на русских, украинских, белорусских и казахских сайтах']
];

const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);

let statusTimer = 0;
function status(text) {
    $('status').textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

/* ---------- списки ---------- */

async function setRuleset(id, on) {
    const enabled = await send({ what: 'getEnabledRulesets' });
    const next = on
        ? [...new Set(enabled.concat(id))]
        : enabled.filter(item => item !== id);
    await send({ what: 'applyRulesets', enabledRulesets: next });
}

function renderToggles(list, container, enabled) {
    container.textContent = '';
    for (const [id, name, hint] of list) {
        const item = document.createElement('li');
        item.className = 'toggle';
        const label = document.createElement('label');
        label.className = 'toggle__label';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.ruleset = id;
        box.checked = enabled.includes(id);
        box.addEventListener('change', async () => {
            box.disabled = true;
            try {
                await setRuleset(id, box.checked);
                status(box.checked ? `«${name}» включено` : `«${name}» выключено`);
            } catch (e) {
                box.checked = !box.checked;
                status('Не удалось сохранить');
            } finally {
                box.disabled = false;
            }
        });
        const text = document.createElement('span');
        text.className = 'toggle__text';
        const title = document.createElement('span');
        title.className = 'toggle__name';
        title.textContent = name;
        const small = document.createElement('span');
        small.className = 'toggle__hint';
        small.textContent = hint;
        text.append(title, small);
        label.append(box, text);
        item.append(label);
        container.append(item);
    }
}

/* ---------- где выключено ---------- */

// Выключенные сайты — из двух мест: наш список и сайты без фильтрации у
// движка. Обычно совпадают; расходятся, если сайт выключали в его панели.
async function offSites() {
    const [stored, modes] = await Promise.all([
        chrome.storage.local.get({ [OFF_SITES_KEY]: [] }),
        send({ what: 'getFilteringModeDetails' })
    ]);
    const ours = Array.isArray(stored[OFF_SITES_KEY]) ? stored[OFF_SITES_KEY] : [];
    const engine = (modes && Array.isArray(modes.none) ? modes.none : []).filter(host => host !== 'all-urls');
    return [...new Set(ours.concat(engine))].sort();
}

async function enableSite(host) {
    const level = await send({ what: 'getDefaultFilteringMode' });
    await send({ what: 'setFilteringMode', hostname: host, level });
    const stored = await chrome.storage.local.get({ [OFF_SITES_KEY]: [] });
    const list = Array.isArray(stored[OFF_SITES_KEY]) ? stored[OFF_SITES_KEY] : [];
    await chrome.storage.local.set({ [OFF_SITES_KEY]: list.filter(site => site !== host) });
}

async function renderOffSites() {
    const hosts = await offSites();
    const container = $('offSites');
    container.textContent = '';
    $('offEmpty').hidden = hosts.length !== 0;
    for (const host of hosts) {
        const item = document.createElement('li');
        item.className = 'site-row';
        const name = document.createElement('span');
        name.textContent = host;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'site-row__button';
        button.textContent = 'Включить';
        button.addEventListener('click', async () => {
            button.disabled = true;
            await enableSite(host).catch(() => status('Не удалось включить'));
            status(`На ${host} снова работает`);
            renderOffSites();
        });
        item.append(name, button);
        container.append(item);
    }
}

/* ---------- старт ---------- */

const enabled = await send({ what: 'getEnabledRulesets' });
renderToggles(ANNOYANCES, $('annoyances'), enabled);
renderToggles(REGIONAL, $('regional'), enabled);
renderOffSites();
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && OFF_SITES_KEY in changes) {
        renderOffSites();
    }
});

fetch('../engine.json')
    .then(response => response.json())
    .then(engine => { $('engineVersion').textContent = engine.version; })
    .catch(() => {});
