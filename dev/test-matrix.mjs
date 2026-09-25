// Матрица соседей (§6 плана): наше расширение рядом с каждым блокировщиком
// из dev/.neighbors. Для каждого — имитация Игр (работает ли всё) и
// страницы-детекторы (что выдаёт соседа и не выдаёт ли нас).
//
//   node test-matrix.mjs            все соседи
//   node test-matrix.mjs ubol abp   выбранные

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const available = fs.readdirSync(path.join(DEV, '.neighbors'), { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : available;

const run = args => {
    const r = spawnSync(process.execPath, args, { cwd: DEV, encoding: 'utf8', timeout: 240000 });
    return (r.stdout || '') + (r.stderr || '');
};

const rows = [];
for (const neighbor of ['', ...chosen]) {
    const label = neighbor || '(одни мы)';
    const hook = run(['test-game-hook.mjs', ...(neighbor ? ['--neighbor', neighbor] : [])]);
    const total = (hook.match(/Итого: (\d+) из (\d+)/) || []).slice(1).join('/') || '—';
    const failed = hook.split('\n').filter(l => l.startsWith('СБОЙ')).map(l => l.replace(/^СБОЙ\s+/, '').split('  →')[0]);
    const detect = run(['test-detectors.mjs', ...(neighbor ? ['--neighbor', neighbor] : [])]);
    const top = (detect.match(/страница: (\{.*\})/) || [])[1];
    const d = top ? JSON.parse(top) : {};
    const signals = [
        d.bait && 'приманка', d.yandexBait && 'приманка Яндекса', d.adScriptBlocked && 'рекламный скрипт',
        d.patchedNatives && d.patchedNatives !== '—' && 'подмена: ' + d.patchedNatives,
        d.foreignStyleRules && 'стили в документе', d.globals && d.globals !== '—' && 'глобалы: ' + d.globals,
        d.attributes && d.attributes !== '—' && 'атрибуты: ' + d.attributes
    ].filter(Boolean);
    rows.push({ label, total, failed, signals });
    console.log(`${label.padEnd(12)} игры ${total}${failed.length ? ' (сбои: ' + failed.join('; ') + ')' : ''} | детекторы: ${signals.join(', ') || 'ничего'}`);
}
fs.writeFileSync(path.join(DEV, '..', 'docs', 'research', 'neighbor-matrix.json'), JSON.stringify({ date: new Date().toISOString(), rows }, null, 2));
