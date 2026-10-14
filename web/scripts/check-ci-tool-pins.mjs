#!/usr/bin/env node
import console from 'node:console';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.argv.length > 3) {
  console.error('Usage: node web/scripts/check-ci-tool-pins.mjs [workflow-directory]');
  process.exit(2);
}
let yaml;
try {
  const require = createRequire(join(root, 'web/package.json'));
  yaml = require('yaml');
} catch {
  console.error('MISSING_PARSER: run npm ci in web/ before checking CI tool pins');
  process.exit(2);
}
const directory = resolve(process.argv[2] ?? join(root, '.github/workflows'));
let declarations = 0;
let tools = 0;
let errors = 0;
const report = (file, path, code, message) => {
  errors++;
  console.error(`${file} ${path}: ${code}: ${message}`);
};
const mapping = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const literal = value => typeof value === 'string' && value.trim() !== '' && !value.includes('${{');

function checkUses(step, file, path, seen) {
  if (!Object.hasOwn(step, 'uses')) return;
  if (!literal(step.uses)) {
    report(file, `${path}.uses`, 'INVALID_USES', 'uses must be a nonempty literal string');
    return;
  }
  const action = step.uses.split('@')[0].trim().toLowerCase();
  if (action !== 'taiki-e/install-action' && !action.startsWith('taiki-e/install-action/')) return;
  if (seen.has(step)) return;
  seen.add(step);
  declarations++;
  if (action !== 'taiki-e/install-action' || !/^taiki-e\/install-action@[^@\s]+$/i.test(step.uses)) {
    report(file, `${path}.uses`, 'INVALID_INSTALLER', `unsupported installer reference ${step.uses}; use taiki-e/install-action@ref with with.tool`);
    return;
  }
  const tool = mapping(step.with) ? step.with.tool : undefined;
  if (!literal(tool)) {
    report(file, `${path}.with.tool`, 'INVALID_TOOL', 'installer requires a nonempty literal string with.tool');
    return;
  }
  const names = new Set();
  for (const group of tool.split(',')) {
    const tokens = group.trim().split(/\s+/);
    for (const token of tokens) {
      if (!/^[A-Za-z0-9_-]+@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(token)) {
        report(file, `${path}.with.tool`, 'UNPINNED_TOOL', `${JSON.stringify(token)}; expected name@major.minor.patch`);
        continue;
      }
      tools++;
      const name = token.split('@')[0];
      if (names.has(name)) report(file, `${path}.with.tool`, 'DUPLICATE_TOOL', `duplicate tool ${name}`);
      names.add(name);
    }
  }
}

function checkWorkflow(file) {
  const document = yaml.parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true, merge: false });
  for (const error of [...document.errors, ...document.warnings]) {
    report(file, '$', 'INVALID_YAML', error.message);
  }
  if (document.errors.length || document.warnings.length) return;
  const initialErrors = errors;
  yaml.visit(document, {
    Pair(_key, pair) {
      if (!yaml.isScalar(pair.key) || typeof pair.key.value !== 'string') {
        report(file, '$', 'UNSUPPORTED_YAML', 'mapping keys must be strings');
      } else if (pair.key.value === '<<') {
        report(file, '$', 'UNSUPPORTED_YAML', 'merge keys are unsupported; use explicit mappings or aliases');
      }
    },
    Node(_key, node) {
      if (node.tag && !node.tag.startsWith('tag:yaml.org,2002:')) {
        report(file, '$', 'UNSUPPORTED_YAML', `unsupported tag ${node.tag}`);
      }
    },
  });
  if (errors !== initialErrors) return;
  const workflow = document.toJS({ maxAliasCount: 100 });
  if (!mapping(workflow) || !mapping(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    report(file, 'jobs', 'INVALID_SHAPE', 'workflow requires a nonempty jobs mapping');
    return;
  }
  const seen = new Set();
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const path = `jobs.${name}`;
    if (!mapping(job)) {
      report(file, path, 'INVALID_SHAPE', 'job must be a mapping');
      continue;
    }
    if (Object.hasOwn(job, 'uses')) {
      if (Object.hasOwn(job, 'steps')) report(file, path, 'INVALID_SHAPE', 'job cannot contain both uses and steps');
      checkUses(job, file, path, seen);
      continue;
    }
    if (!Array.isArray(job.steps)) {
      report(file, `${path}.steps`, 'INVALID_SHAPE', 'steps must be a sequence');
      continue;
    }
    for (const [index, step] of job.steps.entries()) {
      const stepPath = `${path}.steps[${index}]`;
      if (!mapping(step)) report(file, stepPath, 'INVALID_SHAPE', 'step must be a mapping');
      else checkUses(step, file, stepPath, seen);
    }
  }
}

try {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => /\.ya?ml$/i.test(entry.name))
    .map(entry => join(directory, entry.name)).sort();
  if (files.length === 0) report(directory, '$', 'NO_WORKFLOWS', 'no .yml or .yaml workflow files found');
  for (const file of files) {
    try {
      checkWorkflow(file);
    } catch (error) {
      report(file, '$', 'READ_OR_PARSE_ERROR', error.message);
    }
  }
} catch (error) {
  report(directory, '$', 'READ_ERROR', error.message);
}
console.log(`install_declarations=${declarations} tool_specs=${tools} errors=${errors}`);
process.exitCode = errors ? 1 : 0;
