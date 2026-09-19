// Попап только читает и пишет настройки; всю работу делает content-script.
(() => {
    'use strict';

    const DEFAULTS = {
        enabled: true,
        sticky: true,
        fullscreen: true,
        rewarded: true,
        catalog: true
    };

    const KEYS = Object.keys(DEFAULTS);
    const inputs = {};
    KEYS.forEach(key => {
        inputs[key] = document.getElementById(key);
    });

    const statusEl = document.getElementById('status');
    const optionsEl = document.getElementById('options');
    const pageCountEl = document.getElementById('pageCount');
    const totalCountEl = document.getElementById('totalCount');

    function setStatus(text, isWarning) {
        statusEl.textContent = text;
        statusEl.classList.toggle('status_warn', Boolean(isWarning));
    }

    function reflectMasterSwitch() {
        // Частные тумблеры без общего смысла не имеют — гасим их визуально.
        optionsEl.classList.toggle('options_disabled', !inputs.enabled.checked);
    }

    function activeTab() {
        return new Promise(resolve => {
            chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null));
        });
    }

    // Content-script есть не на каждой вкладке, поэтому ошибку связи гасим и
    // возвращаем null вместо исключения.
    function ask(tabId, action) {
        return new Promise(resolve => {
            chrome.tabs.sendMessage(tabId, { action }, response => {
                void chrome.runtime.lastError;
                resolve(response || null);
            });
        });
    }

    async function refreshStats() {
        chrome.storage.local.get({ totalBlocked: 0 }, ({ totalBlocked }) => {
            totalCountEl.textContent = Number(totalBlocked) || 0;
        });

        const tab = await activeTab();
        if (!tab || !tab.id) {
            setStatus('Вкладка недоступна', true);
            return;
        }

        const stats = await ask(tab.id, 'getStats');
        if (!stats) {
            setStatus('Откройте yandex.ru/games — здесь расширение не работает', true);
            pageCountEl.textContent = '0';
            return;
        }

        pageCountEl.textContent = stats.blockedOnPage;
        setStatus(inputs.enabled.checked ? 'Блокировка активна' : 'Блокировка выключена', !inputs.enabled.checked);
    }

    function bindInputs() {
        KEYS.forEach(key => {
            inputs[key].addEventListener('change', () => {
                chrome.storage.sync.set({ [key]: inputs[key].checked }, () => {
                    reflectMasterSwitch();
                    refreshStats();
                });
            });
        });
    }

    document.getElementById('reload').addEventListener('click', async () => {
        const tab = await activeTab();
        if (tab && tab.id) {
            chrome.tabs.reload(tab.id);
            window.close();
        }
    });

    // Отчёт нужен, когда Яндекс поменял вёрстку: по нему правятся селекторы.
    document.getElementById('report').addEventListener('click', async () => {
        const button = document.getElementById('report');
        const tab = await activeTab();
        const response = tab && tab.id ? await ask(tab.id, 'getReport') : null;

        if (!response || !response.report) {
            button.textContent = 'Нет данных';
            setTimeout(() => { button.textContent = 'Скопировать отчёт'; }, 1500);
            return;
        }

        try {
            await navigator.clipboard.writeText(JSON.stringify(response.report, null, 2));
            button.textContent = 'Скопировано';
        } catch (e) {
            button.textContent = 'Не удалось';
        }
        setTimeout(() => { button.textContent = 'Скопировать отчёт'; }, 1500);
    });

    chrome.storage.sync.get(DEFAULTS, stored => {
        KEYS.forEach(key => {
            inputs[key].checked = stored[key] !== false;
        });
        reflectMasterSwitch();
        bindInputs();
        refreshStats();
    });
})();
