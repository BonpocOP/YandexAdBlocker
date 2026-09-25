// Фоновый скрипт.
//
// 1. Пересылает диагностику хука SDK из фрейма игры в верхний документ
//    вкладки, где собирается отчёт. Раньше хук слал её postMessage на '*'
//    прямо в родителя — это видели скрипты Яндекса. Путь через расширение
//    странице не виден.
// 2. Раз в сутки проверяет, не вышла ли новая версия. Магазина у нас нет, и
//    Chrome сам расширение не обновит — пользователь узнаёт о новой версии
//    по метке на значке и ссылке в попапе. Единственный сетевой запрос
//    расширения — к api.github.com, без каких-либо данных о пользователе.

chrome.runtime.onMessage.addListener((request, sender) => {
    if (!request || request.what !== 'ygab:frame-diag' || !sender.tab) {
        return;
    }
    chrome.tabs.sendMessage(sender.tab.id, { what: 'ygab:frame-diag', event: request.event }, { frameId: 0 })
        .catch(() => { /* верхний документ ещё не готов или ушёл — не критично */ });
});

/* ---------- проверка новой версии ---------- */

const RELEASES_URL = 'https://api.github.com/repos/BonpocOP/YandexAdBlocker/releases/latest';
const UPDATE_ALARM = 'ygab:update-check';
const DAY_MINUTES = 24 * 60;

// «1.10.0» новее «1.9.3»: сравниваем по числам, а не строкой.
function isNewer(candidate, current) {
    const a = String(candidate).split('.').map(n => parseInt(n, 10) || 0);
    const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) {
            return diff > 0;
        }
    }
    return false;
}

// Ответ GitHub → состояние в хранилище и метка на значке. Отдельно от
// запроса, чтобы проверять тестом без сети.
async function applyRelease(release) {
    const latest = String((release && release.tag_name) || '').replace(/^v/, '');
    const current = chrome.runtime.getManifest().version;
    const newer = latest !== '' && isNewer(latest, current);
    await chrome.storage.local.set({
        update: newer ? { version: latest, url: release.html_url || '' } : null,
        updateCheckedAt: Date.now()
    });
    await chrome.action.setBadgeText({ text: newer ? '↑' : '' });
    if (newer) {
        await chrome.action.setBadgeBackgroundColor({ color: '#2ea44f' });
        await chrome.action.setTitle({ title: 'Доступна версия ' + latest });
    }
    return newer;
}

async function checkForUpdate() {
    try {
        const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) {
            return;
        }
        await applyRelease(await response.json());
    } catch (e) {
        /* нет сети или GitHub недоступен — проверим в следующий раз */
    }
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: DAY_MINUTES });
    checkForUpdate();
});
chrome.runtime.onStartup.addListener(checkForUpdate);
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === UPDATE_ALARM) {
        checkForUpdate();
    }
});
