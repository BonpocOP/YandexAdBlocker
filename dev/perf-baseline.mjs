// Замер R6: сколько процессорного времени расходует наше расширение.
//
// Открывает страницу с загруженным расширением, даёт ей устояться, затем
// включает профилировщик V8 на странице и во фреймах других процессов
// (фрейм игры — на своём домене) и складывает собственное время всех функций,
// чей код лежит в chrome-extension://. Так видна именно наша доля, а не
// тяжесть самой игры.
//
//   node perf-baseline.mjs                      игра из отчёта, 30 с замера
//   node perf-baseline.mjs --url <адрес> --seconds 60

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const BROWSER = path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe');

function parseArgs(argv) {
    const args = {
        url: 'https://yandex.ru/games/app/602493',
        seconds: 30,
        settle: 20
    };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--url') args.url = argv[++i];
        else if (argv[i] === '--seconds') args.seconds = Number(argv[++i]);
        else if (argv[i] === '--settle') args.settle = Number(argv[++i]);
    }
    return args;
}

// Собственное время функций из профиля V8, по адресам скриптов.
function selfTimeByUrl(profile) {
    const byId = new Map(profile.nodes.map(node => [node.id, node]));
    const counts = new Map();
    for (const id of profile.samples) {
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    const intervals = profile.timeDeltas;
    const avgMs = intervals.length
        ? intervals.reduce((a, b) => a + b, 0) / intervals.length / 1000
        : 0;
    const byUrl = new Map();
    for (const [id, count] of counts) {
        const url = byId.get(id).callFrame.url || '(native)';
        byUrl.set(url, (byUrl.get(url) || 0) + count * avgMs);
    }
    return byUrl;
}

async function profileTarget(session, seconds) {
    await session.send('Profiler.enable');
    await session.send('Profiler.setSamplingInterval', { interval: 200 });
    await session.send('Profiler.start');
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    const { profile } = await session.send('Profiler.stop');
    return selfTimeByUrl(profile);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ygab-perf-'));
    const context = await chromium.launchPersistentContext(profileDir, {
        executablePath: BROWSER,
        headless: true,
        viewport: { width: 1600, height: 900 },
        locale: 'ru-RU',
        args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT]
    });

    try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log(`Страница открыта, ждём ${args.settle} с, пока устоится…`);
        await page.waitForTimeout(args.settle * 1000);

        // Главный документ и все фреймы из других процессов.
        const targets = [{ name: 'страница', session: await context.newCDPSession(page) }];
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            try {
                targets.push({ name: 'фрейм ' + new URL(frame.url()).hostname, session: await context.newCDPSession(frame) });
            } catch {
                // Фрейм того же процесса — его покрывает профиль страницы.
            }
        }

        console.log(`Профилируем ${args.seconds} с: ${targets.map(t => t.name).join(', ')}`);
        const results = await Promise.all(targets.map(async target => ({
            name: target.name,
            byUrl: await profileTarget(target.session, args.seconds)
        })));

        const report = { url: args.url, seconds: args.seconds, date: new Date().toISOString(), targets: [] };
        for (const { name, byUrl } of results) {
            let ours = 0;
            let total = 0;
            const oursByFile = {};
            for (const [url, ms] of byUrl) {
                if (url === '(idle)' || url === '(program)' || url === '(garbage collector)') continue;
                total += ms;
                if (url.startsWith('chrome-extension://')) {
                    ours += ms;
                    const file = url.replace(/^chrome-extension:\/\/[^/]+\//, '');
                    oursByFile[file] = Math.round((oursByFile[file] || 0) + ms);
                }
            }
            report.targets.push({
                name,
                oursMs: Math.round(ours),
                oursMsPerSecond: Math.round(ours / args.seconds * 10) / 10,
                pageScriptMs: Math.round(total),
                oursShare: total ? Math.round(ours / total * 1000) / 10 + '%' : null,
                oursByFile
            });
        }
        console.log(JSON.stringify(report, null, 2));
        const out = path.join(ROOT, 'docs', 'research', 'R6-perf-baseline.json');
        await fs.writeFile(out, JSON.stringify(report, null, 2));
        console.log('Сохранено: ' + out);
    } finally {
        await context.close();
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
