#!/usr/bin/env node
/**
 * dsh-pele-mermaid installer.
 *
 * Usage:
 *   dsh-pele-mermaid install [--profile web] [--source <package-spec>]
 *   dsh-pele-mermaid uninstall [--profile web]
 *
 * The standalone `dsh` CLI refuses the `desktop` profile (managed by the
 * Electron app), so this wrapper defaults to `web` and explains that case.
 */

import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-pele-mermaid';
const DEFAULT_PROFILE = 'web';
const ELECTRON_ONLY_PROFILE = 'desktop';
const DEFAULT_SOURCE = resolve(fileURLToPath(new URL('..', import.meta.url)));

function usage() {
  console.log([
    'Usage:',
    '  dsh-pele-mermaid install [--profile web] [--source <package-spec>]',
    '  dsh-pele-mermaid uninstall [--profile web]',
    '',
    'Examples:',
    '  node bin/dsh-pele-mermaid.mjs install',
    '  node bin/dsh-pele-mermaid.mjs install --source <absolute-path>',
    '  node bin/dsh-pele-mermaid.mjs uninstall --profile web',
    '',
    '  安装：dsh-pele-mermaid install [--profile web] [--source <包规格>]',
    '  卸载：dsh-pele-mermaid uninstall [--profile web]',
    '',
    'Notes / 说明:',
    '  The default profile is "web".',
    '  The "desktop" profile is managed exclusively by the DeepSeek Harness',
    '  application — install it from the app\'s Plugins page.',
    '  默认使用 "web" profile；"desktop" profile 由 DeepSeek Harness 应用管理，',
    '  请在应用的“插件”页面安装。',
  ].join('\n'));
}

function takeOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(name + ' requires a value');
  args.splice(index, 2);
  return value;
}

function normalizeSource(requested) {
  if (requested === '.' || requested === '..' || requested.startsWith('./') || requested.startsWith('../')) {
    return resolve(process.cwd(), requested);
  }
  return requested;
}

function assertSafeArgument(value, label) {
  if (process.platform === 'win32' && /[&|<>^%!()\r\n"]/.test(value)) {
    throw new Error(label + ' contains characters the Windows command line cannot carry');
  }
}

function assertNotElectronProfile(profile) {
  if (profile === ELECTRON_ONLY_PROFILE) {
    throw new Error([
      'profile "desktop" is managed exclusively by the DeepSeek Harness application;',
      'the standalone dsh CLI refuses it.',
      'Install this bundle from the app\'s Plugins page instead, or pass --profile web.',
      '—',
      '“desktop” profile 由 DeepSeek Harness 应用管理，命令行 dsh 拒绝操作该 profile。',
      '请改为在应用的“插件”页面安装，或使用 --profile web。',
    ].join('\n'));
  }
}

function runDsh(args) {
  const executable = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  for (const argument of args) assertSafeArgument(argument, 'install argument');
  const result = spawnSync(executable, args, {
    cwd: DEFAULT_SOURCE,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('dsh was not found in PATH; install DeepSeek Harness first. / 未找到 dsh，请先安装 DeepSeek Harness。');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('dsh exited with status ' + (result.status === null ? 1 : result.status));
}

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

try {
  const profile = takeOption(args, '--profile', DEFAULT_PROFILE);
  assertSafeArgument(profile, '--profile');
  assertNotElectronProfile(profile);

  if (command === 'install') {
    const source = normalizeSource(takeOption(args, '--source', DEFAULT_SOURCE));
    if (args.length) throw new Error('unrecognized arguments: ' + args.join(' '));
    runDsh(['plugin', '--profile', profile, 'add', '-w', '--save-exact', source]);
    console.log('');
    console.log(PACKAGE_NAME + ' installed into profile "' + profile + '". Restart dsh web and open a session with a mermaid code block.');
    console.log(PACKAGE_NAME + ' 已安装到 profile “' + profile + '”。请重启 dsh web，然后打开包含 mermaid 代码块的会话。');
  } else if (command === 'uninstall') {
    if (args.length) throw new Error('unrecognized arguments: ' + args.join(' '));
    runDsh(['plugin', '--profile', profile, 'remove', '-w', PACKAGE_NAME]);
    console.log('');
    console.log(PACKAGE_NAME + ' removed from profile "' + profile + '". Restart dsh web.');
    console.log(PACKAGE_NAME + ' 已从 profile “' + profile + '”卸载。请重启 dsh web。');
  } else {
    throw new Error('unrecognized command: ' + command);
  }
} catch (error) {
  console.error(PACKAGE_NAME + ': ' + (error && error.message ? error.message : error));
  process.exit(1);
}
