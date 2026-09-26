// Наши настройки движка uBO Lite по умолчанию.
//
// Менять его конфигурацию можно только сообщениями со страницы расширения:
// он проверяет origin отправителя, а сообщение из service worker самому
// себе не доставляется. Поэтому настройку запускают страницы — первого
// запуска и попап (на случай, если страницу первого запуска закрыли сразу).
//
// Шаги пронумерованы и применяются один раз: сделанный шаг записан в
// хранилище, и если пользователь потом что-то поменяет сам, мы это не
// перезапишем. Новая настройка по умолчанию — новый шаг в конце списка.
//
// Сообщения движок обрабатывает только после своей инициализации, так что
// гонки с его первым запуском (выбор наборов по языку браузера) нет.

const KEY = 'ygab.setup';

const STEPS = [
    {
        id: 1,
        // RU AdList: без него реклама на Авито, Яндексе и других русских
        // сайтах почти не покрыта. uBO Lite включает его сам, только если
        // язык браузера русский (и ещё несколько) — нам он нужен всегда.
        addRulesets: ['rus-0'],
        // Смену режима на сайте делаем без перезагрузки страницы: наш
        // слой откатывается на лету, а про слой движка попап честно
        // говорит «обновите страницу».
        autoReload: false
    },
    {
        id: 2,
        // «Раздражители» — только то, что мешает всем и почти никогда не
        // ломает сайт: уведомления о cookie и всплывающие перекрытия.
        // Соцвиджеты, чаты, уведомления и прочее не трогаем.
        addRulesets: ['annoyances-cookies', 'annoyances-overlays']
    }
];

const send = message => chrome.runtime.sendMessage(message);

async function applyStep(step) {
    if (step.addRulesets && step.addRulesets.length) {
        const enabled = await send({ what: 'getEnabledRulesets' });
        if (!Array.isArray(enabled)) {
            throw new Error('движок не вернул список наборов');
        }
        const wanted = [...new Set(enabled.concat(step.addRulesets))];
        if (wanted.length !== enabled.length) {
            await send({ what: 'applyRulesets', enabledRulesets: wanted });
        }
    }
    if (typeof step.autoReload === 'boolean') {
        await send({ what: 'setAutoReload', state: step.autoReload });
    }
}

// Применить все ещё не сделанные шаги. Возвращает номера применённых.
export async function ensureSetup() {
    const stored = await chrome.storage.local.get(KEY);
    const done = (stored[KEY] && stored[KEY].step) || 0;
    const applied = [];
    for (const step of STEPS) {
        if (step.id <= done) {
            continue;
        }
        await applyStep(step);
        await chrome.storage.local.set({ [KEY]: { step: step.id, at: Date.now() } });
        applied.push(step.id);
    }
    return applied;
}
