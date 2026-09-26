// Какой Chrome запускают тесты.
//
// Локально — Chrome for Testing из dev/.browsers (обычный Chrome с версии
// 137 не грузит расширения из командной строки). На серверах GitHub
// Actions его нет: там YGAB_CHROME=bundled — Chromium, который ставит
// Playwright (`npx playwright install chromium`), в режиме channel
// 'chromium' — он, в отличие от облегчённого headless-shell, грузит
// расширения. Или YGAB_CHROME=<путь к chrome>.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));

export function browserOptions() {
    const chosen = process.env.YGAB_CHROME;
    if (chosen === 'bundled') {
        return { channel: 'chromium' };
    }
    return { executablePath: chosen || path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe') };
}
