import argparse
import gzip
import json
import pathlib
import shutil
import tempfile
import zlib


COMPRESSIBLE = frozenset({'.html', '.js', '.mjs', '.css', '.svg', '.json', '.map', '.wasm', '.txt'})


def checked_root(root, boundary):
    root = root.absolute()
    if root.is_symlink():
        raise ValueError('SPA asset symlink: ' + root.name)
    boundary = (boundary or root.parent).absolute()
    try:
        relative = root.relative_to(boundary)
    except ValueError as error:
        raise ValueError('SPA root outside trusted boundary') from error
    if '..' in relative.parts:
        raise ValueError('SPA root outside trusted boundary')
    trusted = boundary.resolve(strict=True)
    current = trusted
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('SPA asset symlink: ' + current.relative_to(trusted).as_posix())
    return current.resolve(strict=True)


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


def package(root, validate_only=False, boundary=None):
    root = checked_root(root, boundary)
    pairs = asset_pairs(root)
    for identity, variant in pairs.items():
        if variant.exists() or validate_only:
            verify_pair(root, identity, variant)
    if not validate_only:
        for identity, variant in pairs.items():
            with tempfile.NamedTemporaryFile(dir=identity.parent, delete=False) as output:
                temporary = pathlib.Path(output.name)
                try:
                    with identity.open('rb') as source, gzip.GzipFile(
                        filename='', mode='wb', fileobj=output, compresslevel=9, mtime=0
                    ) as encoded:
                        shutil.copyfileobj(source, encoded, length=65536)
                    output.close()
                    temporary.chmod(identity.stat().st_mode & 0o666)
                    temporary.replace(variant)
                finally:
                    temporary.unlink(missing_ok=True)
            verify_pair(root, identity, variant)
    return {'assets': len(pairs), 'encoding': 'gzip'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=pathlib.Path)
    parser.add_argument('--validate', action='store_true')
    parser.add_argument('--boundary', type=pathlib.Path,
                        help='Trusted parent tree; defaults to the asset root parent')
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.root, args.validate, args.boundary), sort_keys=True))
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')
