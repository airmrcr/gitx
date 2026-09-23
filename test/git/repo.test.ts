import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterRepos,
  isDirty,
  isGitWorkTree,
  type Repo,
  statusPath,
  Workspace,
} from '../../src/git/repo.ts';

const fakeRepo = async (root: string, name: string, gitAsFile = false) => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  if (gitAsFile) {
    await writeFile(path.join(dir, '.git'), 'gitdir: ../elsewhere\n', 'utf8');
  } else {
    await mkdir(path.join(dir, '.git'), { recursive: true });
  }
};

const repos = (...names: string[]): Repo[] => names.map((name) => ({ name, dir: `/base/${name}` }));

const scratch = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'gitx-repo-'));

describe('Workspace paths', () => {
  it('nests repositories under the owner by default', () => {
    const workspace = new Workspace({ baseDir: '/dev', owner: 'acme', layout: 'nested' });
    expect(workspace.root).toBe(path.join('/dev', 'acme'));
    expect(workspace.dirFor('api')).toBe(path.join('/dev', 'acme', 'api'));
  });

  it('places repositories directly in the base directory when flat', () => {
    const workspace = new Workspace({ baseDir: '/dev', owner: 'acme', layout: 'flat' });
    expect(workspace.root).toBe('/dev');
    expect(workspace.dirFor('api')).toBe(path.join('/dev', 'api'));
  });

  it('nests a repository under a given owner, not the workspace owner, when nested', () => {
    const workspace = new Workspace({ baseDir: '/dev', owner: 'acme', layout: 'nested' });
    expect(workspace.dirFor('widgets', 'other-org')).toBe(
      path.join('/dev', 'other-org', 'widgets'),
    );
    // The workspace's own repositories are unaffected.
    expect(workspace.dirFor('api')).toBe(path.join('/dev', 'acme', 'api'));
  });

  it('ignores an owner override when flat, since there is no per-owner directory', () => {
    const workspace = new Workspace({ baseDir: '/dev', owner: 'acme', layout: 'flat' });
    expect(workspace.dirFor('widgets', 'other-org')).toBe(path.join('/dev', 'widgets'));
  });
});

describe('Workspace.discover', () => {
  it('returns an empty list when the root does not exist', async () => {
    const workspace = new Workspace({
      baseDir: path.join(tmpdir(), 'gitx-nope-does-not-exist'),
      owner: 'acme',
      layout: 'nested',
    });
    expect(await workspace.discover()).toEqual([]);
  });

  it('finds working trees sorted by name', async () => {
    const base = await scratch();
    const root = path.join(base, 'acme');
    await fakeRepo(root, 'zulu');
    await fakeRepo(root, 'alpha');
    await fakeRepo(root, 'mike');

    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });
    expect((await workspace.discover()).map((repo) => repo.name)).toEqual([
      'alpha',
      'mike',
      'zulu',
    ]);
  });

  it('ignores directories that are not working trees', async () => {
    const base = await scratch();
    const root = path.join(base, 'acme');
    await fakeRepo(root, 'real');
    await mkdir(path.join(root, 'not-a-repo'), { recursive: true });

    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });
    expect((await workspace.discover()).map((repo) => repo.name)).toEqual(['real']);
  });

  it('accepts a .git file, as used by worktrees and submodules', async () => {
    const base = await scratch();
    const root = path.join(base, 'acme');
    await fakeRepo(root, 'worktree', true);

    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });
    expect((await workspace.discover()).map((repo) => repo.name)).toEqual(['worktree']);
  });

  it('is shallow: nested repositories are not discovered', async () => {
    const base = await scratch();
    const root = path.join(base, 'acme');
    await fakeRepo(root, 'outer');
    await fakeRepo(path.join(root, 'outer'), 'inner');

    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });
    expect((await workspace.discover()).map((repo) => repo.name)).toEqual(['outer']);
  });

  it('skips dot-directories', async () => {
    const base = await scratch();
    const root = path.join(base, 'acme');
    await fakeRepo(root, '.hidden');
    await fakeRepo(root, 'visible');

    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });
    expect((await workspace.discover()).map((repo) => repo.name)).toEqual(['visible']);
  });

  it('creates the root on demand', async () => {
    const base = await scratch();
    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });
    await workspace.ensureRoot();
    expect(await isGitWorkTree(workspace.root)).toBe(false);
    expect(await workspace.discover()).toEqual([]);
  });
});

describe('Workspace.requireDir', () => {
  it('resolves the directory of a cloned repository', async () => {
    const base = await scratch();
    await fakeRepo(path.join(base, 'acme'), 'widgets');
    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });

    expect(await workspace.requireDir('widgets')).toBe(path.join(base, 'acme', 'widgets'));
  });

  it('fails with a hint when the repository has not been cloned', async () => {
    const base = await scratch();
    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });

    await expect(workspace.requireDir('widgets')).rejects.toMatchObject({
      message: expect.stringContaining('not cloned: widgets'),
      hint: expect.stringContaining('gitx clone widgets'),
      code: 19,
    });
  });

  it('rejects a directory that exists but is not a git working tree', async () => {
    const base = await scratch();
    await mkdir(path.join(base, 'acme', 'widgets'), { recursive: true });
    const workspace = new Workspace({ baseDir: base, owner: 'acme', layout: 'nested' });

    await expect(workspace.requireDir('widgets')).rejects.toMatchObject({ code: 19 });
  });
});

describe('filterRepos', () => {
  it('returns everything when no filters are given', () => {
    expect(filterRepos(repos('a', 'b')).selected.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('keeps only the requested names', () => {
    const result = filterRepos(repos('api', 'web', 'jobs'), { only: ['api', 'jobs'] });
    expect(result.selected.map((r) => r.name)).toEqual(['api', 'jobs']);
  });

  it('supports globs in the requested names', () => {
    const result = filterRepos(repos('api-a', 'api-b', 'web'), { only: ['api-*'] });
    expect(result.selected.map((r) => r.name)).toEqual(['api-a', 'api-b']);
  });

  it('reports requested names that matched nothing', () => {
    const result = filterRepos(repos('api'), { only: ['api', 'ghost', 'phantom-*'] });
    expect(result.unmatched).toEqual(['ghost', 'phantom-*']);
  });

  it('applies the skip list', () => {
    const result = filterRepos(repos('api', 'legacy', 'web'), { skip: ['legacy'] });
    expect(result.selected.map((r) => r.name)).toEqual(['api', 'web']);
  });

  it('applies skip globs after name filters', () => {
    const result = filterRepos(repos('api-a', 'api-b'), { only: ['api-*'], skip: ['*-b'] });
    expect(result.selected.map((r) => r.name)).toEqual(['api-a']);
  });

  it('starts after the named repository', () => {
    const result = filterRepos(repos('a', 'b', 'c', 'd'), { after: 'b' });
    expect(result.selected.map((r) => r.name)).toEqual(['c', 'd']);
  });

  it('resumes from a partial name that matches no repository', () => {
    const result = filterRepos(repos('alpha', 'bravo', 'charlie'), { after: 'b' });
    expect(result.selected.map((repo) => repo.name)).toEqual(['bravo', 'charlie']);
  });

  it('selects nothing when the cursor sorts past every repository', () => {
    const result = filterRepos(repos('a', 'b'), { after: 'zzz' });
    expect(result.selected).toEqual([]);
  });

  it('returns nothing when --after names the final repository', () => {
    expect(filterRepos(repos('a', 'b'), { after: 'b' }).selected).toEqual([]);
  });
});

describe('statusPath', () => {
  it('extracts the path from a porcelain line', () => {
    expect(statusPath('?? .idea/')).toBe('.idea/');
    expect(statusPath(' M src/index.ts')).toBe('src/index.ts');
    expect(statusPath('A  new file.txt')).toBe('new file.txt');
  });

  it('takes the destination of a rename', () => {
    expect(statusPath('R  old.txt -> new.txt')).toBe('new.txt');
  });

  it('unquotes paths containing special characters', () => {
    expect(statusPath('?? "spa ced.txt"')).toBe('spa ced.txt');
  });
});

describe('isDirty', () => {
  it('is clean with no status entries', () => {
    expect(isDirty([])).toBe(false);
  });

  it('is dirty with any entry when nothing is ignored', () => {
    expect(isDirty(['?? .idea/'])).toBe(true);
  });

  it('ignores configured paths', () => {
    expect(isDirty(['?? .idea/'], ['.idea/'])).toBe(false);
    expect(isDirty(['?? .idea/'], ['.idea'])).toBe(false);
  });

  it('ignores files beneath an ignored directory', () => {
    expect(isDirty(['?? .idea/workspace.xml'], ['.idea/'])).toBe(false);
  });

  it('is dirty when any entry is not ignored', () => {
    expect(isDirty(['?? .idea/', ' M src/index.ts'], ['.idea/'])).toBe(true);
  });

  it('supports globs in the ignore list', () => {
    expect(isDirty(['?? notes.local.md'], ['*.local.md'])).toBe(false);
  });
});
