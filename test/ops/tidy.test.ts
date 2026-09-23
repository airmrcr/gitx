import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { tidyRepo } from '../../src/ops/tidy.ts';
import type { TaskContext } from '../../src/runner/task.ts';
import { exec } from '../../src/util/exec.ts';
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

const abandonBranch = async (clone: string, remote: string, branch: string): Promise<void> => {
  await git(clone, 'checkout', '-b', branch);
  await git(clone, 'push', '-u', 'origin', branch);
  await git(path.dirname(clone), '--git-dir', remote, 'branch', '-D', branch);
  await git(clone, 'checkout', 'main');
};

const fixture = async (): Promise<{ clone: string; remote: string; repo: Git }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitx-tidy-'));
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

  return { clone, remote, repo: new Git({ cwd: clone, env }) };
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const result = await exec('git', args, { cwd, env });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
};

const recordingTask = (): TaskContext & { lines: string[]; statuses: string[] } => {
  const lines: string[] = [];
  const statuses: string[] = [];
  return {
    lines,
    statuses,
    log: (line) => lines.push(line),
    echo: (command, args) => lines.push(formatCommand(command, args)),
    setStatus: (text) => statuses.push(text),
    signal: new AbortController().signal,
  };
};

describe('tidyRepo', () => {
  it('reports nothing to do for a pristine clone', async () => {
    const { repo } = await fixture();
    const task = recordingTask();

    expect(await tidyRepo(repo, task)).toEqual({ deleted: [], failed: [] });
  });

  it('deletes branches whose upstream has gone', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone');

    const task = recordingTask();
    expect(await tidyRepo(repo, task)).toEqual({ deleted: ['gone'], failed: [] });
    expect(await repo.goneBranches()).toEqual([]);
  });

  it('deletes several gone branches in one pass', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone-a');
    await abandonBranch(clone, remote, 'gone-b');

    const result = await tidyRepo(repo, recordingTask());
    expect(result.deleted.toSorted()).toEqual(['gone-a', 'gone-b']);
  });

  it('leaves live and purely local branches alone', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone');
    await git(clone, 'branch', 'local-only');
    await git(clone, 'checkout', '-b', 'alive');
    await git(clone, 'push', '-u', 'origin', 'alive');
    await git(clone, 'checkout', 'main');

    expect((await tidyRepo(repo, recordingTask())).deleted).toEqual(['gone']);
    const branches = await repo.capture([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    expect(branches?.split('\n').toSorted()).toEqual(['alive', 'local-only', 'main']);
  });

  it('fetches with --prune by default', async () => {
    const { repo } = await fixture();
    const task = recordingTask();
    await tidyRepo(repo, task);

    expect(task.lines).toContain('+ git fetch --prune');
    expect(task.statuses).toContain('fetching');
  });

  it('can skip the fetch', async () => {
    const { repo } = await fixture();
    const task = recordingTask();
    await tidyRepo(repo, task, { fetch: false });

    expect(task.lines).not.toContain('+ git fetch --prune');
  });

  it('prunes the remote-tracking ref itself, not just the local branch', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone');
    await tidyRepo(repo, recordingTask());

    const remotes = await repo.capture([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/remotes/origin',
    ]);
    expect(remotes).not.toContain('origin/gone');
  });

  it('records the branch it is deleting in the task status', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone');

    const task = recordingTask();
    await tidyRepo(repo, task);
    expect(task.statuses).toContain('deleting gone');
    expect(task.lines).toContain('+ git branch -D gone');
  });

  it('is idempotent', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone');

    await tidyRepo(repo, recordingTask());
    expect(await tidyRepo(repo, recordingTask())).toEqual({ deleted: [], failed: [] });
  });

  it('reports a branch it cannot delete as failed', async () => {
    const { clone, remote, repo } = await fixture();
    await abandonBranch(clone, remote, 'gone');
    // You cannot delete the branch you are standing on.
    await git(clone, 'checkout', 'gone');

    const result = await tidyRepo(repo, recordingTask());
    expect(result).toEqual({ deleted: [], failed: ['gone'] });
  });
});
