// Фон сборки-обёртки: то, чего нет у расширения для игр.
//
// После установки открываем страницу первого запуска. Она же применяет
// наши настройки движка (platform/setup.js): из фона это сделать нельзя,
// движок принимает такие сообщения только от страниц расширения.

chrome.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') {
        chrome.tabs.create({ url: chrome.runtime.getURL('ygab/platform/welcome/welcome.html') })
            .catch(() => { /* не открылась — настройку сделает попап */ });
    }
});
