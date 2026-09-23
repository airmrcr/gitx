import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Registry from '../../src/provider/registry.ts';

interface FakeRepo {
  name: string;
  isArchived: boolean;
}

const listRepos = vi.fn<() => Promise<FakeRepo[]>>(async () => []);

// A terminal is assumed so the porcelain no-prompt guard is actually exercised; under vitest stdin
// is not a TTY, which would make the test pass for the wrong reason.
const promptText = vi.fn<() => Promise<string>>(async () => 'unexpected');
const promptSelect = vi.fn<() => Promise<string>>(async () => 'unexpected');

vi.mock('../../src/util/prompt.ts', () => ({
  isInteractive: () => true,
  promptText: () => promptText(),
  promptSelect: () => promptSelect(),
}));

// The provider is faked at the registry, which is the seam every command reaches the network
// through.
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
      listRuns: async () => [],
      async listRepos() {
        const repos = await listRepos();
        return repos.map((repo) => ({
          name: repo.name,
          path: `acme/${repo.name}`,
          archived: repo.isArchived,
          defaultBranch: 'main',
          cloneUrl: {
            ssh: `git@github.com:acme/${repo.name}.git`,
            https: `https://github.com/acme/${repo.name}.git`,
          },
        }));
      },
    }),
  };
});

const { runList } = await import('../../src/commands/list.ts');
const { Context } = await import('../../src/context.ts');
const { Config } = await import('../../src/config/store.ts');
const { ExitCode } = await import('../../src/util/errors.ts');
const { setColorMode } = await import('../../src/util/theme.ts');

// A capture stream that satisfies the bits of WriteStream the command uses.
const capture = (isTTY = false) => {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    columns: 80,
    rows: 24,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return {
    stream,
    get text() {
      return chunks.join('');
    },
    get lines() {
      return chunks.join('').split('\n').filter(Boolean);
    },
  };
};

// Returns whatever `run` throws, so assertions stay out of a catch block.
const captureError = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

const contextFor = async (repos: readonly string[], extra = '') => {
  const base = await workspace(repos);
  const text = `[core]\n\tbaseDir = ${base}\n\tlayout = flat\n[remote]\n\towner = acme\n\tprovider = github\n[github]\n\thost = github.com\n${extra}`;
  const configPath = path.join(await mkdtemp(path.join(tmpdir(), 'gitx-cfg-')), 'config');
  return new Context(Config.parse(text, configPath));
};

const workspace = async (repos: readonly string[]) => {
  const base = await mkdtemp(path.join(tmpdir(), 'gitx-list-'));
  for (const name of repos) await mkdir(path.join(base, name, '.git'), { recursive: true });
  return base;
};

setColorMode('never');

beforeEach(() => {
  listRepos.mockReset();
  listRepos.mockResolvedValue([]);
  promptText.mockReset();
  promptText.mockResolvedValue('unexpected');
  promptSelect.mockReset();
  promptSelect.mockResolvedValue('unexpected');
});

describe('runList', () => {
  it('lists cloned repositories one per line', async () => {
    const context = await contextFor(['beta', 'alpha']);
    const out = capture();
    const err = capture();

    const code = await runList(context, [], {}, out.stream, err.stream);

    expect(code).toBe(ExitCode.Ok);
    expect(out.lines).toEqual(['✔ alpha', '✔ beta']);
    expect(err.text).toBe('\n2 repositories\n');
    // The default listing is local: nothing should reach the provider.
    expect(listRepos).not.toHaveBeenCalled();
  });

  it('ignores directories that are not git working trees', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gitx-list-'));
    await mkdir(path.join(base, 'real', '.git'), { recursive: true });
    await mkdir(path.join(base, 'notrepo'), { recursive: true });
    const configPath = path.join(await mkdtemp(path.join(tmpdir(), 'gitx-cfg-')), 'config');
    const context = new Context(
      Config.parse(
        `[core]\n\tbaseDir = ${base}\n\tlayout = flat\n[remote]\n\towner = acme\n\tprovider = github\n[github]\n\thost = github.com\n`,
        configPath,
      ),
    );

    const out = capture();
    await runList(context, [], {}, out.stream, capture().stream);

    expect(out.lines).toEqual(['✔ real']);
  });

  it('applies name globs and reports patterns that matched nothing', async () => {
    const context = await contextFor(['api-one', 'api-two', 'web']);
    const out = capture();
    const err = capture();

    const code = await runList(context, ['api-*', 'nope'], {}, out.stream, err.stream);

    expect(out.lines).toEqual(['✔ api-one', '✔ api-two']);
    expect(err.text).toContain("no repository matched 'nope'");
    expect(code).toBe(ExitCode.Ok);
  });

  it('does not hide repositories because of skip.install or skip.update', async () => {
    const context = await contextFor(
      ['alpha', 'beta'],
      '[skip]\n\tinstall = beta\n\tupdate = alpha\n',
    );
    const out = capture();

    await runList(context, [], {}, out.stream, capture().stream);

    expect(out.lines).toEqual(['✔ alpha', '✔ beta']);
  });

  it('reports not found when every requested pattern missed', async () => {
    const context = await contextFor(['alpha']);
    const err = capture();

    const code = await runList(context, ['nope'], {}, capture().stream, err.stream);

    expect(code).toBe(ExitCode.NotFound);
  });

  it('stays quiet on stdout when nothing is cloned', async () => {
    const context = await contextFor([]);
    const out = capture();
    const err = capture();

    const code = await runList(context, [], {}, out.stream, err.stream);

    expect(code).toBe(ExitCode.Ok);
    expect(out.text).toBe('');
    expect(err.text).toContain('No repositories cloned yet');
  });

  it('marks cloned and missing repositories with --all', async () => {
    const context = await contextFor(['alpha']);
    listRepos.mockResolvedValue([
      { name: 'alpha', isArchived: false },
      { name: 'zeta', isArchived: false },
    ]);
    const out = capture();
    const err = capture();

    await runList(context, [], { all: true }, out.stream, err.stream);

    expect(listRepos).toHaveBeenCalledOnce();
    // A fully configured workspace must never stop to ask anything.
    expect(promptText).not.toHaveBeenCalled();
    expect(promptSelect).not.toHaveBeenCalled();
    expect(out.lines).toEqual(['✔ alpha', '○ zeta']);
    expect(err.text).toContain('1 cloned');
    expect(err.text).toContain('1 missing');
  });

  it('marks uncloned repositories with --missing too', async () => {
    const context = await contextFor(['alpha']);
    listRepos.mockResolvedValue([
      { name: 'alpha', isArchived: false },
      { name: 'zeta', isArchived: false },
    ]);
    const out = capture();

    await runList(context, [], { missing: true }, out.stream, capture().stream);

    expect(out.lines).toEqual(['○ zeta']);
  });

  it('says everything is cloned when nothing is missing', async () => {
    const context = await contextFor(['alpha']);
    listRepos.mockResolvedValue([{ name: 'alpha', isArchived: false }]);
    const err = capture();

    await runList(context, [], { missing: true }, capture().stream, err.stream);

    expect(err.text).toContain('Everything is already cloned.');
  });

  it('writes nothing but names with --porcelain', async () => {
    const context = await contextFor(['alpha', 'beta']);
    const out = capture();
    const err = capture();

    await runList(context, [], { porcelain: true }, out.stream, err.stream);

    expect(out.lines).toEqual(['alpha', 'beta']);
    expect(err.text).toBe('');
  });

  it('never draws a spinner with --porcelain, even on a terminal', async () => {
    const context = await contextFor(['alpha']);
    listRepos.mockResolvedValue([{ name: 'zeta', isArchived: false }]);
    const err = capture(true);

    await runList(context, [], { all: true, porcelain: true }, capture().stream, err.stream);

    expect(err.text).toBe('');
  });

  it('draws a spinner on a terminal when not porcelain', async () => {
    const context = await contextFor(['alpha']);
    const err = capture(true);

    await runList(context, [], {}, capture().stream, err.stream);

    expect(err.text).toContain('Looking for cloned repositories');
  });

  it('still reports unmatched filters with --porcelain', async () => {
    const context = await contextFor(['alpha']);
    const out = capture();
    const err = capture();

    const code = await runList(context, ['nope'], { porcelain: true }, out.stream, err.stream);

    expect(err.text).toContain("no repository matched 'nope'");
    expect(out.text).toBe('');
    expect(code).toBe(ExitCode.NotFound);
  });

  it('refuses to prompt with --porcelain', async () => {
    const configPath = path.join(await mkdtemp(path.join(tmpdir(), 'gitx-cfg-')), 'config');
    const context = new Context(
      Config.parse(
        '[remote]\n\towner = acme\n\tprovider = github\n[github]\n\thost = github.com\n',
        configPath,
      ),
    );
    const out = capture();

    const error = await captureError(() =>
      runList(context, [], { porcelain: true }, out.stream, capture().stream),
    );

    expect(String(error)).toContain('core.baseDir');
    expect(promptText).not.toHaveBeenCalled();
    expect(promptSelect).not.toHaveBeenCalled();
    expect(out.text).toBe('');
  });

  it('says nothing at all when porcelain finds nothing', async () => {
    const context = await contextFor([]);
    const out = capture();
    const err = capture();

    await runList(context, [], { porcelain: true }, out.stream, err.stream);

    expect(out.text).toBe('');
    expect(err.text).toBe('');
  });

  it('prints bare names with --porcelain', async () => {
    const context = await contextFor(['alpha']);
    listRepos.mockResolvedValue([
      { name: 'alpha', isArchived: false },
      { name: 'zeta', isArchived: false },
    ]);
    const out = capture();

    await runList(context, [], { all: true, porcelain: true }, out.stream, capture().stream);

    expect(out.lines).toEqual(['alpha', 'zeta']);
  });

  it('does not lead the empty message with a blank line', async () => {
    const context = await contextFor([]);
    const err = capture();

    await runList(context, [], {}, capture().stream, err.stream);

    expect(err.text.startsWith('\n')).toBe(false);
  });

  it('breaks the summary down only when both states are present', async () => {
    const context = await contextFor(['alpha', 'beta']);
    const err = capture();

    await runList(context, [], {}, capture().stream, err.stream);

    expect(err.text).toContain('2 repositories');
    expect(err.text).not.toContain('cloned');
  });

  it('lists every remote repository, skip lists notwithstanding', async () => {
    const context = await contextFor([], '[skip]\n\tinstall = legacy-*\n');
    listRepos.mockResolvedValue([
      { name: 'legacy-api', isArchived: false },
      { name: 'shiny', isArchived: false },
    ]);
    const out = capture();

    await runList(context, [], { missing: true }, out.stream, capture().stream);

    expect(out.lines).toEqual(['○ legacy-api', '○ shiny']);
  });
});
