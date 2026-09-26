// Сборка-обёртка (Э2): официальный uBO Lite + наши файлы поверх.
//
// Решение R3 (docs/research/R3-ubol-integration.md): общий слой — движок
// uBO Lite без правок его кода. Берём его релиз для Chromium, закреплённый
// по версии и SHA-256 в vendor/ubol.json, и кладём сверху:
//   * наши файлы — в /ygab/, чтобы имена не пересекались с его файлами;
//     то, что есть только в этой сборке (страница первого запуска,
//     настройка движка), — из platform/ в /ygab/platform/;
//   * фон — своя точка входа ygab/background.js, которая импортирует его
//     /js/background.js и наш src/background.js;
//   * манифест — его, с нашими именем, иконками, попапом и content scripts.
//
// Его файлы не меняем. Если что-то в его манифесте не сходится с тем, на
// что рассчитана обёртка (появились свои content scripts, другой фон),
// сборка падает: так смена версии uBO Lite не пройдёт незаметно.
//
// Сам uBO Lite в git не хранится: zip скачивается в dev/.cache/ и
// сверяется по хешу. Результат — build/extension (тоже не в git).
//
//   node build-extension.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { checkContract } from './ubol-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'dev', '.cache');
const OUT = path.join(ROOT, 'build', 'extension');
const OURS = 'ygab';

const NAME = 'Cleathernet';
const DESCRIPTION = 'Блокировщик рекламы для всего интернета, с отдельной заботой об Авито, Яндексе и Яндекс.Играх. Движок — uBO Lite (GPLv3).';

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// zip uBO Lite: из кэша, если хеш совпадает, иначе скачиваем заново.
async function vendorZip(pin) {
    const file = path.join(CACHE, `ubol-${pin.version}.zip`);
    if (fs.existsSync(file)) {
        const cached = fs.readFileSync(file);
        if (sha256(cached) === pin.sha256) {
            return cached;
        }
    }
    console.log(`Скачиваю uBO Lite ${pin.version}…`);
    const response = await fetch(pin.url);
    if (!response.ok) {
        throw new Error(`uBO Lite не скачался: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const actual = sha256(buffer);
    if (actual !== pin.sha256) {
        throw new Error(`SHA-256 uBO Lite не совпал: ждали ${pin.sha256}, получили ${actual}`);
    }
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, buffer);
    return buffer;
}

// Распаковка zip без зависимостей: центральный каталог + inflateRaw.
// Zip64 не поддерживаем — архив uBO Lite около 10 МБ.
function unzip(buffer) {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) {
        throw new Error('Не zip: нет конца центрального каталога');
    }
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Битый центральный каталог zip');
        }
        const method = buffer.readUInt16LE(offset + 10);
        const size = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const local = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) {
            continue;
        }
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const raw = buffer.subarray(start, start + size);
        let data;
        if (method === 0) {
            data = raw;
        } else if (method === 8) {
            data = zlib.inflateRawSync(raw);
        } else {
            throw new Error(`Неизвестный метод сжатия ${method} у ${name}`);
        }
        entries.push({ name: name.replace(/\\/g, '/'), data });
    }
    return entries;
}

function writeEntries(entries, dest) {
    // Архив может лежать в одной общей папке — корнем считаем папку с manifest.json.
    const manifest = entries.find(e => e.name === 'manifest.json' || e.name.endsWith('/manifest.json'));
    if (!manifest) {
        throw new Error('В архиве uBO Lite нет manifest.json');
    }
    const base = manifest.name.slice(0, -'manifest.json'.length);
    for (const entry of entries) {
        if (!entry.name.startsWith(base)) {
            continue;
        }
        const relative = entry.name.slice(base.length);
        // _metadata — хеши его файлов от магазина; с нашим манифестом не совпадут.
        if (relative.startsWith('_metadata/')) {
            continue;
        }
        const target = path.resolve(dest, relative);
        if (!target.startsWith(dest + path.sep)) {
            throw new Error(`Путь за пределами сборки: ${entry.name}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
    }
}

// Наши файлы — по тому же правилу, что tools/pack.py: всё, на что ссылается
// наш manifest.json, плюс папка попапа и лицензия.
function ourFiles(manifest) {
    const files = new Set(['LICENSE']);
    Object.values(manifest.icons || {}).forEach(file => files.add(file));
    const popup = manifest.action && manifest.action.default_popup;
    if (popup) {
        const folder = path.dirname(popup);
        for (const name of fs.readdirSync(path.join(ROOT, folder))) {
            if (fs.statSync(path.join(ROOT, folder, name)).isFile()) {
                files.add(`${folder}/${name}`);
            }
        }
    }
    if (manifest.background && manifest.background.service_worker) {
        files.add(manifest.background.service_worker);
    }
    for (const script of manifest.content_scripts || []) {
        (script.js || []).forEach(file => files.add(file));
        (script.css || []).forEach(file => files.add(file));
    }
    return [...files].sort();
}

// Ожидания обёртки от манифеста uBO Lite (R3). Не сошлось — сборка падает.
function checkVendor(theirs) {
    const problems = [];
    if (theirs.manifest_version !== 3) {
        problems.push('manifest_version не 3');
    }
    if (theirs.content_scripts) {
        problems.push('появились статические content_scripts');
    }
    if (!theirs.background || theirs.background.type !== 'module' || theirs.background.service_worker !== '/js/background.js') {
        problems.push('фон не /js/background.js как ES-модуль');
    }
    if (!theirs.declarative_net_request || !Array.isArray(theirs.declarative_net_request.rule_resources)) {
        problems.push('нет declarative_net_request.rule_resources');
    }
    if (fs.existsSync(path.join(OUT, OURS))) {
        problems.push(`в архиве уже есть папка /${OURS}/`);
    }
    if (problems.length) {
        throw new Error('uBO Lite устроен не так, как рассчитывает обёртка: ' + problems.join('; '));
    }
}

const union = (...lists) => [...new Set(lists.flat().filter(Boolean))].sort();
const ours = file => `${OURS}/${file}`;

function mergeManifest(theirs, mine) {
    // Иконка Cleathernet (platform/icons), а не «Y» расширения для игр.
    const icons = Object.fromEntries([16, 32, 48, 128].map(size => [String(size), ours(`platform/icons/icon${size}.png`)]));
    const merged = {
        ...theirs,
        name: NAME,
        short_name: NAME,
        description: DESCRIPTION,
        version: mine.version,
        icons,
        action: {
            default_icon: icons,
            // Общий попап (platform/popup), а не попап расширения для игр.
            default_popup: ours('platform/popup/popup.html'),
            default_title: NAME
        },
        background: { service_worker: ours('background.js'), type: 'module' },
        // Свои настройки вместо панели uBO Lite: там есть режим «Полный»,
        // который прячет приманки детекторов и выдаёт нас. Панель остаётся
        // в архиве (GPLv3), но ссылок на неё нет.
        options_page: ours('platform/settings/settings.html'),
        content_scripts: (mine.content_scripts || []).map(script => ({
            ...script,
            ...(script.js ? { js: script.js.map(ours) } : {}),
            ...(script.css ? { css: script.css.map(ours) } : {})
        })),
        permissions: union(theirs.permissions, mine.permissions),
        // <all_urls> у uBO Lite покрывает наши адреса — без дублей.
        host_permissions: (theirs.host_permissions || []).includes('<all_urls>')
            ? ['<all_urls>']
            : union(theirs.host_permissions, mine.host_permissions)
    };
    delete merged.author;
    // Команды пипетки и «зэппера» движка открывают его окна с его
    // оформлением и видны в chrome://extensions/shortcuts — у нас их нет.
    // Раздел оставляем пустым, а не удаляем: без него Chrome не создаёт
    // chrome.commands, движок падает на старте, а с ним и весь фон.
    merged.commands = {};
    // Постоянный номер расширения: без key Chrome выводит его из пути к
    // папке, и при переносе папки настройки терялись бы.
    merged.key = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'identity.json'), 'utf8')).key;
    return merged;
}

const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'ubol.json'), 'utf8'));
const zip = await vendorZip(pin);

// Повторы: на Windows папку может ещё держать Chrome из только что
// закрытого теста.
fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
fs.mkdirSync(OUT, { recursive: true });
writeEntries(unzip(zip), OUT);

const theirs = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
checkVendor(theirs);
if (theirs.version !== pin.version) {
    throw new Error(`В архиве uBO Lite ${theirs.version}, а в vendor/ubol.json — ${pin.version}`);
}
// Всё, на что наш код опирается внутри движка (dev/ubol-contract.mjs).
const broken = checkContract(OUT);
if (broken.length) {
    throw new Error(`uBO Lite ${pin.version} нарушает договор:\n  - ${broken.join('\n  - ')}`);
}

const mine = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = ourFiles(mine);
for (const file of files) {
    const target = path.join(OUT, OURS, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
}

// platform/ — целиком: там только файлы этой сборки.
fs.cpSync(path.join(ROOT, 'platform'), path.join(OUT, OURS, 'platform'), { recursive: true });
// Значок на панели: движок сам ставит свои img/icon_*.png (обычную и
// серую _off для выключенного сайта) — кладём на их место наши. Код движка
// не трогаем, только картинки.
for (const size of [16, 32, 64, 128]) {
    for (const suffix of ['', '_off']) {
        const target = path.join(OUT, 'img', `icon_${size}${suffix}.png`);
        if (!fs.existsSync(target)) {
            throw new Error(`В uBO Lite нет img/icon_${size}${suffix}.png — проверьте, как он теперь ставит значок`);
        }
        fs.copyFileSync(path.join(ROOT, 'platform', 'icons', `icon${size}${suffix ? '-off' : ''}.png`), target);
    }
}
fs.copyFileSync(path.join(ROOT, 'platform', 'icons', 'icon512.png'), path.join(OUT, 'img', 'icon_512.png'));

// Версия движка — для страницы настроек.
fs.writeFileSync(path.join(OUT, OURS, 'platform', 'engine.json'), JSON.stringify({ name: 'uBO Lite', version: pin.version }) + '\n');

fs.writeFileSync(path.join(OUT, OURS, 'background.js'), [
    '// Точка входа фона сборки-обёртки (dev/build-extension.mjs).',
    '// Сначала движок uBO Lite, потом наш фон. Модули не делят имена, а',
    "// сообщения с двоеточием в what ('ygab:…') uBO Lite пропускает.",
    "import '/js/background.js';",
    `import '/${ours(mine.background.service_worker)}';`,
    `import '/${ours('platform/background.js')}';`,
    ''
].join('\n'));

const merged = mergeManifest(theirs, mine);
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(merged, null, 2) + '\n');

console.log(`build/extension — ${NAME} ${merged.version} на uBO Lite ${pin.version}, наших файлов: ${files.length}`);
