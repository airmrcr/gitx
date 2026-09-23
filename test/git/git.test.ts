import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { exec } from '../../src/util/exec.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_AUTHOR_NAME: 'gitx tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'gitx tests',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const fixture = async (): Promise<{ remote: string; clone: string; repo: Git }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitx-git-'));
  const remote = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');

  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', remote, seed);
  await writeFile(path.join(seed, 'README.md'), '# hi\n', 'utf8');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'initial');
  await git(seed, 'push', '-u', 'origin', 'main');
  await git(root, 'clone', remote, clone);

  return { remote, clone, repo: new Git({ cwd: clone, env }) };
};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await exec('git', args, { cwd, env });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

describe('Git.isUpToDate', () => {
  it('recognises the modern message', () => {
    expect(Git.isUpToDate('Already up to date.')).toBe(true);
  });

  it('recognises the message without a full stop', () => {
    expect(Git.isUpToDate('Already up to date')).toBe(true);
  });

  it('matches when the message is buried in other output', () => {
    expect(Git.isUpToDate('From github.com:acme/api\nAlready up to date.\n')).toBe(true);
  });

  it('rejects output describing actual changes', () => {
    expect(Git.isUpToDate('Updating a1b2c3d..d4e5f6a\nFast-forward\n')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(Git.isUpToDate('')).toBe(false);
  });
});

describe('Git.isRepositoryGone', () => {
  it.each([
    'remote: Repository not found.',
    'remote: Not Found',
    'ERROR: Repository not found.',
    "fatal: repository 'https://github.com/acme/gone.git/' not found",
  ])('detects %j', (output) => {
    expect(Git.isRepositoryGone(output)).toBe(true);
  });

  it('ignores unrelated failures', () => {
    expect(Git.isRepositoryGone('fatal: could not read Username for https://github.com')).toBe(
      false,
    );
    expect(Git.isRepositoryGone('error: Your local changes would be overwritten')).toBe(false);
  });
});

describe('Git against a real repository', () => {
  let fx: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    fx = await fixture();
  });

  it('identifies a work tree', async () => {
    expect(await fx.repo.isRepository()).toBe(true);
  });

  it('rejects a directory that is not a repository', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'gitx-plain-'));
    expect(await new Git({ cwd: outside, env }).isRepository()).toBe(false);
  });

  it('reports the current branch', async () => {
    expect(await fx.repo.currentBranch()).toBe('main');
  });

  it('returns undefined for a detached HEAD', async () => {
    const head = await fx.repo.capture(['rev-parse', 'HEAD']);
    await fx.repo.checkout(head!);
    expect(await fx.repo.currentBranch()).toBeUndefined();
    await fx.repo.checkout('main');
  });

  it('resolves the default branch', async () => {
    expect(await fx.repo.defaultBranch()).toBe('main');
  });

  it('resolves the default branch even without a cached origin/HEAD', async () => {
    await fx.repo.run(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    expect(await fx.repo.defaultBranch()).toBe('main');
  });

  it('reports no default branch when there is no remote', async () => {
    const solo = await mkdtemp(path.join(tmpdir(), 'gitx-solo-'));
    await git(solo, 'init', '--initial-branch=main', '.');
    expect(await new Git({ cwd: solo, env }).defaultBranch()).toBeUndefined();
  });

  it('detects the origin remote', async () => {
    expect(await fx.repo.hasRemote()).toBe(true);
    expect(await fx.repo.hasRemote('upstream')).toBe(false);
  });

  it('returns an empty status for a clean tree', async () => {
    expect(await fx.repo.status()).toEqual([]);
  });

  it('lists changed paths', async () => {
    await writeFile(path.join(fx.clone, 'scratch.txt'), 'dirt\n', 'utf8');
    const status = await fx.repo.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toContain('scratch.txt');
  });

  it('reports no submodules for a plain repository', async () => {
    expect(await fx.repo.hasSubmodules()).toBe(false);
    expect(await fx.repo.submoduleStatus()).toEqual([]);
  });

  it('captures undefined when a command fails', async () => {
    expect(await fx.repo.capture(['rev-parse', '--verify', 'refs/heads/nope'])).toBeUndefined();
  });

  it('finds and deletes branches whose upstream has gone', async () => {
    const { clone, remote, repo } = await fixture();
    const scratch = path.dirname(clone);

    await git(clone, 'checkout', '-b', 'doomed');
    await git(clone, 'push', '-u', 'origin', 'doomed');
    await git(scratch, '--git-dir', remote, 'branch', '-D', 'doomed');
    await git(clone, 'checkout', 'main');
    await repo.fetch();

    expect(await repo.goneBranches()).toEqual(['doomed']);

    expect((await repo.deleteBranch('doomed')).ok).toBe(true);
    expect(await repo.goneBranches()).toEqual([]);
  });

  it('deleteBranch defaults to a safe delete, refusing a branch with unmerged commits', async () => {
    const { clone, repo } = await fixture();
    await git(clone, 'checkout', '-b', 'unmerged');
    await writeFile(path.join(clone, 'unmerged.txt'), 'wip\n', 'utf8');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-m', 'wip');
    await git(clone, 'checkout', 'main');

    expect((await repo.deleteBranch('unmerged')).ok).toBe(false);
    expect(await repo.capture(['rev-parse', '--verify', 'refs/heads/unmerged'])).toBeDefined();
  });

  it('deleteBranch force-deletes a branch with unmerged commits when asked', async () => {
    const { clone, repo } = await fixture();
    await git(clone, 'checkout', '-b', 'unmerged');
    await writeFile(path.join(clone, 'unmerged.txt'), 'wip\n', 'utf8');
    await git(clone, 'add', '.');
    await git(clone, 'commit', '-m', 'wip');
    await git(clone, 'checkout', 'main');

    expect((await repo.deleteBranch('unmerged', { force: true })).ok).toBe(true);
    expect(await repo.capture(['rev-parse', '--verify', 'refs/heads/unmerged'])).toBeUndefined();
  });

  it('ignores branches that still have a live upstream', async () => {
    const { clone, repo } = await fixture();
    await git(clone, 'checkout', '-b', 'alive');
    await git(clone, 'push', '-u', 'origin', 'alive');
    expect(await repo.goneBranches()).toEqual([]);
  });

  it('ignores purely local branches', async () => {
    const { clone, repo } = await fixture();
    await git(clone, 'branch', 'local-only');
    expect(await repo.goneBranches()).toEqual([]);
  });

  it('pulls new commits from the remote', async () => {
    const { clone, remote, repo } = await fixture();
    const other = path.join(path.dirname(clone), 'other');
    await git(path.dirname(clone), 'clone', remote, other);
    await writeFile(path.join(other, 'next.txt'), 'more\n', 'utf8');
    await git(other, 'add', '.');
    await git(other, 'commit', '-m', 'second');
    await git(other, 'push');

    await repo.fetch();
    const pulled = await repo.pull();
    expect(pulled.ok).toBe(true);
    expect(Git.isUpToDate(pulled.stdout)).toBe(false);

    const again = await repo.pull();
    expect(Git.isUpToDate(again.stdout)).toBe(true);
  });
});
