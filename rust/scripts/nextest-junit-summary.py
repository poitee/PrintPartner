import argparse
import os
import pathlib
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--junit', type=pathlib.Path, required=True)
parser.add_argument('--partition', required=True)
parser.add_argument('--budget', type=float, default=90)
parser.add_argument('--top', type=int, default=5)
args = parser.parse_args()

lines = [f'### Rust nextest partition {args.partition}', '']

if args.junit.is_file():
    root = ET.parse(args.junit).getroot()
    # nextest sets the root `time` to the test run duration, excluding test-binary compilation.
    total = float(root.get('time', 0))
    lines.append(f'Test time: {total:.1f}s (budget {args.budget:.0f}s)')
    lines.append('')
    if total > args.budget:
        print(f'::warning::Rust nextest partition {args.partition} test time {total:.1f}s exceeds the {args.budget:.0f}s budget')

    cases = []
    for case in root.iter('testcase'):
        status = 'passed'
        for child in case:
            if child.tag in ('failure', 'error'):
                status = 'failed'
            elif child.tag == 'skipped':
                status = 'skipped'
        name = f"{case.get('classname', '')} {case.get('name', '')}".strip().replace('|', '\\|')
        cases.append((float(case.get('time', 0)), name, status))
    cases.sort(reverse=True)
    shown = min(args.top, len(cases))
    lines += [f'Slowest {shown} of {len(cases)} tests:', '', '| Time (s) | Test | Status |', '| ---: | --- | --- |']
    lines += [f'| {t:.3f} | `{name}` | {status} |' for t, name, status in cases[:shown]]
else:
    lines.append(f'No JUnit report at `{args.junit}`; the test run did not produce one.')

text = '\n'.join(lines) + '\n'
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as out:
        out.write(text)
else:
    print(text, end='')
