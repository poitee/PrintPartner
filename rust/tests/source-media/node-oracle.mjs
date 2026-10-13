import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
const backend = process.argv[2];
const { extractThreeMfMeshes } = await import(pathToFileURL(join(backend, 'services/three-mf-import.js')));
const { discoverImportRules, extractZipFile } = await import(pathToFileURL(join(backend, 'services/archive-import.js')));
const { fileChunks } = await import(pathToFileURL(join(backend, 'lib/byte-chunks.js')));
const { LocalSourceSnapshotStore } = await import(pathToFileURL(join(backend, 'services/local-source-snapshot.js')));
const c = JSON.parse(readFileSync(0, 'utf8'));
function paths(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? paths(root, join(prefix, e.name)) : [join(prefix, e.name)]);
}
try {
  if (c.operation === 'rules') {
    console.log(JSON.stringify({ rules: discoverImportRules(c.destination) }));
  } else if (c.operation === 'encode') {
    const { encodeAcceptedPlate3mf } = await import(pathToFileURL(c.domain + '/accepted-plate-3mf.js'));
    writeFileSync(c.destination, encodeAcceptedPlate3mf(c.objects));
    console.log(JSON.stringify({ encoded: statSync(c.destination).size }));
  } else {
    mkdirSync(c.destination, { recursive: true });
    if (c.zipPath) extractZipFile(join(c.inputDir, c.zipPath), c.destination);
    else for (const path of c.files) { mkdirSync(dirname(join(c.destination, path)), { recursive: true }); copyFileSync(join(c.inputDir, path), join(c.destination, path)); }
    const originals = paths(c.destination);
    const conversions = [];
    for (const path of originals.filter(p => /\.3mf$/i.test(p) && !p.split('/').includes('_3mf'))) {
      let readBytes = 0;
      function* counted() { for (const chunk of fileChunks(join(c.destination, path))) { readBytes += chunk[0].length; yield chunk; } }
      const result = extractThreeMfMeshes(counted(), c.destination, path, c.limits || {});
      conversions.push({ original: path, result, readBytes });
    }
    const selectedFiles = paths(c.destination).sort().map(path => ({ path, kind: /\.stl$/i.test(path) ? 'stl' : 'artifact', sizeHintBytes: statSync(join(c.destination, path)).size }));
    const snapshot = await new LocalSourceSnapshotStore({ reposDir: c.reposDir }).materialize({
      sourceId: c.sourceId, upstreamRevisionKey: c.revisionKey, files: selectedFiles,
      selection: { maxStlFiles: 10000, maxDocumentationBytes: c.limits?.maxTotalBytes || 1073741824, omittedFiles: [] },
      openFile: async file => ({ stream: createReadStream(join(c.destination, file.path)), contentLengthBytes: statSync(join(c.destination, file.path)).size }),
    });
    const { parseStlMesh } = await import(pathToFileURL(process.argv[3] + '/stl-mesh.js'));
    const parsedTriangles = conversions.flatMap(conversion => conversion.result.files.map(f => parseStlMesh(readFileSync(join(c.destination, f.relativePath)))?.faces.length ?? null));
    console.log(JSON.stringify({ conversions, selectedFiles, suggestedImportRules: discoverImportRules(c.destination), snapshot, parsedTriangles }));
  }
} catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
