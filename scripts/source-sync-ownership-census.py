"""Audit Source Sync participants against the current mutating call paths."""
import json
import re
from pathlib import Path
root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'web/apps/server/src/data/source-sync-ownership.json').read_text())
print('Premise under review: an outer admission check protects every later mutation in an asynchronous Source operation.')
for participant in manifest['participants']:
    print(participant['id'], participant['kind'], ','.join(participant['resources']), sep='\t')
for name in ['routes/sources.ts', 'routes/repo-manifest.ts', 'services/job-runner.ts', 'services/source-watcher.ts', 'services/source-update-check.ts', 'services/source-docs-index.ts', 'services/webhook-store.ts', 'services/source-manifest-migration.ts', 'services/local-source-revision.ts', 'services/local-source-snapshot.ts', 'services/pdf-text-extract.ts', 'services/legacy-source-manifest.ts', 'lib/source-cover.ts']:
    path = root / 'web/apps/server/src' / name
    print('\n' + name)
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if re.search(r'beforePublish|archiveLegacySourceManifest|publishSourceManifestRevision|requireSourceSyncParticipant|checkAllSourceUpdates\(|syncProjectById\(|extractPendingPdfsForSource\(|repo\.(?:updateSource|markSource|recordAppEvent|setSetting|createSource|recordSourceRevision|activateSourceRevision|replaceSourceDocs|updateSourceDocExtract)', line):
            print(f'{number}\t{line.strip()}')
