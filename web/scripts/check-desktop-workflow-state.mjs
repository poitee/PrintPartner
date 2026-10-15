#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';

const path = '.github/workflows/desktop-contracts.yml';
const repository = process.env.GITHUB_REPOSITORY;

try {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('GITHUB_REPOSITORY must identify the event repository');
  }
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to read workflow state');
  const response = execFileSync('gh', [
    'api', '--hostname', 'github.com', `repos/${repository}/actions/workflows/desktop-contracts.yml`,
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const workflow = JSON.parse(response);
  if (workflow?.path !== path || workflow.state !== 'active') {
    throw new Error('required desktop-contracts.yml workflow must have API state active');
  }
  console.log('desktop-contracts.yml API state=active');
} catch {
  console.error('INVALID_DESKTOP_WORKFLOW_STATE: cannot confirm the required desktop-contracts.yml workflow is active in the event repository');
  process.exitCode = 1;
}
