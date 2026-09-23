import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandNames, resolveAlias, runShellAlias } from '../src/alias.ts';
import { createProgram } from '../src/cli.ts';
import { Config } from '../src/config/store.ts';

const program = createProgram();

const configFrom = async (text: string): Promise<Config> => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'gitx-alias-')), 'config');
  return Config.parse(text, file);
};

// Resolves `gitx <args…>` against an in-memory configuration.
const resolve = async (text: string, ...args: string[]) => {
  const config = await configFrom(text);
  return resolveAlias(['node', 'gitx', ...args], program, async () => config);
};

// The arguments left after the executable and script name.
const tail = (resolution: Awaited<ReturnType<typeof resolve>>): string[] => {
  if (resolution.kind !== 'argv') throw new Error('expected an argv resolution');
  return resolution.argv.slice(2);
};

describe('resolveAlias', () => {
  it('leaves a real command alone', async () => {
    expect(tail(await resolve('[alias]\n\tupdate = list\n', 'update', '-j', '4'))).toEqual([
      'update',
      '-j',
      '4',
    ]);
  });

  it('never lets an alias shadow a built-in command', async () => {
    expect(tail(await resolve('[alias]\n\tlist = clone-all\n', 'list'))).toEqual(['list']);
  });

  it('lets an alias take a name that used to be built in', async () => {
    expect(tail(await resolve('[alias]\n\tup = update --install\n', 'up'))).toEqual([
      'update',
      '--install',
    ]);
  });

  it('expands a simple alias', async () => {
    expect(tail(await resolve('[alias]\n\tll = list\n', 'll'))).toEqual(['list']);
  });

  it('expands an alias that carries its own flags', async () => {
    expect(tail(await resolve('[alias]\n\tll = list --porcelain\n', 'll'))).toEqual([
      'list',
      '--porcelain',
    ]);
  });

  it('appends the arguments the user supplied', async () => {
    expect(tail(await resolve('[alias]\n\tll = list --porcelain\n', 'll', 'api-*', '-a'))).toEqual([
      'list',
      '--porcelain',
      'api-*',
      '-a',
    ]);
  });

  it('respects quoting in the alias value', async () => {
    expect(tail(await resolve("[alias]\n\tapi = list 'api-* web-*'\n", 'api'))).toEqual([
      'list',
      'api-* web-*',
    ]);
  });

  it('keeps global options ahead of the expansion', async () => {
    const resolution = await resolve('[alias]\n\tll = list\n', '-j', '4', '--color', 'never', 'll');
    expect(tail(resolution)).toEqual(['-j', '4', '--color', 'never', 'list']);
  });

  it('is not fooled by a global option whose value looks like an alias', async () => {
    const resolution = await resolve('[alias]\n\tll = list\n', '--owner', 'll', 'll');
    expect(tail(resolution)).toEqual(['--owner', 'll', 'list']);
  });

  it('handles an attached option value', async () => {
    expect(tail(await resolve('[alias]\n\tll = list\n', '--owner=ll', 'll'))).toEqual([
      '--owner=ll',
      'list',
    ]);
  });

  it('expands an alias that points at another alias', async () => {
    expect(tail(await resolve('[alias]\n\ta = b\n\tb = list --all\n', 'a'))).toEqual([
      'list',
      '--all',
    ]);
  });

  it('detects an alias loop rather than hanging', async () => {
    await expect(resolve('[alias]\n\ta = b\n\tb = a\n', 'a')).rejects.toThrow(/alias loop/);
  });

  it('detects an alias that points at itself', async () => {
    await expect(resolve('[alias]\n\ta = a\n', 'a')).rejects.toThrow(/alias loop/);
  });

  it('rejects an empty alias', async () => {
    await expect(resolve('[alias]\n\ta =\n', 'a')).rejects.toThrow(/is empty/);
  });

  it('rejects an alias whose value is only quotes', async () => {
    await expect(resolve('[alias]\n\ta = ""\n', 'a')).rejects.toThrow(/is empty/);
  });

  it('leaves an unknown command for commander to complain about', async () => {
    expect(tail(await resolve('[alias]\n\tll = list\n', 'nope'))).toEqual(['nope']);
  });

  it('does nothing when no command was given', async () => {
    expect(tail(await resolve('[alias]\n\tll = list\n'))).toEqual([]);
    expect(tail(await resolve('[alias]\n\tll = list\n', '--help'))).toEqual(['--help']);
  });

  it('matches alias names case-insensitively, as git config does', async () => {
    expect(tail(await resolve('[alias]\n\tll = list\n', 'LL'))).toEqual(['list']);
  });

  it('recognises a shell alias and keeps the extra arguments', async () => {
    const resolution = await resolve('[alias]\n\tsay = !echo hi\n', 'say', 'there', '--loud');

    expect(resolution.kind).toBe('shell');
    if (resolution.kind !== 'shell') return;
    expect(resolution.alias.script).toBe('echo hi');
    expect(resolution.alias.args).toEqual(['there', '--loud']);
  });

  it('stops at `--` rather than treating what follows as a command', async () => {
    expect(tail(await resolve('[alias]\n\tll = list\n', '--', 'll'))).toEqual(['--', 'll']);
  });
});

describe('commandNames', () => {
  it('includes every command and help', () => {
    const names = commandNames(program);

    expect(names.has('update')).toBe(true);
    expect(names.has('clone-all')).toBe(true);
    expect(names.has('help')).toBe(true);
    expect(names.has('definitely-not-a-command')).toBe(false);
  });

  it('leaves the retired short forms free for user aliases', () => {
    const names = commandNames(program);

    for (const retired of ['up', 'ls', 'get', 'down', 'act', 'actions', 'd']) {
      expect(names.has(retired)).toBe(false);
    }
  });
});

describe('runShellAlias', () => {
  it('returns the script exit code', async () => {
    expect(await runShellAlias({ name: 'boom', script: 'exit 7', args: [] })).toBe(7);
  });

  it('returns zero when the script succeeds', async () => {
    expect(await runShellAlias({ name: 'ok', script: 'true', args: [] })).toBe(0);
  });

  it('passes arguments through so the `f() { …; }; f` idiom works', async () => {
    const code = await runShellAlias({
      name: 'check',
      script: 'f() { [ "$1" = one ] && [ "$2" = two ]; }; f',
      args: ['one', 'two'],
    });

    expect(code).toBe(0);
  });

  it('exposes the working directory as GITX_PREFIX', async () => {
    const code = await runShellAlias({
      name: 'where',
      script: `[ "$GITX_PREFIX" = "${process.cwd()}" ]`,
      args: [],
    });

    expect(code).toBe(0);
  });

  it('rejects an empty script', async () => {
    await expect(runShellAlias({ name: 'blank', script: '   ', args: [] })).rejects.toThrow(
      /is empty/,
    );
  });
});
