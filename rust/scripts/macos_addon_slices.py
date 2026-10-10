import os
from dataclasses import dataclass
from pathlib import Path
from pathlib import PurePosixPath
import shutil
import subprocess
import tempfile


_BETTER_SQLITE3_13_0_3_PREBUILDS = frozenset({
    'darwin-arm64.node',
    'darwin-x64.node',
    'linux-arm64.node',
    'linux-x64.node',
    'linuxmusl-arm64.node',
    'linuxmusl-x64.node',
    'win32-arm64.node',
    'win32-x64.node',
})


@dataclass(frozen=True)
class BetterSqlite3PrebuildSelection:
    selected_name: str
    discard_names: tuple[str, ...]


def select_better_sqlite3_prebuild(prebuild_names, target_architecture):
    names = tuple(prebuild_names)
    inventory = frozenset(names)
    if len(names) != len(inventory) or inventory != _BETTER_SQLITE3_13_0_3_PREBUILDS:
        raise ValueError('Unexpected better-sqlite3 13.0.3 prebuild inventory')
    selected = {
        'arm64': 'darwin-arm64.node',
        'x86_64': 'darwin-x64.node',
    }.get(target_architecture)
    if selected is None:
        raise ValueError('Unsupported addon target architecture')
    return BetterSqlite3PrebuildSelection(
        selected_name=selected,
        discard_names=tuple(sorted(inventory - {selected})),
    )


def better_sqlite3_addon_path(target_architecture):
    selected = select_better_sqlite3_prebuild(
        _BETTER_SQLITE3_13_0_3_PREBUILDS,
        target_architecture,
    )
    return PurePosixPath('node_modules/better-sqlite3/prebuilds') / selected.selected_name


def normalize_addon(addon, architecture, *, lipo='/usr/bin/lipo'):
    addon = Path(addon)
    if architecture not in ('arm64', 'x86_64'):
        raise ValueError('Unsupported addon target architecture')
    if addon.is_symlink() or not addon.is_file():
        raise ValueError('Addon must be a regular staged file')
    architectures = subprocess.check_output([lipo, '-archs', str(addon)], text=True).split()
    if architecture not in architectures:
        raise ValueError('Addon does not contain the target architecture: '+str(addon))
    info = subprocess.check_output([lipo, '-info', str(addon)], text=True)
    if info.startswith('Non-fat file: ') and architectures == [architecture]:
        return False
    if not info.startswith('Architectures in the fat file: '):
        raise ValueError('Expected a native universal addon')
    with tempfile.TemporaryDirectory(prefix='.addon-slice-', dir=addon.parent) as directory:
        candidate = Path(directory) / addon.name
        subprocess.run([lipo, str(addon), '-thin', architecture, '-output', str(candidate)], check=True)
        selected = subprocess.check_output([lipo, '-archs', str(candidate)], text=True).split()
        selected_info = subprocess.check_output([lipo, '-info', str(candidate)], text=True)
        if selected != [architecture] or not selected_info.startswith('Non-fat file: '):
            raise ValueError('Selected addon must be one thin target slice')
        shutil.copystat(addon, candidate)
        os.replace(candidate, addon)
    return True
