// Сборка скриптов страницы в один файл внутри замыкания.
//
// Content scripts одного расширения делят изолированный мир. Пока мы одни,
// 155 наших глобальных объявлений никому не мешают, но рядом встанут скрипты
// uBO Lite (Э2) — и имена начнут сталкиваться. Поэтому src/content/*.js
// склеиваются в порядке из src/content/order.json и заворачиваются в
// (() => { ... })(): наружу не торчит ни одно имя.
//
// Семантика не меняется: файлы и раньше жили в одной области видимости,
// теперь это область функции, а не глобальная.
//
// Результат — src/bundle/content.js — коммитится, чтобы расширение ставилось
// из папки без сборки.
//
//   node build.mjs          собрать
//   node build.mjs --check  проверить, что собранный файл не устарел (для тестов)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'content');
const OUT = path.join(ROOT, 'src', 'bundle', 'content.js');

function bundle() {
    const order = JSON.parse(fs.readFileSync(path.join(SRC, 'order.json'), 'utf8'));
    const present = fs.readdirSync(SRC).filter(name => name.endsWith('.js')).sort();
    const missing = present.filter(name => !order.includes(name));
    if (missing.length) {
        throw new Error('Файлы не указаны в src/content/order.json: ' + missing.join(', '));
    }

    const parts = order.map(name => {
        const text = fs.readFileSync(path.join(SRC, name), 'utf8')
            .replace(/\r\n/g, '\n')
            .replace(/^'use strict';\n/, '');
        return `// ===== src/content/${name} =====\n${text.trimEnd()}\n`;
    });

    return [
        '// Собрано dev/build.mjs из src/content/*.js — не править руками.',
        '// Правки — в исходниках, затем `node dev/build.mjs`.',
        '(() => {',
        "'use strict';",
        '',
        parts.join('\n'),
        '})();',
        ''
    ].join('\n');
}

const text = bundle();
if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) {
        console.error('src/bundle/content.js устарел: запустите node dev/build.mjs');
        process.exit(1);
    }
    console.log('src/bundle/content.js актуален');
} else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    console.log(`src/bundle/content.js — ${text.length} байт`);
}
