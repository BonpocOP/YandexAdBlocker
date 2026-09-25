// Прототип движка правил (docs/rules-schema.md) — прогон по снимку страницы.
//
// Не продакшен-код: проверка, что схема выражает нужное и что правила на
// реальной вёрстке находят слот, поднимаются до правильного корня и
// закрывают дыру. Работает без захода на сайт.
//
//   node apply-rules.mjs <page.mhtml> <rules.json> [--neighbor <селекторы.txt>] [--mode ours|neighbor|both]
//
// mode:
//   ours      — только наши правила;
//   neighbor  — только правила соседа (display: none, как у uBO Lite);
//   both      — сначала сосед, потом мы: случай «сосед успел раньше».

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEV = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [file, rulesFile] = argv;
const opt = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const mode = opt('--mode') || 'ours';
// --generic: без правил сайта, только общие признаки рекламы. Правила сайта
// используются лишь как проверяющий: protect показывает, не задели ли мы
// настоящий контент.
const generic = argv.includes('--generic');
const neighborFile = opt('--neighbor');
const rules = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
const neighbor = neighborFile ? fs.readFileSync(neighborFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean) : [];

const browser = await chromium.launch({ executablePath: path.join(DEV, '.browsers', 'chrome-win64', 'chrome.exe'), headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(60000);
    await page.route('**/*', route => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    const result = await page.evaluate(({ rules, neighbor, mode, generic }) => {
        // ---------- общие измерения ----------
        const pageHeight = () => document.documentElement.scrollHeight;
        // Левый край и ширина первого защищённого элемента (карточки): видно,
        // освободилось ли место по горизонтали после скрытия колонки.
        const contentBox = () => {
            for (const sel of rules.protect || []) {
                const el = document.querySelector(sel);
                if (el) { const r = el.getBoundingClientRect(); if (r.width) return { left: Math.round(r.left), width: Math.round(r.width) }; }
            }
            return null;
        };

        function visibleContent(el) {
            if ((el.innerText || '').trim().length > 2) return true;
            for (const m of el.querySelectorAll('img, video, canvas, iframe, svg, picture')) {
                const r = m.getBoundingClientRect();
                if (r.width > 20 && r.height > 20) return true;
            }
            const bg = getComputedStyle(el).backgroundImage;
            return bg && bg !== 'none';
        }

        // Дыры: видимые блоки заметного размера без содержимого.
        function holes() {
            const out = [];
            for (const el of document.body.querySelectorAll('div, section, li, aside')) {
                const r = el.getBoundingClientRect();
                if (r.width < 150 || r.height < 100) continue;
                if (getComputedStyle(el).display === 'none') continue;
                if (visibleContent(el)) continue;
                if (out.some(o => o.contains(el))) continue;
                // Скелетоны догрузки ленты в конце страницы — не реклама.
                if (el.querySelector('[class*="skeleton"], [class*="Skeleton"]')) continue;
                out.push(el);
            }
            return out.map(el => {
                const r = el.getBoundingClientRect();
                return { cls: (el.getAttribute('class') || '').slice(0, 70), size: Math.round(r.width) + 'x' + Math.round(r.height), y: Math.round(r.top + scrollY) };
            });
        }

        // ---------- сосед ----------
        function applyNeighbor() {
            const style = document.createElement('style');
            document.head.append(style);
            for (const s of neighbor) {
                try { style.sheet.insertRule(`${s} { display: none !important; }`, style.sheet.cssRules.length); } catch {}
            }
        }

        // ---------- наш движок ----------
        const HOMO = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };
        function normalize(text) {
            return text.replace(/[​-‍﻿­]/g, '').toLowerCase()
                .replace(/[aeopcxykmthb]/g, ch => HOMO[ch]);
        }
        const listOf = w => (Array.isArray(w) ? { list: w, weight: 2 } : w ? { list: w.list, weight: w.weight ?? 2 } : null);

        const protect = rules.protect || [];
        const isProtected = el => protect.some(sel => { try { return el.matches(sel) || el.querySelector(sel); } catch { return false; } });

        function candidates(find) {
            const found = new Set();
            const sels = listOf(find.selectors);
            if (sels) for (const s of sels.list) document.querySelectorAll(s).forEach(el => found.add(el));
            const links = listOf(find.links);
            if (!sels && links) for (const l of links.list) document.querySelectorAll(`a[href*="${l}"]`).forEach(el => found.add(el));
            return [...found];
        }

        function score(el, find) {
            let total = 0;
            const signals = [];
            const sels = listOf(find.selectors);
            if (sels && sels.list.some(s => el.matches(s) || el.querySelector(s))) { total += sels.weight; signals.push('selector'); }
            const links = listOf(find.links);
            if (links) {
                const hrefs = [el, ...el.querySelectorAll('a[href]')].map(a => a.getAttribute && a.getAttribute('href') || '');
                if (links.list.some(l => hrefs.some(h => h.includes(l)))) { total += links.weight; signals.push('link'); }
            }
            if (find.text) {
                const wanted = find.text.any.map(w => (find.text.homoglyphs ? normalize(w) : w.toLowerCase()));
                const scope = find.text.in ? [...el.querySelectorAll(find.text.in)] : [el, ...el.querySelectorAll('*')];
                const hit = scope.some(node => {
                    const own = [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
                    if (!own || own.length > (find.text.maxLength || 40)) return false;
                    const t = find.text.homoglyphs ? normalize(own) : own.toLowerCase();
                    return wanted.some(w => t.includes(w));
                });
                if (hit) { total += find.text.weight ?? 1; signals.push('text'); }
            }
            return { total, signals };
        }

        function listContainer(parent) {
            if (!parent || parent === document.body) return false;
            const cs = getComputedStyle(parent);
            const flowList = cs.display.includes('grid') ||
                (cs.display.includes('flex') && (cs.flexWrap === 'wrap' || cs.flexDirection.startsWith('column')));
            const kids = parent.children.length;
            const protectedKids = [...parent.children].filter(k => protect.some(s => { try { return k.matches(s); } catch { return false; } })).length;
            return kids >= 3 && (flowList || protectedKids >= 2);
        }

        function findRoot(el, root) {
            const max = root.maxLevels ?? 6;
            if (root.strategy === 'self') return el;
            if (root.strategy === 'closest') {
                const r = el.closest(root.selector);
                return r;
            }
            if (root.strategy === 'grid-item') {
                let node = el;
                for (let i = 0; i <= max && node && node !== document.body; i += 1) {
                    if (listContainer(node.parentElement)) return node;
                    node = node.parentElement;
                }
                return null;
            }
            if (root.strategy === 'overlay') {
                let best = null;
                let node = el;
                for (let i = 0; i <= max && node && node !== document.body; i += 1) {
                    const cs = getComputedStyle(node);
                    const r = node.getBoundingClientRect();
                    if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width * r.height > innerWidth * innerHeight * 0.3) best = node;
                    node = node.parentElement;
                }
                return best;
            }
            return null;
        }

        // ---------- общий механизм, без знания сайта ----------
        // Слова рекламы в именах классов, id и data-атрибутах. Имя режется на
        // слова по дефисам, подчёркиваниям и смене регистра — подстрокой
        // искать нельзя: «ad» сидит в padding, header, gradient.
        const AD_WORDS = new Set(['ad', 'ads', 'adv', 'advert', 'adverts', 'advertising', 'advertisement', 'adfox', 'rtb', 'adsbygoogle', 'sponsored', 'sponsor', 'commercial']);
        const words = value => value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const hasAdWord = el => {
            const values = [el.getAttribute('class') || '', el.id || ''];
            for (const a of el.attributes) if (a.name.startsWith('data-') && a.value.length < 80) values.push(a.value);
            return values.some(v => words(v).some(w => AD_WORDS.has(w)));
        };
        // Рекламные сети: спрятать своё присутствие им сложнее, чем сайту
        // переименовать классы.
        const NETWORK = /an\.yandex\.|yandex\.ru\/ads|adfox|doubleclick|googlesyndication|ad\.mail\.ru|ads\.vk\.com|criteo|taboola|yandexadexchange/i;
        const hasNetwork = el => [...el.querySelectorAll('iframe[src], script[src]')].some(f => NETWORK.test(f.src)) ||
            !!el.querySelector('[id*="_R-A-"], [id^="yandex_rtb"], [id^="adfox_"]');

        function applyGeneric() {
            const report = { candidates: 0, collapsed: [], skipped: {} };
            const skip = why => { report.skipped[why] = (report.skipped[why] || 0) + 1; };
            const done = new Set();
            const all = [...document.body.querySelectorAll('div, section, aside, li, ins')];
            for (const el of all) {
                if (!hasAdWord(el)) continue;
                report.candidates += 1;
                const root = findRoot(el, { strategy: 'grid-item', maxLevels: 6 });
                if (!root) { skip('no-root'); continue; }
                if (done.has(root) || [...done].some(d => d.contains(root))) continue;
                if (getComputedStyle(root).display === 'none') { skip('already-hidden-root'); continue; }
                // Схлопываем только пустой слот или слот с рекламной сетью внутри.
                const empty = !visibleContent(root);
                const network = hasNetwork(root);
                if (!empty && !network) { skip('has-content'); continue; }
                const r = root.getBoundingClientRect();
                if (r.width * r.height < 100 * 50) { skip('tiny'); continue; }
                report.collapsed.push({ cls: (root.getAttribute('class') || '').slice(0, 60), size: Math.round(r.width) + 'x' + Math.round(r.height), why: empty ? 'empty' : 'network' });
                hide(root);
                done.add(root);
            }
            return report;
        }

        // Оценка вреда: сколько защищённых узлов (карточек и т. п.) было видно и
        // сколько осталось.
        const visibleProtected = () => (rules.protect || []).reduce((n, sel) => n + [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length && getComputedStyle(e).display !== 'none').length, 0);

        const touched = [];
        function hide(el) {
            touched.push([el, el.getAttribute('style')]);
            el.style.setProperty('display', 'none', 'important');
        }

        function applyOurs() {
            const report = [];
            const done = new Set();
            for (const slot of rules.slots) {
                if (slot.disabled) continue;
                const row = { id: slot.id, candidates: 0, matched: 0, roots: [], skipped: [] };
                for (const el of candidates(slot.find)) {
                    row.candidates += 1;
                    const s = score(el, slot.find);
                    if (s.total < (slot.score?.threshold ?? 1)) continue;
                    row.matched += 1;
                    const root = findRoot(el, slot.root);
                    if (!root) { row.skipped.push('no-root'); continue; }
                    if (done.has(root) || [...done].some(d => d.contains(root))) continue;
                    if (isProtected(root)) { row.skipped.push('protect-hit'); continue; }
                    const r = root.getBoundingClientRect();
                    const hintOk = slot.root.selector && slot.root.strategy === 'grid-item' ? root.matches(slot.root.selector) : null;
                    row.roots.push({
                        cls: (root.getAttribute('class') || '').slice(0, 70),
                        size: Math.round(r.width) + 'x' + Math.round(r.height),
                        alreadyHidden: getComputedStyle(root).display === 'none' || [...root.querySelectorAll('*')].some(n => getComputedStyle(n).display === 'none'),
                        hintOk,
                        signals: s.signals
                    });
                    if (slot.action !== 'hide' || true) hide(root);
                    done.add(root);
                }
                report.push(row);
            }
            return report;
        }

        const before = { height: pageHeight(), content: contentBox(), holes: holes() };
        if (mode === 'neighbor' || mode === 'both') applyNeighbor();
        const afterNeighbor = mode === 'both' ? { height: pageHeight(), holes: holes() } : null;
        const protectedBefore = visibleProtected();
        const ours = mode === 'ours' || mode === 'both' ? (generic ? applyGeneric() : applyOurs()) : null;
        const after = { height: pageHeight(), content: contentBox(), holes: holes(), protectedBefore, protectedAfter: visibleProtected() };
        return { mode, generic, before, afterNeighbor, ours, after };
    }, { rules, neighbor, mode, generic });

    console.log(JSON.stringify(result, null, 1));
} finally {
    await browser.close();
}
