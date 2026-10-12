"""Deterministic production-main controls; no real processes or signals."""
from pathlib import Path
from unittest.mock import Mock, patch
import json
import tempfile
import unittest

SOURCE = Path(__file__).with_name('run-owned.py')


def control(initial, new_owned):
    ns = {'__name__': 'control'}
    exec(compile(SOURCE.read_text(), str(SOURCE), 'exec'), ns)
    state = {'observations': 0, 'runner': True, 'descendant': True}

    def descendants(_):
        state['observations'] += 1
        return {200} if state['descendant'] and (new_owned or state['observations'] == 1) else set()

    def identity(pid):
        if pid == 100:
            return 'runner' if state['runner'] else None
        if pid == 200 and state['descendant']:
            return initial if state['observations'] == 1 else 'new-start'
        return None

    waits = [(0, 0), (100, 0)]
    def waitpid(*_):
        if waits:
            value = waits.pop(0)
            if value[0] == 100:
                state['runner'] = False
            return value
        raise ChildProcessError()

    def kill(pid, _):
        assert pid == 200 and new_owned
        state['descendant'] = False

    ns['descendants'], ns['identity'] = descendants, identity
    with tempfile.TemporaryDirectory() as output, patch.dict('os.environ', {'GRE492_OUTPUT': output}), \
         patch.object(ns['ctypes'], 'CDLL', return_value=Mock(prctl=Mock(return_value=0))), \
         patch.object(ns['shutil'], 'which', return_value='/unused-node'), \
         patch.object(ns['signal'], 'signal'), \
         patch.object(ns['subprocess'], 'Popen', return_value=Mock(pid=100)), \
         patch.object(ns['os'], 'waitpid', side_effect=waitpid), \
         patch.object(ns['os'], 'kill', side_effect=kill) as signals, \
         patch.object(ns['time'], 'sleep'):
        result = ns['main']()
        receipt = json.loads((Path(output) / 'subreaper.json').read_text())
        return result, receipt, signals.call_count, state['descendant']


class IdentityControls(unittest.TestCase):
    def test_new_owned_identity_is_cleaned(self):
        result, receipt, signals, alive = control('old-start', True)
        self.assertEqual(result, 0)
        self.assertFalse(alive)
        self.assertEqual(signals, 1)
        self.assertEqual(receipt['owned_start_identities']['200'], 'new-start')
        self.assertEqual(receipt['survivors'], [])
        self.assertEqual([row['start_identity'] for row in receipt['identity_history']], ['old-start', 'new-start'])

    def test_transient_missing_identity_is_acquired_later(self):
        _, receipt, signals, alive = control(None, True)
        self.assertFalse(alive)
        self.assertEqual(signals, 1)
        self.assertEqual(receipt['owned_start_identities']['200'], 'new-start')

    def test_unowned_reuse_is_refused(self):
        _, receipt, signals, alive = control('old-start', False)
        self.assertTrue(alive)
        self.assertEqual(signals, 0)
        self.assertEqual(receipt['owned_start_identities']['200'], 'old-start')
        self.assertEqual(receipt['signal_refusals'][0]['current_identity'], 'new-start')


if __name__ == '__main__':
    unittest.main()
