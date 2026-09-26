// Договор с движком: всё, на что наш код опирается внутри uBO Lite.
//
// Мы не правим его код, но пользуемся его внутренностями: именами
// сообщений, диапазонами номеров правил, наборами, путями к иконкам.
// Любое из этого может поменяться в новой версии — и тогда что-то тихо
// перестанет работать. Поэтому сборка (build-extension.mjs) сверяет
// договор с распакованным движком и падает, называя, что именно не
// сошлось. Меняете, на что опирается код, — меняйте и этот файл.
//
// Дальше рубежи такие: тесты сборки (test-build.mjs, test-game-hook.mjs
// --ext), еженедельная проверка новой версии движка в GitHub Actions
// (.github/workflows/ubol-update.yml) и самопроверка в попапе.

import fs from 'node:fs';
import path from 'node:path';

// Сообщения, которые шлют наши страницы (platform/setup.js, popup,
// settings). Движок обрабатывает их в js/background.js через case.
const MESSAGES = [
    'getEnabledRulesets',
    'applyRulesets',
    'setAutoReload',
    'getOptionsPageData',
    'getFilteringMode',
    'setFilteringMode',
    'getDefaultFilteringMode',
    'getFilteringModeDetails'
];

// Наборы, которые мы включаем или показываем в настройках.
const RULESETS = [
    'rus-0',
    'annoyances-cookies',
    'annoyances-overlays',
    'annoyances-notifications',
    'annoyances-social',
    'annoyances-widgets',
    'annoyances-ai',
    'annoyances-others',
    'easylist',
    'ublock-filters'
];

// Фрагменты кода движка, от которых зависит наше поведение.
const SOURCE = [
    // Сообщения с двоеточием ('ygab:…') он пропускает — наши не перехватит.
    ['js/background.js', "request.what.includes(':')", 'пропуск сообщений с двоеточием'],
    // Доверяет только страницам расширения — наши страницы проходят.
    ['js/background.js', 'isTrustedOrigin', 'проверка доверия по origin'],
    // Не стирает динамические правила в 5 000 000 – 7 999 999 (наши — 6 млн).
    ['js/ruleset-manager.js', 'SPECIAL_RULES_REALM = 5000000', 'граница его правил 5 000 000'],
    // 8 000 000+ — «пропускать всё» на выключенных сайтах: попап их не считает.
    ['js/ruleset-manager.js', 'TRUSTED_DIRECTIVE_BASE_RULE_ID = 8000000', 'служебные правила с 8 000 000'],
    ['js/ruleset-manager.js', 'USER_RULES_BASE_RULE_ID = 9000000', 'пользовательские правила с 9 000 000'],
    // Режим сайта 0 — «без фильтрации»: так попап выключает сайт.
    ['js/mode-manager.js', 'MODE_NONE = 0', 'режим 0 — без фильтрации'],
    // Значок он берёт отсюда — сборка кладёт на это место наши картинки.
    ['js/action.js', "'/img/icon_16_off.png'", 'путь к серому значку'],
    ['js/action.js', "'/img/icon_16.png'", 'путь к обычному значку']
];

export function checkContract(dir) {
    const problems = [];
    const read = file => {
        const full = path.join(dir, file);
        return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    };

    const background = read('js/background.js');
    if (background === null) {
        problems.push('нет js/background.js');
    } else {
        for (const name of MESSAGES) {
            if (!background.includes(`case '${name}'`)) {
                problems.push(`движок больше не принимает сообщение '${name}'`);
            }
        }
    }

    for (const [file, fragment, meaning] of SOURCE) {
        const text = read(file);
        if (text === null) {
            problems.push(`нет ${file} (${meaning})`);
        } else if (!text.includes(fragment)) {
            problems.push(`${file}: не найдено «${fragment}» — ${meaning}`);
        }
    }

    const details = read('rulesets/ruleset-details.json');
    if (details === null) {
        problems.push('нет rulesets/ruleset-details.json');
    } else {
        const ids = new Set(JSON.parse(details).map(r => r.id));
        for (const id of RULESETS) {
            if (!ids.has(id)) {
                problems.push(`нет набора '${id}'`);
            }
        }
    }

    // Наш префикс хранилища — только наш.
    for (const file of fs.readdirSync(path.join(dir, 'js')).filter(f => f.endsWith('.js'))) {
        if (/local(Read|Write|Remove)\(\s*['"]ygab\./.test(read(path.join('js', file)))) {
            problems.push(`js/${file}: движок пишет ключ с префиксом ygab.`);
        }
    }
    return problems;
}
