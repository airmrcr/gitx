import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GitModule from '../../src/git/git.ts';
import type { ExecResult } from '../../src/util/exec.ts';

// Repos whose fetch/pull behaviour is driven by their name, not real git.
const FIXED_OUTCOMES = new Set(['gone-repo', 'broken-repo', 'good-repo']);

const fakeResult = (ok: boolean, output: string): ExecResult => ({
  command: 'git',
  args: [],
  cwd: '.',
  exitCode: ok ? 0 : 1,
  signal: null,
  stdout: output,
  stderr: ok ? '' : output,
  output,
  ok,
});

vi.mock('../../src/git/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof GitModule>();

  class FakeGit extends actual.Git {
    #name = path.basename(this.cwd);

    override fetch(): Promise<ExecResult> {
      if (this.#name === 'gone-repo') {
        return Promise.resolve(fakeResult(false, "fatal: repository 'acme/gone-repo' not found"));
      }
      return Promise.resolve(fakeResult(true, ''));
    }

    override currentBranch(): Promise<string | undefined> {
      return FIXED_OUTCOMES.has(this.#name) ? Promise.resolve('main') : super.currentBranch();
    }

    override defaultBranch(): Promise<string | undefined> {
      return FIXED_OUTCOMES.has(this.#name) ? Promise.resolve('main') : super.defaultBranch();
    }

    override status(): Promise<string[]> {
      return FIXED_OUTCOMES.has(this.#name) ? Promise.resolve([]) : super.status();
    }

    override hasSubmodules(): Promise<boolean> {
      return FIXED_OUTCOMES.has(this.#name) ? Promise.resolve(false) : super.hasSubmodules();
    }

    override pull(): Promise<ExecResult> {
      if (this.#name === 'broken-repo') {
        return Promise.resolve(fakeResult(false, 'non-fast-forward'));
      }
      return Promise.resolve(fakeResult(true, 'Already up to date.'));
    }
  }

  return { ...actual, Git: FakeGit };
});

const { runUpdate } = await import('../../src/commands/update.ts');
const { Context } = await import('../../src/context.ts');
const { Config } = await import('../../src/config/store.ts');

let output = '';

const context = (base: string, signal?: AbortSignal): InstanceType<typeof Context> => {
  const text = `[core]\n\tbaseDir = ${base}\n\tlayout = flat\n[remote]\n\towner = acme\n\tprovider = github\n`;
  return new Context(Config.parse(text, path.join(tmpdir(), 'gitx-update-config')), { signal });
};

const workspace = async (repoNames: readonly string[]) => {
  const base = await mkdtemp(path.join(tmpdir(), 'gitx-update-'));
  for (const name of repoNames) {
    await mkdir(path.join(base, name, '.git'), { recursive: true });
  }
  return base;
};

beforeEach(() => {
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
  vi.restoreAllMocks();
});

describe('runUpdate exit codes', () => {
  it('reports ExitCode.NotFound when a remote is gone and nothing else failed', async () => {
    const base = await workspace(['gone-repo']);

    expect(await runUpdate(context(base), [], {})).toBe(19);
    expect(output).toContain('Missing from the remote:');
  });

  it('still reports ExitCode.Pull when another repository genuinely failed to pull', async () => {
    const base = await workspace(['gone-repo', 'broken-repo']);

    const code = await runUpdate(context(base), [], {});

    expect(output).toContain('Missing from the remote:');
    expect(output).toContain('Failed:');
    expect(code).toBe(18);
  });

  it('reports ExitCode.Ok when everything succeeds', async () => {
    const base = await workspace(['good-repo']);

    expect(await runUpdate(context(base), [], {})).toBe(0);
  });
});

describe('runUpdate, Ctrl-C cancellation', () => {
  // Proves the sweep actually receives `context.signal`: before it was wired through, an aborted
  // signal had no effect at all and every repo still ran.
  it('skips repositories as cancelled once the signal is already aborted', async () => {
    const base = await workspace(['good-repo']);
    const controller = new AbortController();
    controller.abort();

    await runUpdate(context(base, controller.signal), [], {});

    expect(output).toContain('Skipped:');
    expect(output).not.toContain('Updated:');
  });
});
