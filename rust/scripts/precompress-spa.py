import argparse
import gzip
import json
import pathlib
import shutil
import tempfile
import zlib


COMPRESSIBLE = frozenset({'.html', '.js', '.mjs', '.css', '.svg', '.json', '.map', '.wasm', '.txt'})


def asset_pairs(root):
    paths = sorted(root.rglob('*'))
    for path in paths:
        if path.is_symlink():
            raise ValueError('SPA asset symlink: ' + path.relative_to(root).as_posix())
    if not (root / 'index.html').is_file():
        raise ValueError('Missing SPA entrypoint: index.html')
    identities = [path for path in paths if path.is_file()
                  and path.suffix in COMPRESSIBLE and path.name != 'desktop-build.json']
    pairs = {path: path.with_name(path.name + '.gz') for path in identities}
    variants = set(pairs.values())
    for path in paths:
        if path.suffix == '.gz' and path not in variants:
            raise ValueError('Orphan gzip variant: ' + path.relative_to(root).as_posix())
    return pairs


def verify_pair(root, identity, variant):
    relative = identity.relative_to(root).as_posix()
    if not variant.is_file():
        raise ValueError('Missing gzip variant: ' + relative)
    try:
        with identity.open('rb') as source, gzip.open(variant, 'rb') as encoded:
            while True:
                original = source.read(65536)
                decoded = encoded.read(len(original) or 1)
                if decoded != original:
                    raise ValueError('Gzip content mismatch: ' + relative)
                if not original:
                    break
    except (OSError, EOFError, zlib.error) as error:
        raise ValueError('Invalid gzip variant: ' + relative) from error


def package(root, validate_only=False):
    root = root.resolve(strict=True)
    pairs = asset_pairs(root)
    for identity, variant in pairs.items():
        if variant.exists() or validate_only:
            verify_pair(root, identity, variant)
    if not validate_only:
        for identity, variant in pairs.items():
            if variant.exists():
                continue
            with tempfile.NamedTemporaryFile(dir=identity.parent, delete=False) as output:
                temporary = pathlib.Path(output.name)
                try:
                    with identity.open('rb') as source, gzip.GzipFile(
                        filename='', mode='wb', fileobj=output, compresslevel=9, mtime=0
                    ) as encoded:
                        shutil.copyfileobj(source, encoded, length=65536)
                    output.close()
                    temporary.replace(variant)
                finally:
                    temporary.unlink(missing_ok=True)
            verify_pair(root, identity, variant)
    return {'assets': len(pairs), 'encoding': 'gzip'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.root, args.validate), sort_keys=True))
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')
