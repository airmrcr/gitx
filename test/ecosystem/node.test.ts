import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeEcosystem } from '../../src/ecosystem/node.ts';
import { detectProject } from '../../src/ecosystem/registry.ts';
import type { InstallOptions } from '../../src/ecosystem/types.ts';
import { clearExecutableCache } from '../../src/util/exec.ts';

const installOptions = (overrides: Partial<InstallOptions> = {}): InstallOptions => ({
  extraArgs: [],
  frozen: true,
  volta: 'auto',
  ...overrides,
});

const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', version: '1.0.0', ...extra });

const project = async (files: Record<string, string>) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-eco-'));
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, 'utf8');
  }
  return dir;
};

beforeEach(() => {
  clearExecutableCache();
});

describe('nodeEcosystem.detect', () => {
  it('ignores directories without a package.json', async () => {
    const dir = await project({ 'README.md': '# hi' });
    expect(await nodeEcosystem.detect(dir)).toBeUndefined();
  });

  it('prefers the corepack packageManager field', async () => {
    const dir = await project({
      'package.json': pkg({ packageManager: 'pnpm@9.1.0', volta: { npm: '10.0.0' } }),
      'package-lock.json': '{}',
    });
    expect((await nodeEcosystem.detect(dir))?.manager).toBe('pnpm');
  });

  it('falls back to a Volta pin', async () => {
    const dir = await project({
      'package.json': pkg({ volta: { yarn: '1.22.0' } }),
      'package-lock.json': '{}',
    });
    expect((await nodeEcosystem.detect(dir))?.manager).toBe('yarn');
  });

  it('falls back to the lock file', async () => {
    for (const [lockFile, expected] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ] as const) {
      const dir = await project({ 'package.json': pkg(), [lockFile]: '' });
      expect((await nodeEcosystem.detect(dir))?.manager).toBe(expected);
    }
  });

  it('prefers pnpm when several lock files linger', async () => {
    const dir = await project({
      'package.json': pkg(),
      'pnpm-lock.yaml': '',
      'package-lock.json': '{}',
    });
    expect((await nodeEcosystem.detect(dir))?.manager).toBe('pnpm');
  });

  it('defaults to npm when there is nothing to go on', async () => {
    const dir = await project({ 'package.json': pkg() });
    const detected = await nodeEcosystem.detect(dir);
    expect(detected?.manager).toBe('npm');
    expect(detected?.hasLockFile).toBe(false);
  });

  it('still detects a project when package.json is malformed', async () => {
    const dir = await project({ 'package.json': '{ broken', 'yarn.lock': '' });
    expect((await nodeEcosystem.detect(dir))?.manager).toBe('yarn');
  });

  it('reports whether the lock file is present', async () => {
    const withLock = await project({ 'package.json': pkg(), 'package-lock.json': '{}' });
    const withoutLock = await project({ 'package.json': pkg() });
    expect((await nodeEcosystem.detect(withLock))?.hasLockFile).toBe(true);
    expect((await nodeEcosystem.detect(withoutLock))?.hasLockFile).toBe(false);
  });
});

describe('install plans', () => {
  it('uses npm ci when a lock file exists', async () => {
    const dir = await project({ 'package.json': pkg(), 'package-lock.json': '{}' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.command).toBe('npm');
    expect(plan.args).toEqual(['ci', '--no-audit', '--no-fund']);
  });

  it('falls back to npm install when there is no lock file', async () => {
    const dir = await project({ 'package.json': pkg() });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.args).toEqual(['install', '--no-audit', '--no-fund']);
    expect(plan.fallback).toBeUndefined();
  });

  it('offers a non-frozen fallback alongside a frozen install', async () => {
    const dir = await project({ 'package.json': pkg(), 'package-lock.json': '{}' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.fallback?.args).toEqual(['install', '--no-audit', '--no-fund']);
  });

  it('honours frozen: false', async () => {
    const dir = await project({ 'package.json': pkg(), 'package-lock.json': '{}' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions({ frozen: false }));
    expect(plan.args).toEqual(['install', '--no-audit', '--no-fund']);
  });

  it('uses --frozen-lockfile for pnpm', async () => {
    const dir = await project({ 'package.json': pkg(), 'pnpm-lock.yaml': '' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.command).toBe('pnpm');
    expect(plan.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('uses --frozen-lockfile for Yarn Classic', async () => {
    const dir = await project({ 'package.json': pkg(), 'yarn.lock': '' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('uses --immutable for Yarn Berry', async () => {
    const dir = await project({ 'package.json': pkg(), 'yarn.lock': '', '.yarnrc.yml': '' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.args).toEqual(['install', '--immutable']);
  });

  it('detects Yarn Berry from the packageManager field', async () => {
    const dir = await project({
      'package.json': pkg({ packageManager: 'yarn@4.1.0' }),
      'yarn.lock': '',
    });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions());
    expect(plan.args).toEqual(['install', '--immutable']);
  });

  it('appends extra arguments', async () => {
    const dir = await project({ 'package.json': pkg(), 'pnpm-lock.yaml': '' });
    const plan = (await nodeEcosystem.detect(dir))!.plan(
      installOptions({ extraArgs: ['--ignore-scripts'] }),
    );
    expect(plan.args).toEqual(['install', '--frozen-lockfile', '--ignore-scripts']);
  });

  it('sets VOLTA_BYPASS when Volta is disabled', async () => {
    const dir = await project({ 'package.json': pkg() });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions({ volta: 'never' }));
    expect(plan.command).toBe('npm');
    expect(plan.env?.['VOLTA_BYPASS']).toBe('1');
  });

  it('runs the tool directly in auto mode, so Volta is never required', async () => {
    const dir = await project({ 'package.json': pkg() });
    const plan = (await nodeEcosystem.detect(dir))!.plan(installOptions({ volta: 'auto' }));
    expect(plan.command).toBe('npm');
    expect(plan.env).toBeUndefined();
  });
});

describe('detectProject', () => {
  it('delegates to the registered ecosystems', async () => {
    const dir = await project({ 'package.json': pkg(), 'pnpm-lock.yaml': '' });
    expect((await detectProject(dir))?.ecosystem).toBe('node');
  });

  it('returns undefined for an unrecognised project', async () => {
    const dir = await project({ 'go.mod': 'module example.com/x' });
    expect(await detectProject(dir)).toBeUndefined();
  });
});
