import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InstallOps from '../../src/ops/install.ts';
import { exec } from '../../src/util/exec.ts';

const installDependencies = vi.fn<typeof InstallOps.installDependencies>();

// Real installs belong in `test/ops/install.test.ts`; what matters here is
// whether `pull` asks for one, and where.
vi.mock('../../src/ops/install.ts', () => ({
  installDependencies: (options: InstallOps.InstallDependenciesOptions) =>
    installDependencies(options),
}));

const { pullCommand, runPull } = await import('../../src/commands/repo-commands.ts');
const { Context } = await import('../../src/context.ts');
const { Config } = await import('../../src/config/store.ts');

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'gitx tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'gitx tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await exec('git', args, { cwd, env });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

/** A clone named `widgets`, with one unpulled commit waiting on its remote. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'gitx-pull-'));
  const remote = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'widgets');

  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', remote, seed);
  await writeFile(path.join(seed, 'README.md'), '# hi\n', 'utf8');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'initial');
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(root, 'clone', remote, clone);

  await writeFile(path.join(seed, 'CHANGELOG.md'), '# later\n', 'utf8');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'later');
  await git(seed, 'push');

  // macOS puts the temporary directory behind a symlink, and git reports the
  // path it resolves to.
  return realpath(clone);
}

function context(text = '') {
  return new Context(Config.parse(text, path.join(tmpdir(), 'gitx-pull-config')));
}

const cwd = process.cwd();
let output = '';

beforeEach(() => {
  installDependencies.mockReset();
  installDependencies.mockResolvedValue({ state: 'installed', manager: 'npm' });
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  process.chdir(cwd);
  // The command actions set this directly; left behind it would leak into the
  // exit status of the test run itself.
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe('gitx pull --install', () => {
  it('does not install when it was not asked to', async () => {
    process.chdir(await fixture());

    expect(await runPull([], {})).toBe(0);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it('installs after a successful pull', async () => {
    const clone = await fixture();
    process.chdir(clone);

    expect(await runPull([], { getContext: async () => context() })).toBe(0);

    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(installDependencies.mock.calls[0]?.[0].dir).toBe(clone);
    expect(output).toContain('Installed with npm');
  });

  // You may be anywhere inside the working tree; the install belongs at its top.
  it('installs at the repository root, not the working directory', async () => {
    const clone = await fixture();
    await mkdir(path.join(clone, 'src', 'deep'), { recursive: true });
    process.chdir(path.join(clone, 'src', 'deep'));

    await runPull([], { getContext: async () => context() });

    expect(installDependencies.mock.calls[0]?.[0].dir).toBe(clone);
  });

  // Unlike `gitx update`, which installs only what changed: here you named the
  // one repository you are standing in, so doing nothing would be surprising.
  it('installs even when the pull brought nothing down', async () => {
    process.chdir(await fixture());
    await runPull([], {});

    expect(await runPull([], { getContext: async () => context() })).toBe(0);
    expect(installDependencies).toHaveBeenCalledTimes(1);
  });

  it('does not install when the pull failed', async () => {
    const clone = await fixture();
    process.chdir(clone);
    await git(clone, 'remote', 'set-url', 'origin', path.join(clone, 'nowhere.git'));

    expect(await runPull([], { getContext: async () => context() })).toBe(18);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it('reports a failed install with the install exit code', async () => {
    process.chdir(await fixture());
    installDependencies.mockResolvedValue({ state: 'failed', reason: 'npm exited with 1' });

    expect(await runPull([], { getContext: async () => context() })).toBe(32);
    expect(output).toContain('npm exited with 1');
  });

  it('explains a skip rather than claiming to have installed', async () => {
    process.chdir(await fixture());
    installDependencies.mockResolvedValue({ state: 'skipped', reason: 'no recognised project' });

    expect(await runPull([], { getContext: async () => context() })).toBe(0);
    expect(output).toContain('no recognised project');
  });

  it('honours skip.install, and says why', async () => {
    process.chdir(await fixture());

    const code = await runPull([], {
      getContext: async () => context('[skip]\n\tinstall = widgets\n'),
    });

    expect(code).toBe(0);
    expect(installDependencies).not.toHaveBeenCalled();
    expect(output).toContain('skip.install');
  });

  it('passes --clean through to the install', async () => {
    process.chdir(await fixture());

    await runPull([], { clean: true, getContext: async () => context() });

    expect(installDependencies.mock.calls[0]?.[0].clean).toBe(true);
  });

  it('installs normally when --clean was not given', async () => {
    process.chdir(await fixture());

    await runPull([], { getContext: async () => context() });

    expect(installDependencies.mock.calls[0]?.[0].clean).toBe(false);
  });

  // `--clean` has to reach the install on its own: forgetting to imply
  // `--install` would make it silently do nothing.
  it('implies --install when only --clean is given', async () => {
    process.chdir(await fixture());
    const command = pullCommand(async () => context());

    await command.parseAsync(['--clean'], { from: 'user' });

    expect(installDependencies).toHaveBeenCalledTimes(1);
    expect(installDependencies.mock.calls[0]?.[0].clean).toBe(true);
  });

  it('does not load any configuration for a plain pull', async () => {
    process.chdir(await fixture());
    let loaded = false;
    const command = pullCommand(async () => {
      loaded = true;
      return context();
    });

    await command.parseAsync([], { from: 'user' });

    expect(loaded).toBe(false);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it('tidies before installing', async () => {
    process.chdir(await fixture());

    await runPull([], { tidy: true, getContext: async () => context() });

    expect(output).toContain('Nothing to tidy.');
    expect(output.indexOf('Nothing to tidy.')).toBeLessThan(output.indexOf('Installed with npm'));
  });
});
