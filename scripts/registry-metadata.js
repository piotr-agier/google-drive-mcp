#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const registryBaseUrl = (process.env.MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io').replace(/\/$/, '');
const command = process.argv[2];
const serverFile = resolve(process.cwd(), process.argv[3] || 'server.json');

function usage() {
  console.error('Usage: node scripts/registry-metadata.js <validate|verify> [server.json]');
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readServerMetadata() {
  try {
    return JSON.parse(await readFile(serverFile, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${serverFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requestJson(url, options, attempts) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(`Registry returned non-JSON response (${response.status}): ${body.slice(0, 500)}`);
      }

      if (!response.ok) {
        const error = new Error(`Registry request failed (${response.status}): ${JSON.stringify(parsed)}`);
        if (response.status < 500) throw error;
        lastError = error;
      } else {
        return parsed;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) await sleep(attempt * 1_000);
  }

  throw lastError;
}

function formatIssue(issue) {
  const path = issue.path ? `${issue.path}: ` : '';
  const severity = issue.severity ? `[${issue.severity}] ` : '';
  return `${severity}${path}${issue.message || JSON.stringify(issue)}`;
}

async function validate(server) {
  const result = await requestJson(
    `${registryBaseUrl}/v0.1/validate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(server),
    },
    3,
  );

  if (!result.valid) {
    const issues = Array.isArray(result.issues) ? result.issues.map(formatIssue).join('\n') : JSON.stringify(result);
    throw new Error(`MCP Registry validation failed:\n${issues}`);
  }

  console.log(`MCP Registry validation passed for ${server.name}@${server.version}.`);
}

function comparePublishedRecord(expected, actual) {
  const differences = [];
  const compare = (label, expectedValue, actualValue) => {
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      differences.push(`${label}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
    }
  };

  compare('title', expected.title, actual.title);
  compare('description', expected.description, actual.description);
  compare('repository', expected.repository, actual.repository);
  compare('websiteUrl', expected.websiteUrl, actual.websiteUrl);
  compare('packages', expected.packages, actual.packages);
  return differences;
}

async function verify(server) {
  const url = new URL(`${registryBaseUrl}/v0.1/servers`);
  url.searchParams.set('search', server.name);
  url.searchParams.set('version', server.version);
  const attempts = Math.max(1, Number.parseInt(process.env.MCP_REGISTRY_VERIFY_ATTEMPTS || '1', 10) || 1);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestJson(url, { method: 'GET' }, 3);
    const record = result.servers?.find(
      (entry) => entry.server?.name === server.name && entry.server?.version === server.version,
    )?.server;

    if (record) {
      const differences = comparePublishedRecord(server, record);
      if (differences.length > 0) {
        throw new Error(`Published MCP Registry record does not match server.json:\n${differences.join('\n')}`);
      }
      console.log(`Verified published MCP Registry record ${server.name}@${server.version}.`);
      return;
    }

    if (attempt < attempts) await sleep(attempt * 2_000);
  }

  console.error(`MCP Registry record ${server.name}@${server.version} was not found.`);
  process.exitCode = 2;
}

try {
  if (command !== 'validate' && command !== 'verify') {
    usage();
    process.exitCode = 1;
  } else {
    const server = await readServerMetadata();
    if (command === 'validate') await validate(server);
    else await verify(server);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
