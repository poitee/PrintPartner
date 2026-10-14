import copy
import importlib.util
import json
from pathlib import Path
source = Path('/persist/worktrees/t3/PrintPartner/owner-gre353-next-202610140800-a1c4/rust/tests/webkit_stl_smoke.py')
spec = importlib.util.spec_from_file_location('verifier', source)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
state = Path('/persist/home/.local/state/pstack-t3/gre353-frames')
receipt = json.loads((state / 'implementation-final/frames.json').read_text())
native = receipt['observations']['native']
assert v.frame_denial(native) is None
assert v.frame_denial(receipt['observations']['negative']) == 'target_executed'
results = []
for field, value, reason in [
    ('attempt_intact', False, 'invalid_frame_attempt'),
    ('parent_preserved', False, 'parent_not_preserved'),
    ('message', True, 'target_executed'),
    ('beacon_count', 1, 'target_executed'),
    ('document_get_count', 1, 'unexpected_child_document_get'),
    ('events', [], 'native_csp_enforcement_unproven'),
]:
    mutated = copy.deepcopy(native); mutated[field] = value
    assert v.frame_denial(mutated) == reason
    results.append(field)
for field, values in {
    'isTrusted': [False, 1, None],
    'effectiveDirective': ['script-src', '', None],
    'disposition': ['report', '', None],
    'blockedURI': ['http://127.0.0.1:1', 'https://example.com', ''],
    'documentURI': ['http://127.0.0.1:1/builds', native['parent_href'] + '&other=1', ''],
    'originalPolicy': ["frame-src 'none'", "frame-src *; object-src 'none'; base-uri 'self'; frame-ancestors 'none'", ''],
}.items():
    for value in values:
        mutated = copy.deepcopy(native); mutated['events'][0][field] = value
        assert v.frame_denial(mutated) == 'native_csp_enforcement_unproven'
        results.append(field + '=' + repr(value))
mutated = copy.deepcopy(native)
mutated['events'][0]['originalPolicy'] = "  frame-src   'none' ; object-src 'none'; base-uri 'self'; frame-ancestors 'none';  "
mutated['events'][0]['documentURI'] += '#fragment'
assert v.frame_denial(mutated) is None
print(json.dumps({'result':'PASS', 'rejected_mutations':len(results), 'cases':results, 'policy_whitespace_and_document_fragment':'accepted', 'live_negative_reason':'target_executed'}, indent=2))
