"""Check the manifest's no-writer claims against Rust source, without compiling it."""
import json
from pathlib import Path
import re
import sys


# Strings stay whole; comments cannot supply path or write evidence.
TOKEN = re.compile(
    r'//[^\n]*|/\*|(?:br|r)(?P<hashes>\#*)".*?"(?P=hashes)'
    r'|b?"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])\''
    r'|[A-Za-z_][A-Za-z_0-9]*|::|[^\s]', re.S,
)


def tokens(source):
    result = []
    position = 0
    while match := TOKEN.search(source, position):
        value = match.group()
        position = match.end()
        if value == '/*':
            depth = 1
            while depth:
                comment = re.search(r'/\*|\*/', source[position:])
                if comment is None:
                    raise AssertionError('unterminated Rust comment')
                depth += 1 if comment.group() == '/*' else -1
                position += comment.end()
        elif not value.startswith('//'):
            result.append(value)
    return result


def closing(items, start):
    pairs = {'(': ')', '[': ']', '{': '}'}
    stack = []
    for index in range(start, len(items)):
        token = items[index]
        if token in pairs:
            stack.append(pairs[token])
        elif stack and token == stack[-1]:
            stack.pop()
            if not stack:
                return index
    raise AssertionError(f'unclosed group at {items[start:start + 8]}')


def non_test_source(path):
    """Remove cfg(test) items and identify their out-of-line module files."""
    items = tokens(path.read_text())
    result, excluded = [], []
    index = 0
    while index < len(items):
        if items[index:index + 7] != ['#', '[', 'cfg', '(', 'test', ')', ']']:
            result.append(items[index])
            index += 1
            continue
        end = index + 7
        # Fields and expression attributes carry no standalone item body.
        if items[end].isidentifier() and items[end + 1] == ':':
            index += 7
            continue
        while items[end] not in (';', '{'):
            end += 1
        declaration = items[index:end]
        if 'mod' in declaration and items[end] == ';':
            name = declaration[declaration.index('mod') + 1]
            base = path.parent if path.stem in ('lib', 'main', 'mod') else path.with_suffix('')
            if 'path' in declaration:
                literal = declaration[declaration.index('path') + 2]
                excluded.append(path.parent / literal.strip('"'))
            else:
                excluded.extend([base / f'{name}.rs', base / name])
        index = closing(items, end) + 1 if items[end] == '{' else end + 1
    return result, excluded


# GRE-402-remaining-scope.md defines these paths. A manifests directory is a
# candidate even when its filename is computed later; catalog stems are reserved.
PATTERNS = {
    'source-covers': r'(?:^|/)covers(?:/|$)',
    'kit-catalog': r'(?:^|/)kit-catalog\.(?:json|yaml)$',
    'path-hints': r'(?:^|/)path-hints\.yaml$',
    'community-manifests': r'(?:^|/)manifests(?:/(?!kit-catalog\.(?:json|yaml)$)|$)',
}


def path_families(token):
    text = re.sub(r'^(?:br|r|b)?#*"|"#*$', '', token).replace('\\', '/')
    return {family for family, pattern in PATTERNS.items() if re.search(pattern, text)}


def arguments(items, start):
    end = closing(items, start)
    result, begin, index = [], start + 1, start + 1
    while index < end:
        if items[index] in ('(', '[', '{'):
            index = closing(items, index) + 1
        elif items[index] == ',':
            result.append(items[begin:index])
            begin = index = index + 1
        else:
            index += 1
    if begin < end:
        result.append(items[begin:end])
    return result


def writers(items):
    """Conservative file-local provenance, including constants and path aliases.

    This is a lexical guard, not interprocedural analysis. Computed paths and
    wrappers that hide both the family and the write still require review.
    """
    bindings = {}
    assignments = []
    for index, token in enumerate(items):
        if token != '=' or index == 0:
            continue
        end = index + 1
        while end < len(items) and items[end] != ';':
            end += 1
        # const NAME: Type = ... and let name = ...
        begin = index - 1
        while begin > 0 and items[begin - 1] not in (';', '{', '}'):
            begin -= 1
        left = items[begin:index]
        if 'const' in left:
            name = left[left.index('const') + 1]
        elif 'let' in left:
            offset = left.index('let') + 1
            name = left[offset + (left[offset] == 'mut')]
        elif items[index - 1].isidentifier():
            name = items[index - 1]
        else:
            continue
        assignments.append((name, items[index + 1:end]))

    def families(expression):
        return set().union(*(path_families(t) | bindings.get(t, set()) for t in expression))

    changed = True
    while changed:
        changed = False
        for name, expression in assignments:
            found = families(expression) | bindings.get(name, set())
            if found != bindings.get(name, set()):
                bindings[name] = found
                changed = True

    flags = {'O_CREAT', 'O_WRONLY', 'O_RDWR'}
    writable_open = any(
        items[i:i + 4] in ([name, '(', 'true', ')'] for name in ('write', 'create', 'create_new', 'append', 'truncate'))
        for i in range(len(items))
    )
    for index, token in enumerate(items[:-1]):
        if items[index + 1] != '(':
            continue
        if token not in ('write', 'create', 'create_new', 'rename', 'copy', 'renameat', 'renameat2', 'openat', 'open'):
            continue
        args = arguments(items, index + 1)
        target = None
        if token in ('write', 'create', 'create_new') and args:
            target = args[0]
        elif token in ('rename', 'copy') and len(args) >= 2:
            target = args[1]
        elif token in ('renameat', 'renameat2') and len(args) >= 4:
            target = args[2] + args[3]
        elif token == 'openat' and len(args) >= 3 and flags.intersection(items):
            target = args[0] + args[1]
        elif token == 'open' and args and writable_open:
            target = args[0]
        if target is not None:
            for family in sorted(families(target)):
                yield family, token, ' '.join(target)


def check(root):
    manifest = json.loads((root / 'rust/crates/pp-gateway/ownership-manifest.json').read_text())
    never = {name for name, value in manifest['live_formats'].items() if value['rust_writes'] == 'none'}
    assert never <= PATTERNS.keys(), f'no path pattern for no-writer formats: {never - PATTERNS.keys()}'
    sources, excluded = {}, []
    for path in sorted((root / 'rust/crates').glob('*/src/**/*.rs')):
        sources[path], tests = non_test_source(path)
        excluded.extend(tests)
    assert sources, 'no Rust crate sources found'
    violations = []
    checked = 0
    for path, items in sources.items():
        if any(path == test or test in path.parents for test in excluded):
            continue
        checked += 1
        for family, operation, target in writers(items):
            if family in never:
                violations.append(f'{path.relative_to(root)}: {family} ({PATTERNS[family]}): {operation}({target})')
    assert not violations, 'rust_writes: none has Rust writers:\n' + '\n'.join(violations)
    print(f'checked {checked} non-test Rust source files for no writers: {", ".join(sorted(never))}')


def check_scanner():
    for path, family in [
        ('covers/x', 'source-covers'),
        ('kit-catalog.json', 'kit-catalog'),
        ('manifests/kit-catalog.yaml', 'kit-catalog'),
        ('path-hints.yaml', 'path-hints'),
        ('manifests/example.yaml', 'community-manifests'),
    ]:
        for operation in [
            'std::fs::write(target, b"x")',
            'File::create(target)',
            'OpenOptions::new().write(true).open(target)',
            'OpenOptions::new().create(true).open(target)',
            'libc::openat(fd, target.as_ptr(), libc::O_CREAT, 0o600)',
            'libc::openat(fd, target.as_ptr(), libc::O_WRONLY)',
            'libc::openat(fd, target.as_ptr(), libc::O_RDWR)',
            'fs::rename(old, target)',
            'libc::renameat(fd, old, fd, target)',
            'fs::copy(old, target)',
        ]:
            source = f'const PATH: &str = r"{path}"; let target = data.join(PATH); {operation};'
            assert family in {found[0] for found in writers(tokens(source))}, source
        for operation in ['fs::read(target)', 'File::open(target)', 'fs::copy(target, other)', 'fs::rename(target, other)', 'fs::create_dir_all(target)']:
            source = f'let target = data.join("{path}"); {operation};'
            assert not list(writers(tokens(source))), source
    assert not list(writers(tokens('// fs::write("covers/x", b"x");')))


if __name__ == '__main__':
    check_scanner()
    check(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
