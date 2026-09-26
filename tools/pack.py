"""Упаковка расширения в zip.

Состав берётся из manifest.json: всё, на что он ссылается, плюс README.
Так в архив не попадают черновики (src/core/), отчёты и скриншоты, а новый
файл, подключённый в манифесте, попадает сам.

    python tools/pack.py                    # dist/yandex-games-adblocker-v<версия>.zip
    python tools/pack.py путь/к/архиву.zip  # в указанный файл
    python tools/pack.py --dir build/extension архив.zip
                                            # готовая папка целиком (сборка Cleathernet)

Тот же скрипт вызывает GitHub Actions при выпуске релиза.
"""

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def manifest_files(manifest):
    # LICENSE — GPL требует распространять текст лицензии вместе с программой.
    files = {'manifest.json', 'README.md', 'LICENSE'}
    files.update(manifest.get('icons', {}).values())

    popup = manifest.get('action', {}).get('default_popup')
    if popup:
        # Попап тянет свои css и js из той же папки.
        folder = (ROOT / popup).parent
        files.update(str(p.relative_to(ROOT)).replace('\\', '/') for p in folder.iterdir() if p.is_file())

    worker = manifest.get('background', {}).get('service_worker')
    if worker:
        files.add(worker)

    for script in manifest.get('content_scripts', []):
        files.update(script.get('js', []))
        files.update(script.get('css', []))
    return sorted(files)


def pack_dir(folder, out):
    # Папка уже собрана (dev/build-extension.mjs) — берём всё, что в ней есть.
    if not (folder / 'manifest.json').is_file():
        sys.exit(f'В {folder} нет manifest.json — сначала соберите')
    out.parent.mkdir(parents=True, exist_ok=True)
    # _metadata Chrome пишет сам, когда грузит папку как распакованное
    # расширение (индексы правил, ~14 МБ) — в архиве им не место.
    files = sorted(p for p in folder.rglob('*')
                   if p.is_file() and p.relative_to(folder).parts[0] != '_metadata')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.relative_to(folder).as_posix())
    print(f'{out} — {len(files)} файлов, {out.stat().st_size} байт')


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == '--dir':
        pack_dir((ROOT / sys.argv[2]).resolve(), Path(sys.argv[3]).resolve())
        return
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        ROOT / 'dist' / f"yandex-games-adblocker-v{manifest['version']}.zip"
    out.parent.mkdir(parents=True, exist_ok=True)

    files = manifest_files(manifest)
    missing = [f for f in files if not (ROOT / f).is_file()]
    if missing:
        sys.exit('Нет файлов из манифеста: ' + ', '.join(missing))

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(ROOT / name, name)
    print(f'{out} — {len(files)} файлов, {out.stat().st_size} байт')


if __name__ == '__main__':
    main()
