import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openCommand, runOpen } from '../../src/commands/open.ts';
import { Config } from '../../src/config/store.ts';
import { Context } from '../../src/context.ts';
import { exec } from '../../src/util/exec.ts';

let output = '';

const context = (base: string, coreExtra = '') => {
  const text = `[core]\n\tbaseDir = ${base}\n${coreExtra}[remote]\n\towner = acme\n\tprovider = github\n`;
  return new Context(Config.parse(text, path.join(tmpdir(), 'gitx-open-config')));
};

const fakeEditor = async (code = 0) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-open-editor-'));
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
  const base = await mkdtemp(path.join(tmpdir(), 'gitx-open-'));
  const repoDir = path.join(base, 'acme', 'widgets');
  await mkdir(repoDir, { recursive: true });
  await exec('git', ['init', '-q'], { cwd: repoDir });
  return { base, repoDir };
};

beforeEach(() => {
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
});

describe('runOpen', () => {
  it('launches the configured editor with the repository path appended', async () => {
    const { base, repoDir } = await fixture();
    const editor = await fakeEditor();
    const ctx = context(base, `\teditor = ${editor.command}\n`);

    const code = await runOpen(ctx, 'widgets', {});

    expect(code).toBe(0);
    expect((await editor.readCall()).trim()).toBe(repoDir);
    expect(output).toContain(editor.command);
  });

  it('splits extra words in core.editor as arguments before the path', async () => {
    const { base, repoDir } = await fixture();
    const editor = await fakeEditor();
    const ctx = context(base, `\teditor = ${editor.command} -n --wait\n`);

    await runOpen(ctx, 'widgets', {});

    expect((await editor.readCall()).trim().split('\n')).toEqual(['-n', '--wait', repoDir]);
  });

  it('resolves to the editor process exit code', async () => {
    const { base } = await fixture();
    const editor = await fakeEditor(3);
    const ctx = context(base, `\teditor = ${editor.command}\n`);

    expect(await runOpen(ctx, 'widgets', {})).toBe(3);
  });

  it('prefers --editor over configuration, without persisting it', async () => {
    const { base, repoDir } = await fixture();
    const configured = await fakeEditor();
    const override = await fakeEditor();
    const ctx = context(base, `\teditor = ${configured.command}\n`);

    await runOpen(ctx, 'widgets', { editor: override.command });

    expect((await override.readCall()).trim()).toBe(repoDir);
    expect(ctx.config.get('core.editor')).toBe(configured.command);
  });

  it('fails with a hint when the repository has not been cloned', async () => {
    const { base } = await fixture();
    const ctx = context(base, '\teditor = code\n');

    await expect(runOpen(ctx, 'ghost', {})).rejects.toMatchObject({
      message: expect.stringContaining('ghost'),
      hint: expect.stringContaining('gitx clone ghost'),
    });
  });

  it('fails with a hint when the editor command does not exist', async () => {
    const { base } = await fixture();
    const ctx = context(base, '\teditor = definitely-not-a-real-editor-binary\n');

    await expect(runOpen(ctx, 'widgets', {})).rejects.toMatchObject({
      message: expect.stringContaining('definitely-not-a-real-editor-binary'),
      code: 2,
    });
  });
});

describe('openCommand', () => {
  it('wires the repository argument and --editor through to runOpen', async () => {
    const { base, repoDir } = await fixture();
    const editor = await fakeEditor();
    const command = openCommand(async () => context(base));

    await command.parseAsync(['widgets', '--editor', editor.command], { from: 'user' });

    expect((await editor.readCall()).trim()).toBe(repoDir);
  });
});
