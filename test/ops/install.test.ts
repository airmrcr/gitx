import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Config } from '../../src/config/store.ts';
import { installDependencies } from '../../src/ops/install.ts';
import type { TaskContext } from '../../src/runner/task.ts';
import { clearExecutableCache, exec } from '../../src/util/exec.ts';
import { formatCommand, setColorMode } from '../../src/util/theme.ts';

// Assertions below expect plain, uncoloured command echoes regardless of the ambient terminal (e.g.
// FORCE_COLOR set by the shell running the tests).
setColorMode('never');

const env = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_AUTHOR_NAME: 'gitx tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'gitx tests',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const config = (text = '') => Config.parse(text, '/tmp/gitxconfig');

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const result = await exec('git', args, { cwd, env });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
};

const npmRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-install-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '1.0.0', private: true, dependencies: { picocolors: '1.1.1' } },
      undefined,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');

  const install = await exec('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: dir,
  });
  if (!install.ok) throw new Error(`npm install failed: ${install.stderr}`);

  await git(dir, 'init', '--initial-branch=main', '.');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
};

const recordingTask = (): TaskContext & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    log: (line) => lines.push(line),
    echo: (command, args) => lines.push(formatCommand(command, args)),
    setStatus: () => {},
    signal: new AbortController().signal,
  };
};

describe('installDependencies', () => {
  it('skips a directory with no recognised project', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitx-empty-'));
    const outcome = await installDependencies({ dir, config: config(), task: recordingTask() });

    expect(outcome.state).toBe('skipped');
    expect(outcome.reason).toBe('no recognised project');
  });

  it('skips when the package manager is disabled in config', async () => {
    const dir = await npmRepo();
    const outcome = await installDependencies({
      dir,
      config: config('[install]\n\tnpmEnabled = false\n'),
      task: recordingTask(),
    });

    expect(outcome).toMatchObject({ state: 'skipped', reason: 'npm disabled', manager: 'npm' });
  }, 120_000);

  it('skips when the package manager is not installed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitx-missing-pm-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', packageManager: 'yarn@4.1.0' }),
      'utf8',
    );
    await writeFile(path.join(dir, 'yarn.lock'), '', 'utf8');

    const originalPath = process.env['PATH'];
    try {
      // Nothing is on PATH, so no package manager can possibly be found.
      process.env['PATH'] = '';
      clearExecutableCache();
      const outcome = await installDependencies({ dir, config: config(), task: recordingTask() });
      expect(outcome).toMatchObject({ state: 'skipped', reason: 'yarn not installed' });
    } finally {
      process.env['PATH'] = originalPath;
      clearExecutableCache();
    }
  });

  it('installs with npm ci and leaves the repository clean', async () => {
    const dir = await npmRepo();
    const before = await readFile(path.join(dir, 'package-lock.json'), 'utf8');
    const task = recordingTask();

    const outcome = await installDependencies({ dir, config: config(), task });

    expect(outcome).toEqual({ state: 'installed', manager: 'npm' });
    expect(task.lines).toContain('+ npm ci --no-audit --no-fund');

    const status = await exec('git', ['status', '--porcelain'], { cwd: dir, env });
    expect(status.stdout.trim()).toBe('');
    expect(await readFile(path.join(dir, 'package-lock.json'), 'utf8')).toBe(before);
    expect(
      await readFile(path.join(dir, 'node_modules/picocolors/package.json'), 'utf8'),
    ).toContain('picocolors');
  }, 120_000);

  it('does not restore the lock file when told not to', async () => {
    const dir = await npmRepo();
    const task = recordingTask();

    await installDependencies({
      dir,
      config: config('[install]\n\tnpmRestoreLockfile = false\n'),
      task,
    });

    expect(task.lines).not.toContain('+ git checkout -- package-lock.json');
  }, 120_000);

  it('falls back to a plain install when the frozen install fails', async () => {
    const dir = await npmRepo();
    // Desynchronise the lock file so `npm ci` refuses to run.
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['ansi-styles'] = '6.2.1';
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2), 'utf8');

    const task = recordingTask();
    const outcome = await installDependencies({ dir, config: config(), task });

    expect(outcome.state).toBe('installed');
    expect(task.lines).toContain('frozen install failed, retrying with a regular install');
  }, 120_000);

  it('fails rather than falling back when the fallback is disabled', async () => {
    const dir = await npmRepo();
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['ansi-styles'] = '6.2.1';
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2), 'utf8');

    const outcome = await installDependencies({
      dir,
      config: config('[install]\n\tfrozenFallback = false\n'),
      task: recordingTask(),
    });

    expect(outcome.state).toBe('failed');
    expect(outcome.manager).toBe('npm');
  }, 120_000);
});
