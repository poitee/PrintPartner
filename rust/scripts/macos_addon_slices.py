import os
from pathlib import Path
import shutil
import subprocess
import tempfile


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
