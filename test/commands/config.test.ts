import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configCommand } from '../../src/commands/config.ts';
import { exec } from '../../src/util/exec.ts';

const cwd = process.cwd();
let output = '';

const fakeEditor = async (code = 0) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-config-editor-'));
  const script = path.join(dir, 'editor');
  const out = path.join(dir, 'out');
  await writeFile(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\nexit ${code}\n`,
    { mode: 0o755 },
  );
  return { command: script, readCall: () => readFile(out, 'utf8') };
};

const fixture = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-config-'));
  const configPath = path.join(dir, '.gitxconfig');
  return { configPath, command: () => configCommand({ configPath: () => configPath }) };
};

const repo = async (name: string) => {
  const base = await mkdtemp(path.join(tmpdir(), 'gitx-config-repo-'));
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  const result = await exec('git', ['init', '-q'], { cwd: dir });
  if (!result.ok) throw new Error(`git init failed: ${result.stderr}`);
  return dir;
};

const run = async (command: ReturnType<typeof configCommand>, args: string[]): Promise<number> => {
  process.exitCode = 0;
  await command.parseAsync(args, { from: 'user' });
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return code;
};

beforeEach(() => {
  output = '';
  const capture = (chunk: unknown): boolean => {
    output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe('gitx config --repo', () => {
  it('writes and reads a named repository override, leaving the global value alone', async () => {
    const { configPath, command } = await fixture();

    expect(await run(command(), ['set', 'core.editor', 'idea', '--repo', 'my-repo'])).toBe(0);
    expect(await run(command(), ['set', 'core.editor', 'code'])).toBe(0);

    output = '';
    await run(command(), ['get', 'core.editor', '--repo', 'my-repo']);
    expect(output.trim()).toBe('idea');

    output = '';
    await run(command(), ['get', 'core.editor']);
    expect(output.trim()).toBe('code');

    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('[core "my-repo"]');
    expect(text).toContain('editor = idea');
  });

  it('falls back to the plain value for a repo with no override of its own', async () => {
    const { command } = await fixture();

    await run(command(), ['set', 'core.editor', 'code']);
    await run(command(), ['set', 'core.editor', 'idea', '--repo', 'my-repo']);

    output = '';
    await run(command(), ['get', 'core.editor', '--repo', 'other-repo']);
    expect(output.trim()).toBe('code');

    output = '';
    await run(command(), ['get', 'core.editor', '--repo', 'other-repo', '--default']);
    expect(output.trim()).toBe('code');
  });

  it('resolves --repo with no value to the repository containing the current directory', async () => {
    const { command } = await fixture();
    process.chdir(await repo('widgets'));

    expect(await run(command(), ['set', 'core.editor', 'idea', '--repo'])).toBe(0);

    output = '';
    await run(command(), ['get', 'core.editor', '--repo', 'widgets']);
    expect(output.trim()).toBe('idea');
  });

  it('fails with a hint when --repo has no value and cwd is not a repository', async () => {
    const { command } = await fixture();
    process.chdir(await mkdtemp(path.join(tmpdir(), 'gitx-config-norepo-')));

    await expect(
      command().parseAsync(['set', 'core.editor', 'idea', '--repo'], { from: 'user' }),
    ).rejects.toMatchObject({ hint: expect.stringContaining('--repo <name>') });
  });

  it('refuses a key that has not opted in to repository scoping', async () => {
    const { command } = await fixture();

    await expect(
      command().parseAsync(['set', 'remote.owner', 'acme', '--repo', 'my-repo'], { from: 'user' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('unknown configuration key') });
  });

  it('refuses to combine --repo with a key that already has a subsection', async () => {
    const { command } = await fixture();

    await expect(
      command().parseAsync(['set', 'install.npm.frozen', 'false', '--repo', 'my-repo'], {
        from: 'user',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('already scoped') });
  });

  it('scopes a flattened per-manager install key to a repository', async () => {
    const { configPath, command } = await fixture();

    expect(await run(command(), ['set', 'install.npmfrozen', 'false', '--repo', 'my-repo'])).toBe(
      0,
    );

    const text = await readFile(configPath, 'utf8');
    expect(text).toContain('[install "my-repo"]');
    expect(text).toContain('npmFrozen = false');
  });

  it('unsets a repository override without touching the global value', async () => {
    const { command } = await fixture();

    await run(command(), ['set', 'core.editor', 'idea', '--repo', 'my-repo']);
    await run(command(), ['set', 'core.editor', 'code']);

    expect(await run(command(), ['unset', 'core.editor', '--repo', 'my-repo'])).toBe(0);

    output = '';
    await run(command(), ['get', 'core.editor']);
    expect(output.trim()).toBe('code');
  });

  it('leaves get and unset lenient when --repo is not given, unlike set', async () => {
    const { command } = await fixture();

    // No assertKnownKey gate without --repo: matches existing get/unset behaviour.
    expect(await run(command(), ['get', 'made.up.key'])).toBe(1);
  });
});

describe('gitx config, unscoped', () => {
  it('still works exactly as before when --repo is never mentioned', async () => {
    const { command } = await fixture();

    expect(await run(command(), ['set', 'core.baseDir', '~/dev'])).toBe(0);

    output = '';
    await run(command(), ['get', 'core.baseDir']);
    expect(output.trim()).toBe('~/dev');
  });
});

describe('gitx config edit', () => {
  const originalEditor = process.env['EDITOR'];
  const originalVisual = process.env['VISUAL'];

  afterEach(() => {
    if (originalEditor === undefined) delete process.env['EDITOR'];
    else process.env['EDITOR'] = originalEditor;
    if (originalVisual === undefined) delete process.env['VISUAL'];
    else process.env['VISUAL'] = originalVisual;
  });

  it('creates the config file when it does not exist yet', async () => {
    const { command, configPath } = await fixture();
    const editor = await fakeEditor();
    process.env['EDITOR'] = editor.command;

    expect(await run(command(), ['edit'])).toBe(0);

    expect((await editor.readCall()).trim()).toBe(configPath);
    expect(await readFile(configPath, 'utf8')).toBe('');
  });

  it('never rewrites an existing file, so hand-written comments survive', async () => {
    const { command, configPath } = await fixture();
    const original = '# my personal notes\n[core]\n\tbaseDir = ~/dev # inline note\n';
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, original);
    process.env['EDITOR'] = (await fakeEditor()).command;

    await run(command(), ['edit']);

    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('splits extra words in $EDITOR as arguments before the path', async () => {
    const { command, configPath } = await fixture();
    const editor = await fakeEditor();
    process.env['EDITOR'] = `${editor.command} -n --wait`;

    await run(command(), ['edit']);

    expect((await editor.readCall()).trim().split('\n')).toEqual(['-n', '--wait', configPath]);
  });

  it('prefers $VISUAL over $EDITOR', async () => {
    const { command } = await fixture();
    const visual = await fakeEditor();
    process.env['EDITOR'] = 'definitely-not-used';
    process.env['VISUAL'] = visual.command;

    await run(command(), ['edit']);

    await expect(visual.readCall()).resolves.not.toBe('');
  });

  it('resolves to the editor process exit code', async () => {
    const { command } = await fixture();
    process.env['EDITOR'] = (await fakeEditor(3)).command;

    expect(await run(command(), ['edit'])).toBe(3);
  });

  it('fails with a hint when no editor is configured', async () => {
    const { command } = await fixture();
    delete process.env['EDITOR'];
    delete process.env['VISUAL'];

    await expect(command().parseAsync(['edit'], { from: 'user' })).rejects.toMatchObject({
      message: expect.stringContaining('no editor configured'),
    });
  });
});
