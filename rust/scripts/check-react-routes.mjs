import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(join(root, 'web/package.json'));
const ts = require('typescript');
const registry = JSON.parse(await readFile(join(root, 'rust/crates/pp-gateway/operations.json'), 'utf8'));
const output = process.argv[2];
if (!output) throw new Error('Usage: check-react-routes.mjs OUTPUT_JSON');
const calls = [];
const transports = [];
const transportRules = [
  { file: 'api/engineTransport.ts', expression: 'resolveEngineUrl(input.path)', kind: 'reviewed_wrapper', evidence: 'Engine helper paths are inventoried at their callers' },
  { file: 'api/contractRequest.ts', expression: 'resolveEngineUrl(path)', kind: 'reviewed_wrapper', evidence: 'Contract endpoint routes are inventoried at their declarations' },
  { file: 'api/jobWebSocket.ts', expression: 'url.toString()', paths: ['/ws/jobs/:param'] },
  { file: 'components/SourceCardCover.tsx', expression: 'url', paths: ['/sources/:param/cover'] },
  { file: 'components/export/accepted-plates/AcceptedPlate3DPreview.tsx', expression: 'await partMeshUrl(unit.part_id)', paths: ['/parts/:param/mesh'] },
  { file: 'lib/fetchWithRetry.ts', expression: 'resolvedUrl', kind: 'reviewed_wrapper', evidence: 'Current callers in stlThumbnail, Preview3D and PartThumb use media GETs only; gateway never retries mutations' },
  { file: 'lib/googleDrive.ts', expression: 'DRIVE_UPLOAD', kind: 'external_provider', evidence: 'Direct Google Drive API transport is outside loopback admission and unproved in native' },
  { file: 'lib/googleDrive.ts', expression: '`${DRIVE_FILES}?q=${q}&pageSize=25&fields=${fields}&orderBy=modifiedTime desc`', kind: 'external_provider', evidence: 'Direct Google Drive API transport is outside loopback admission and unproved in native' },
  { file: 'lib/googleDrive.ts', expression: 'url', kind: 'external_provider', evidence: 'Google Drive download URL; outside loopback admission and unproved in native' },
];
const usedTransports = new Set();
const dynamicPaths = [
  { file: 'api/endpoints/browserFiles.ts', expression: 'path', paths: ['/exports/:param'], evidence: 'engineAssetUrl accepts the server artifact path; only caller is StlRoutePanel pack artifact' },
  { file: 'api/endpoints/browserFiles.ts', expression: 'downloadUrl', paths: ['/exports/:param'], evidence: 'completeExportDownload reads export job result.download_url' },
  { file: 'api/endpoints/help.ts', expression: '`/legal/${name}`', paths: ['/legal/summary', '/legal/license', '/legal/attribution', '/legal/third-party'], evidence: 'fetchLegalDocument parameter is a four-value string union' },
  { file: 'api/endpoints/productionSend.ts', expression: 'downloadPath', paths: ['/bambu-connect/handoff/:param/file'], evidence: 'BambuConnectHandoffResult.download_path is produced by the matching Node handoff route' },
  { file: 'api/endpoints/sourceContent.ts', expression: '`${path}?${query.toString()}`', paths: ['/sources/github-branches', '/sources/github-tags'], evidence: 'fetchGithubRefList has exactly these two literal callers' },
  { file: 'components/export/StlRoutePanel.tsx', expression: 'pack.artifact.downloadUrl', paths: ['/exports/:param'], evidence: 'STL pack job artifact download_url is produced under the exports route' },
];
const usedDynamic = new Set();

const helpers = new Set(['engineFetch', 'engineFetchText', 'engineFetchStream', 'engineFetchMultipart', 'engineSendMultipart', 'resolveEngineUrl', 'engineAssetUrl', 'defineJsonReadEndpoint', 'defineJsonWriteEndpoint']);
function property(object, name) {
  return object && ts.isObjectLiteralExpression(object) ? object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer : undefined;
}
function expression(node, seen = new Set()) {
  if (!node || seen.has(node)) return null;
  seen = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) value += ':param' + span.literal.text;
    return [value];
  }
  if (ts.isConditionalExpression(node)) {
    const yes = expression(node.whenTrue, seen), no = expression(node.whenFalse, seen);
    return yes && no ? [...yes, ...no] : null;
  }
  if (ts.isCallExpression(node) && node.expression.getText() === 'v1Path') {
    return expression(node.arguments[0], seen)?.map(path => '/api/v1' + path) ?? null;
  }
  if (ts.isCallExpression(node) && ['resolveEngineUrl', 'engineAssetUrl'].includes(node.expression.getText())) return expression(node.arguments[0], seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expression(node.left, seen), right = expression(node.right, seen);
    if (left) return left.flatMap(a => (right ?? [':param']).map(b => a + b));
  }
  if (ts.isIdentifier(node)) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      let found;
      for (const statement of scope.statements ?? []) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) found = declaration.initializer;
        }
      }
      if (found) return expression(found, seen);
    }
  }
  return null;
}
function matches(pattern, sample) {
  const route = pattern.split('/'), actual = sample.split('/');
  for (let i = 0; i < route.length; i++) {
    if (route[i] === '*') return true;
    if (actual[i] === undefined) return false;
    if (!route[i].startsWith(':') && route[i] !== actual[i]) return false;
  }
  return route.length === actual.length;
}
function conditionalLimit(path) {
  if (path.startsWith('/auth/')) return 'Email/OAuth authentication is disabled by desktop bootstrap mode';
  if (path.startsWith('/board') || path.startsWith('/shares') || /^\/plans\/[^/]+\/shares/.test(path)) return 'Hosted or multi-user sharing is not registered in desktop self-host mode';
  return null;
}
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) { await walk(path); continue; }
    if (!/\.tsx?$/.test(path) || /\.test\./.test(path)) continue;
    const text = await readFile(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if ((ts.isCallExpression(node) && node.expression.getText(source) === 'fetch') ||
          (ts.isNewExpression(node) && node.expression.getText(source) === 'WebSocket')) {
        const argument = node.arguments?.[0]?.getText(source);
        const file = relative(join(root, 'web/apps/web/src'), path);
        const rule = transportRules.find(rule => rule.file === file && rule.expression === argument);
        if (!rule) throw new Error(`Unreviewed direct transport: ${file}: ${argument}`);
        usedTransports.add(rule);
        for (const route of rule.paths ?? []) {
          if (!registry.routes.some(r => r.method === 'GET' && matches(r.path, route))) throw new Error(`Missing direct transport route: ${route}`);
        }
        transports.push({ ...rule, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      }
      if (ts.isCallExpression(node) && helpers.has(node.expression.getText(source)) && !/\/(engineTransport|contractRequest)\.ts$/.test(path)) {
        const helper = node.expression.getText(source);
        const options = helper.startsWith('defineJson') || ['engineFetchStream', 'engineFetchMultipart', 'engineSendMultipart'].includes(helper) ? node.arguments[0] : node.arguments[1];
        const argument = helper.startsWith('defineJson') ? property(options, 'route') : property(options, 'path') ?? node.arguments[0];
        const override = dynamicPaths.find(rule => relative(join(root, 'web/apps/web/src'), path) === rule.file && argument?.getText(source) === rule.expression);
        if (override) usedDynamic.add(override);
        const paths = override?.paths ?? expression(argument);
        const method = expression(property(options, 'method'))?.[0] ?? (['engineFetchMultipart', 'engineSendMultipart'].includes(helper) ? 'POST' : 'GET');
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        const call = { file: relative(root, path), line: position.line + 1, helper, method, expression: argument?.getText(source), paths: [] };
        if (override) call.dynamic_evidence = override.evidence;
        if (!paths) call.unresolved = 'Dynamic path requires explicit call-site analysis';
        for (const raw of paths ?? []) {
          const route = raw.split('?')[0].replace(/:param$/, raw.endsWith('/:param') ? ':param' : '');
          if (!route.startsWith('/')) { call.unresolved = 'Path prefix depends on a wrapper argument'; continue; }
          const admitted = registry.routes.find(r => r.method === method && matches(r.path, route));
          const denied = registry.denied.find(r => r.method === method && matches(r.path, route));
          call.paths.push({ path: route, status: admitted ? 'admitted' : denied ? 'explicitly_denied' : conditionalLimit(route) ? 'conditional_unavailable' : 'missing',
            evidence: admitted?.path ?? denied?.reason ?? conditionalLimit(route) });
        }
        calls.push(call);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await walk(join(root, 'web/apps/web/src'));
if (usedDynamic.size !== dynamicPaths.length) throw new Error('A reviewed dynamic call changed or disappeared; revisit its explicit evidence');
if (usedTransports.size !== transportRules.length) throw new Error('A reviewed direct transport changed or disappeared');
const missing = calls.filter(call => call.unresolved || call.paths.some(path => path.status === 'missing'));
await writeFile(output, JSON.stringify({ calls, direct_transports: transports, unresolved_or_missing: missing }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ calls: calls.length, direct_transports: transports.length, unresolved_or_missing: missing.length }) + '\n');
if (missing.length) process.exitCode = 1;
