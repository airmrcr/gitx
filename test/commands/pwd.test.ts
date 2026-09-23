import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pwdCommand, runPwd } from '../../src/commands/pwd.ts';
import { Config } from '../../src/config/store.ts';
import { Context } from '../../src/context.ts';
import { exec } from '../../src/util/exec.ts';

let output = '';

const context = (base: string) => {
  const text = `[core]\n\tbaseDir = ${base}\n[remote]\n\towner = acme\n\tprovider = github\n`;
  return new Context(Config.parse(text, path.join(tmpdir(), 'gitx-pwd-config')));
};

const fixture = async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'gitx-pwd-'));
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

describe('runPwd', () => {
  it('prints the repository directory', async () => {
    const { base, repoDir } = await fixture();

    expect(await runPwd(context(base), 'widgets')).toBe(0);
    expect(output.trim()).toBe(repoDir);
  });

  it('does not require an editor to be configured', async () => {
    const { base } = await fixture();

    await expect(runPwd(context(base), 'widgets')).resolves.toBe(0);
  });

  it('fails with a hint when the repository has not been cloned', async () => {
    const { base } = await fixture();

    await expect(runPwd(context(base), 'ghost')).rejects.toMatchObject({
      message: expect.stringContaining('ghost'),
      hint: expect.stringContaining('gitx clone ghost'),
      code: 19,
    });
  });
});

describe('pwdCommand', () => {
  it('wires the repository argument through to runPwd', async () => {
    const { base, repoDir } = await fixture();
    const command = pwdCommand(async () => context(base));

    await command.parseAsync(['widgets'], { from: 'user' });

    expect(output.trim()).toBe(repoDir);
  });
});
