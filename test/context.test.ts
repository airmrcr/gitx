import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Registry from '../src/provider/registry.ts';

const promptText =
  vi.fn<(options: { message: string; defaultValue?: string }) => Promise<string>>();
const promptSelect = vi.fn<(options: { message: string }) => Promise<string>>();
const isInteractive = vi.fn<() => boolean>(() => true);

vi.mock('../src/util/prompt.ts', () => ({
  isInteractive: () => isInteractive(),
  promptText: (options: { message: string }) => promptText(options),
  promptSelect: (options: { message: string }) => promptSelect(options),
}));

vi.mock('../src/provider/registry.ts', async (importOriginal) => {
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

const { Context } = await import('../src/context.ts');
const { Config } = await import('../src/config/store.ts');

const context = async (text = '') => {
  const configPath = path.join(await mkdtemp(path.join(tmpdir(), 'gitx-ctx-')), 'config');
  return new Context(Config.parse(text, configPath));
};

beforeEach(() => {
  promptText.mockReset();
  promptSelect.mockReset();
  promptSelect.mockResolvedValue('github');
  isInteractive.mockReset();
  isInteractive.mockReturnValue(true);
});

describe('Context.workspace prompting', () => {
  it('never runs two prompts at the same time', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gitx-ws-'));
    let active = 0;
    let overlapped = false;

    const answer = async (value: string) => {
      active += 1;
      if (active > 1) overlapped = true;
      // Yield, so a concurrently started prompt would be observed here.
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value;
    };

    promptText.mockImplementation(async (options) =>
      answer(options.message.startsWith('Where') ? base : 'acme'),
    );
    promptSelect.mockImplementation(async () => answer('github'));

    await (await context()).workspace();

    expect(overlapped).toBe(false);
    expect(promptText).toHaveBeenCalledTimes(3);
    expect(promptSelect).toHaveBeenCalledTimes(1);
  });

  it('asks for the base directory before the owner', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gitx-ws-'));
    const asked: string[] = [];

    promptText.mockImplementation(async (options) => {
      asked.push(options.message);
      return options.message.startsWith('Where') ? base : 'acme';
    });

    await (await context()).workspace();

    expect(asked).toEqual([
      'Where should gitx keep your repositories?',
      'Which host should gitx use?',
      'Which organisation, group or user owns your repositories?',
    ]);
  });

  it('persists both answers and creates the workspace root', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gitx-ws-'));
    promptText.mockImplementation(async (options) =>
      options.message.startsWith('Where') ? base : 'acme',
    );

    const ctx = await context();
    const workspace = await ctx.workspace();

    expect(ctx.config.get('core.baseDir')).toBe(base);
    expect(ctx.config.get('remote.owner')).toBe('acme');
    expect(workspace.root).toBe(path.join(base, 'acme'));
    expect((await stat(workspace.root)).isDirectory()).toBe(true);
  });

  it('creates a base directory that does not exist yet', async () => {
    const base = path.join(await mkdtemp(path.join(tmpdir(), 'gitx-ws-')), 'not', 'there', 'yet');
    promptText.mockImplementation(async (options) =>
      options.message.startsWith('Where') ? base : 'acme',
    );

    const workspace = await (await context()).workspace();

    expect(workspace.root).toBe(path.join(base, 'acme'));
    expect((await stat(base)).isDirectory()).toBe(true);
    expect((await stat(workspace.root)).isDirectory()).toBe(true);
  });

  it('does not prompt at all when both values are configured', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gitx-ws-'));
    const ctx = await context(
      `[core]\n\tbaseDir = ${base}\n[remote]\n\towner = acme\n\tprovider = github\n`,
    );

    await ctx.workspace();

    expect(promptText).not.toHaveBeenCalled();
    expect(promptSelect).not.toHaveBeenCalled();
  });

  it('only prompts for the value that is missing', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'gitx-ws-'));
    promptText.mockResolvedValue('acme');

    await (
      await context(`[core]\n\tbaseDir = ${base}\n[github]\n\thost = github.com\n`)
    ).workspace();

    expect(promptText).toHaveBeenCalledTimes(1);
    expect(promptText.mock.calls.at(-1)?.[0].message).toContain('organisation');
  });

  it('fails with a hint instead of prompting under --no-input', async () => {
    const ctx = new Context(Config.parse('', '/tmp/gitx-noinput'), { noInput: true });

    await expect(ctx.workspace()).rejects.toMatchObject({
      message: expect.stringContaining('core.baseDir'),
    });
    expect(promptText).not.toHaveBeenCalled();
  });
});

describe('Context.protocol', () => {
  it('asks once and remembers the answer', async () => {
    promptSelect.mockResolvedValue('ssh');
    const ctx = await context();

    expect(await ctx.protocol()).toBe('ssh');
    expect(await ctx.protocol()).toBe('ssh');

    expect(promptSelect).toHaveBeenCalledTimes(1);
    expect(promptSelect.mock.calls[0]?.[0].message).toBe('Which protocol should gitx clone with?');
    expect(ctx.config.get('remote.protocol')).toBe('ssh');
  });

  it('does not ask when it is already configured', async () => {
    const ctx = await context('[remote]\n\tprotocol = ssh\n');

    expect(await ctx.protocol()).toBe('ssh');
    expect(promptSelect).not.toHaveBeenCalled();
  });

  it('falls back to https when there is nobody to ask', async () => {
    const ctx = new Context(Config.parse('', '/tmp/gitx-protocol'), { noInput: true });

    expect(await ctx.protocol()).toBe('https');
    expect(promptSelect).not.toHaveBeenCalled();
  });

  it('does not persist the fallback it was never told to use', async () => {
    const ctx = new Context(Config.parse('', '/tmp/gitx-protocol'), { noInput: true });

    await ctx.protocol();

    expect(ctx.config.getRaw('remote.protocol')).toBeUndefined();
  });

  it('rejects a value hand-edited into the config file', async () => {
    const ctx = await context('[remote]\n\tprotocol = telnet\n');

    await expect(ctx.protocol()).rejects.toMatchObject({
      message: expect.stringContaining('https or ssh'),
    });
  });
});

describe('Context.editor', () => {
  const originalVisual = process.env['VISUAL'];
  const originalEditor = process.env['EDITOR'];

  afterEach(() => {
    if (originalVisual === undefined) delete process.env['VISUAL'];
    else process.env['VISUAL'] = originalVisual;
    if (originalEditor === undefined) delete process.env['EDITOR'];
    else process.env['EDITOR'] = originalEditor;
  });

  it('asks once and remembers the answer', async () => {
    delete process.env['VISUAL'];
    delete process.env['EDITOR'];
    promptText.mockResolvedValue('code');
    const ctx = await context();

    expect(await ctx.editor()).toBe('code');
    expect(await ctx.editor()).toBe('code');

    expect(promptText).toHaveBeenCalledTimes(1);
    expect(promptText.mock.calls[0]?.[0].message).toBe(
      'Which command should gitx use to open a repository?',
    );
    expect(ctx.config.get('core.editor')).toBe('code');
  });

  it('does not ask when it is already configured', async () => {
    const ctx = await context('[core]\n\teditor = code\n');

    expect(await ctx.editor()).toBe('code');
    expect(promptText).not.toHaveBeenCalled();
  });

  it('suggests $VISUAL, then $EDITOR, as an editable starting point', async () => {
    delete process.env['VISUAL'];
    process.env['EDITOR'] = 'vim';
    promptText.mockResolvedValue('vim');

    await (await context()).editor();

    const firstCall = promptText.mock.calls[0]?.[0] as { initialValue?: string } | undefined;
    expect(firstCall?.initialValue).toBe('vim');

    promptText.mockReset();
    promptText.mockResolvedValue('code');
    process.env['VISUAL'] = 'code';

    await (await context()).editor();

    const secondCall = promptText.mock.calls[0]?.[0] as { initialValue?: string } | undefined;
    expect(secondCall?.initialValue).toBe('code');
  });

  it('prefers a flag over configuration, and does not persist it', async () => {
    const ctx = await context('[core]\n\teditor = code\n');

    expect(await ctx.editor(undefined, 'idea')).toBe('idea');
    expect(promptText).not.toHaveBeenCalled();
    expect(ctx.config.get('core.editor')).toBe('code');
  });

  it('prefers a repo-scoped override over the plain setting', async () => {
    const ctx = await context('[core]\n\teditor = code\n[core "my-repo"]\n\teditor = idea\n');

    expect(await ctx.editor('my-repo')).toBe('idea');
    expect(await ctx.editor('other-repo')).toBe('code');
    expect(promptText).not.toHaveBeenCalled();
  });

  it('prefers a flag over a repo-scoped override', async () => {
    const ctx = await context('[core "my-repo"]\n\teditor = idea\n');

    expect(await ctx.editor('my-repo', 'vim')).toBe('vim');
  });

  it('has no neutral default to fall back to under --no-input', async () => {
    const ctx = new Context(Config.parse('', '/tmp/gitx-editor'), { noInput: true });

    await expect(ctx.editor()).rejects.toMatchObject({
      message: expect.stringContaining('core.editor'),
    });
    expect(promptText).not.toHaveBeenCalled();
  });
});

describe('Context.signal', () => {
  it('exposes whatever signal it was constructed with', () => {
    const controller = new AbortController();
    const ctx = new Context(Config.parse(''), { signal: controller.signal });

    expect(ctx.signal).toBe(controller.signal);
  });

  it('is undefined when none was given', () => {
    const ctx = new Context(Config.parse(''));

    expect(ctx.signal).toBeUndefined();
  });
});

describe('skip lists', () => {
  it('reads each operation from its own key', async () => {
    const ctx = await context('[skip]\n\tinstall = docs-*\n\tupdate = legacy\n');

    expect(ctx.skipList('install')).toEqual(['docs-*']);
    expect(ctx.skipList('update')).toEqual(['legacy']);
  });

  it('does not leak one operation into another', async () => {
    const ctx = await context('[skip]\n\tinstall = docs-*\n');

    expect(ctx.skipList('update')).toEqual([]);
  });
});
