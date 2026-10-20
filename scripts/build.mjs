#!/usr/bin/env node
/**
 * Build the DSH client bundle and ship the Pele browser runtime.
 *
 * Outputs (never hand-edited):
 *   lib/client.js       esbuild bundle of src/client.js wrapped in the
 *                       window.__ModuleLoader__.load({ id, factory(require) }) contract
 *   lib/pele-runtime.js byte-identical copy of node_modules/pele/dist/pele.global.js
 *
 * Usage: node scripts/build.mjs [--entry <file>]   (--entry is a build-pipeline test seam)
 *
 * The esbuild CLI binary is preferred over the Node API: the CLI writes its output
 * file directly, so it also works where the sandbox denies piped child processes.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PACKAGE_ID = 'dsh-pele-mermaid';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENTRY = join(ROOT, 'src', 'client.js');
const OUT_CLIENT = join(ROOT, 'lib', 'client.js');
const OUT_HOST = join(ROOT, 'lib', 'index.js');
const PELE_GLOBAL = join(ROOT, 'node_modules', 'pele', 'dist', 'pele.global.js');
const OUT_RUNTIME = join(ROOT, 'lib', 'pele-runtime.js');
const TMP_DIR = join(ROOT, '.build-tmp');

/** Loader contract from SPEC section 2: a single self-executing factory call. */
const BANNER = `window.__ModuleLoader__.load({id:"${PACKAGE_ID}",factory:(require)=>{var module={exports:{}};var exports=module.exports;`;
const FOOTER = 'return module.exports;}});';

const ESBUILD_FLAGS = [
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--minify',
  '--legal-comments=none',
  '--log-level=warning',
];

function parseArgs(argv) {
  const entries = [];
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--entry') {
      const value = args.shift();
      if (!value) throw new Error('--entry requires a file path');
      entries.push(value);
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, entries: [] };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, entries };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function esbuildBinaryCandidates() {
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  if (process.platform === 'win32') {
    return [
      join(ROOT, 'node_modules', ...platformPackage.split('/'), 'esbuild.exe'),
      join(ROOT, 'node_modules', '.bin', 'esbuild.cmd'),
    ];
  }
  return [
    join(ROOT, 'node_modules', ...platformPackage.split('/'), 'bin', 'esbuild'),
    join(ROOT, 'node_modules', '.bin', 'esbuild'),
  ];
}

function runEsbuildCli(binary, entry, outRaw, metaPath) {
  const args = [entry, ...ESBUILD_FLAGS, `--outfile=${outRaw}`, `--metafile=${metaPath}`];
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: binary.endsWith('.cmd'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`esbuild exited with status ${result.status === null ? 1 : result.status}`);
  }
}

async function runEsbuildApi(entry, outRaw, metaPath) {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    absWorkingDir: ROOT,
  });
  await writeFile(outRaw, result.outputFiles[0].text);
  await writeFile(metaPath, JSON.stringify(result.metafile));
}

async function bundleRaw(entry, outRaw, metaPath) {
  const binary = esbuildBinaryCandidates().find((candidate) => existsSync(candidate));
  if (binary) {
    runEsbuildCli(binary, entry, outRaw, metaPath);
    return binary;
  }
  await runEsbuildApi(entry, outRaw, metaPath);
  return '<esbuild js api>';
}

async function buildClient(entry, esbuildUsed) {
  const outRaw = join(TMP_DIR, 'client.raw.js');
  const metaPath = join(TMP_DIR, 'meta.json');
  await mkdir(TMP_DIR, { recursive: true });
  await bundleRaw(entry, outRaw, metaPath);

  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const banned = Object.keys(meta.inputs || {}).filter((input) => {
    const normalized = input.replace(/\\/g, '/');
    return normalized.includes('node_modules/pele/') || /(^|\/)pele\/(dist|esm|src)\//.test(normalized);
  });
  if (banned.length) {
    throw new Error(`client bundle must not import pele at build time; found: ${banned.join(', ')}`);
  }

  const raw = await readFile(outRaw, 'utf8');
  const text = BANNER + raw + FOOTER + '\n';
  if (!text.includes('__ModuleLoader__.load(')) {
    throw new Error('client bundle is missing the __ModuleLoader__ wrapper');
  }
  if (!text.includes(`id:"${PACKAGE_ID}"`)) {
    throw new Error(`client bundle is missing the id "${PACKAGE_ID}"`);
  }
  if (/require\(\s*["']pele["']\s*\)/.test(raw)) {
    throw new Error('client bundle still requires \'pele\' at runtime');
  }
  await writeFile(OUT_CLIENT, text);
  return { text, esbuildUsed };
}

async function copyRuntime() {
  const source = await readFile(PELE_GLOBAL);
  await writeFile(OUT_RUNTIME, source);
  const written = await readFile(OUT_RUNTIME);
  const sourceHash = sha256(source);
  const writtenHash = sha256(written);
  if (sourceHash !== writtenHash) {
    throw new Error('pele-runtime.js is not byte-identical to node_modules/pele/dist/pele.global.js');
  }
  return { bytes: written.length, sha256: writtenHash };
}

async function main() {
  const { help, entries } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log('Usage: node scripts/build.mjs [--entry <file>]');
    return;
  }
  if (!existsSync(OUT_HOST)) {
    throw new Error(
      `authored host face not found: ${OUT_HOST}\n` +
      'lib/index.js is hand-written (not a build output); restore it instead of deleting lib/.',
    );
  }
  const entry = entries.length ? resolve(ROOT, entries[0]) : DEFAULT_ENTRY;
  if (!existsSync(entry)) {
    throw new Error(
      `client entry not found: ${entry}\n` +
      'src/client.js is owned by plugin-core; the build refuses to stub over it.',
    );
  }
  if (!existsSync(PELE_GLOBAL)) {
    // A GitHub-source install has no node_modules: the committed artifacts are
    // already the shipped ones, so keep them instead of failing the install.
    if (existsSync(OUT_CLIENT) && existsSync(OUT_RUNTIME)) {
      console.log('dsh-pele-mermaid build');
      console.log('  skipped: node_modules/pele is absent, keeping the committed artifacts');
      console.log(`  lib/client.js       ${(await readFile(OUT_CLIENT)).length} bytes`);
      console.log(`  lib/pele-runtime.js ${(await readFile(OUT_RUNTIME)).length} bytes`);
      return;
    }
    throw new Error(`Pele runtime not found: ${PELE_GLOBAL} (run npm install --ignore-scripts)`);
  }

  await mkdir(dirname(OUT_CLIENT), { recursive: true });
  const client = await buildClient(entry, null);
  const runtime = await copyRuntime();
  await rm(TMP_DIR, { recursive: true, force: true });

  console.log('dsh-pele-mermaid build');
  console.log(`  entry               ${entry}`);
  console.log(`  lib/client.js       ${Buffer.byteLength(client.text)} bytes`);
  console.log(`  lib/pele-runtime.js ${runtime.bytes} bytes`);
  console.log(`  sha256(lib/pele-runtime.js)                  ${runtime.sha256}`);
  console.log(`  sha256(node_modules/pele/dist/pele.global.js) ${runtime.sha256}`);
}

main().catch(async (error) => {
  console.error(`build failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
