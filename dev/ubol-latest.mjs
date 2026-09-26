// Есть ли новая версия uBO Lite — для еженедельной проверки в GitHub
// Actions (.github/workflows/ubol-update.yml).
//
// Берёт последний релиз uBlockOrigin/uBOL-home, находит архив для
// Chromium и его SHA-256 (GitHub отдаёт его в поле digest; если нет —
// скачивает и считает сам). Если версия новее закреплённой в
// vendor/ubol.json — переписывает файл. В GITHUB_OUTPUT пишет changed и
// version, чтобы сценарий знал, собирать ли и тестировать.
//
//   node ubol-latest.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = path.join(ROOT, 'vendor', 'ubol.json');

const headers = { Accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
}

function output(values) {
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
    }
    process.stdout.write(lines);
}

const response = await fetch('https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest', { headers });
if (!response.ok) {
    throw new Error(`GitHub API: HTTP ${response.status}`);
}
const release = await response.json();
const asset = (release.assets || []).find(a => /\.chromium\.zip$/.test(a.name));
if (!asset) {
    throw new Error(`В релизе ${release.tag_name} нет архива для Chromium`);
}

const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
const version = release.tag_name;
if (version === pin.version) {
    output({ changed: 'false', version });
    process.exit(0);
}

let sha256 = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
if (!sha256) {
    const file = await fetch(asset.browser_download_url);
    if (!file.ok) {
        throw new Error(`Архив не скачался: HTTP ${file.status}`);
    }
    sha256 = crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
}

fs.writeFileSync(PIN, JSON.stringify({ version, url: asset.browser_download_url, sha256 }, null, 2) + '\n');
output({ changed: 'true', version, previous: pin.version });
