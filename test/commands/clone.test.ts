import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloneOps from '../../src/git/clone.ts';
import type * as Registry from '../../src/provider/registry.ts';

const cloneRepo = vi.fn<typeof CloneOps.cloneRepo>();

// The network/filesystem clone itself belongs to `test/git/clone.test.ts`; what matters here is
// which URL and directory `gitx clone` resolves to.
vi.mock('../../src/git/clone.ts', () => ({
  cloneRepo: (url: string, targetDir: string, options: CloneOps.CloneRepoOptions) =>
    cloneRepo(url, targetDir, options),
}));

vi.mock('../../src/provider/registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>();
  return {
    ...actual,
    createProvider: () => ({
      id: 'github',
      label: 'GitHub',
      host: 'github.com',
      runNoun: 'workflow run',
      currentLogin: async () => undefined,
      listRepos: async () => [],
      listRuns: async () => [],
    }),
  };
});

const { runClone } = await import('../../src/commands/clone.ts');
const { Context } = await import('../../src/context.ts');
const { Config } = await import('../../src/config/store.ts');

const context = async (layout: 'nested' | 'flat' = 'nested') => {
  const base = await mkdtemp(path.join(tmpdir(), 'gitx-clone-'));
  const text = `[core]\n\tbaseDir = ${base}\n\tlayout = ${layout}\n[remote]\n\towner = acme\n\tprovider = github\n\tprotocol = https\n`;
  return new Context(Config.parse(text, path.join(tmpdir(), 'gitx-clone-config')));
};

beforeEach(() => {
  cloneRepo.mockReset();
  cloneRepo.mockResolvedValue({
    command: 'git',
    args: [],
    cwd: '.',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    output: '',
    ok: true,
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runClone, owner overrides', () => {
  it('clones a plain name under the configured owner', async () => {
    const ctx = await context();
    const base = ctx.config.get('core.baseDir')!;

    await runClone(ctx, ['widgets'], {});

    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/acme/widgets.git',
      path.join(base, 'acme', 'widgets'),
      expect.anything(),
    );
  });

  it('clones owner/name under that owner, not the configured one', async () => {
    const ctx = await context();
    const base = ctx.config.get('core.baseDir')!;

    await runClone(ctx, ['other-org/widgets'], {});

    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/other-org/widgets.git',
      path.join(base, 'other-org', 'widgets'),
      expect.anything(),
    );
  });

  it('keeps every segment of a nested subgroup path, not just the first two', async () => {
    const ctx = await context();
    const base = ctx.config.get('core.baseDir')!;

    await runClone(ctx, ['acme/team/widgets'], {});

    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/acme/team/widgets.git',
      path.join(base, 'acme', 'team', 'widgets'),
      expect.anything(),
    );
  });

  it('ignores an owner override when the layout is flat, since there is no per-owner directory', async () => {
    const ctx = await context('flat');
    const base = ctx.config.get('core.baseDir')!;

    await runClone(ctx, ['other-org/widgets'], {});

    expect(cloneRepo).toHaveBeenCalledWith(
      'https://github.com/other-org/widgets.git',
      path.join(base, 'widgets'),
      expect.anything(),
    );
  });
});
