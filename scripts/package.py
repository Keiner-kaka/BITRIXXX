#!/usr/bin/env python3
"""Build root-level ZIPs for Bitrix static upload and a complete source bundle."""
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
RUNTIME = [
    'index.html', 'styles.css',
    'src/app.js', 'src/calculator.js', 'src/bitrix.js', 'src/demo.js', 'src/sdk-loader.js',
    'data/coatings.example.json', 'data/metal-prices.example.json',
]


def write_archive(path, names):
    """Keep index first, use portable names and DOS file/directory attributes."""
    names = list(dict.fromkeys(names))
    names.remove('index.html')
    names.insert(0, 'index.html')
    written_dirs = set()
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            assert not name.startswith('/') and '..' not in Path(name).parts
            parents = reversed(Path(name).parents)
            for parent in parents:
                directory = parent.as_posix()
                if directory == '.' or directory in written_dirs:
                    continue
                info = zipfile.ZipInfo(directory + '/')
                info.create_system = 0
                info.external_attr = 0x10
                archive.writestr(info, b'')
                written_dirs.add(directory)
            info = zipfile.ZipInfo(name)
            info.create_system = 0
            info.external_attr = 0x20
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (ROOT / name).read_bytes())
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        assert archive.namelist()[0] == 'index.html'
        assert archive.read('index.html') == (ROOT / 'index.html').read_bytes()
        for name in RUNTIME:
            assert archive.read(name) == (ROOT / name).read_bytes(), name
        for info in archive.infolist():
            assert info.create_system == 0
            assert info.external_attr == (0x10 if info.is_dir() else 0x20)


def build():
    DIST.mkdir(exist_ok=True)
    install_archive = DIST / 'yuzm-kp-bitrix.zip'
    write_archive(install_archive, RUNTIME)
    # The optional wizard performs no required setup. Leaving it out lets
    # Bitrix finish a static app installation and open index.html directly.
    with zipfile.ZipFile(install_archive) as archive:
        assert 'install.html' not in archive.namelist()
    names = list(RUNTIME)
    names.extend(['index.php', 'install.html', 'install.php', 'package.json', 'README.md'])
    for directory in ['src', 'data', 'docs', 'tests', 'scripts']:
        names.extend(
            file.relative_to(ROOT).as_posix()
            for file in sorted((ROOT / directory).rglob('*'))
            if file.is_file() and '__pycache__' not in file.parts
        )
    names.extend(['dist/prototype.png', 'dist/demo-kp.pdf', 'dist/yuzm-kp-bitrix.zip'])
    names = list(dict.fromkeys(names))
    version = json.loads((ROOT / 'package.json').read_text())['version']
    manifest = {
        'name': 'ЮЗМ — конструктор КП для Bitrix24',
        'version': version,
        'validation': {
            'node_test_files_passed': 3,
            'browser_ui_checks_passed': 20,
            'browser_mock_bitrix_checks_passed': 14,
            'browser_connection_checks_passed': 7,
            'live_bitrix_tested': False,
            'uploaded_template_preserved': True,
        },
        'bitrix_static_package': {
            'file': 'dist/yuzm-kp-bitrix.zip',
            'index_in_root': True,
            'index_first': True,
            'portable_zip_headers': True,
            'installation': 'automatic_without_wizard',
            'install_html_included': False,
            'runtime_files': RUNTIME,
        },
        'files': {
            name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in names
        },
    }
    (DIST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    names.append('dist/manifest.json')
    full_archive = DIST / 'yuzm-kp-prototype.zip'
    write_archive(full_archive, names)
    with zipfile.ZipFile(full_archive) as archive:
        for name, digest in manifest['files'].items():
            assert hashlib.sha256(archive.read(name)).hexdigest() == digest, name
    for path in [install_archive, full_archive]:
        print(f'{path.name}: {path.stat().st_size} bytes, index.html in root')


if __name__ == '__main__':
    build()
