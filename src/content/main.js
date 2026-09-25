'use strict';

// Точка входа: связь с попапом и чтение настроек.
//
// Загружается последней — к этому моменту всё остальное уже объявлено.

if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || orphaned) {
            return;
        }
        if (request.what === 'ygab:frame-diag') {
            handleHookEvent(request.event);
            return;
        }
        if (request.action === 'getStats') {
            sendResponse({
                blockedOnPage: pageBlocked,
                isGamePage: isTopGamePage(),
                // Попапу нужно знать, есть ли на этой вкладке игра и
                // растягивается ли она: тумблер показывается только там.
                gameId: gameId(),
                isGameApp: isGameAppPage(),
                widthStretch: widthStretchAllowed()
            });
        } else if (request.action === 'getReport') {
            sendResponse({ report: buildReport() });
        }
    });
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || orphaned) {
        return;
    }
    let dirty = false;
    for (const key of Object.keys(DEFAULTS)) {
        if (key in changes) {
            settings[key] = changes[key].newValue;
            dirty = true;
        }
    }
    if (NO_STRETCH_KEY in changes) {
        const next = changes[NO_STRETCH_KEY].newValue;
        noStretchGames = Array.isArray(next) ? next : [];
        dirty = true;
    }
    if (dirty) {
        applyState();
    }
});

callExtension(() => {
    chrome.storage.sync.get({ ...DEFAULTS, [NO_STRETCH_KEY]: [] }, stored => {
        settings = { ...DEFAULTS, ...stored };
        noStretchGames = Array.isArray(stored[NO_STRETCH_KEY]) ? stored[NO_STRETCH_KEY] : [];
        applyState();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', scan, { once: true });
        }
    });
});
