import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode, GitxError } from '../../src/util/errors.ts';
import {
  clearExecutableCache,
  exec,
  execOrThrow,
  findExecutable,
  hasExecutable,
  requireExecutables,
} from '../../src/util/exec.ts';

const captureError = (fn: () => unknown): Error | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error as Error;
  }
};

beforeEach(() => {
  clearExecutableCache();
});

describe('exec', () => {
  it('captures stdout and reports success', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write("hello")']);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('captures stderr separately', async () => {
    const result = await exec('node', ['-e', 'process.stderr.write("bad")']);
    expect(result.stderr).toBe('bad');
    expect(result.stdout).toBe('');
  });

  it('does not throw on a non-zero exit code', async () => {
    const result = await exec('node', ['-e', 'process.exit(3)']);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('runs in the requested working directory', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: '/tmp',
    });
    // macOS reports /tmp as a symlink to /private/tmp.
    expect(result.stdout).toMatch(/tmp$/);
  });

  it('passes environment variables through', async () => {
    const result = await exec('node', ['-e', 'process.stdout.write(process.env.GITX_TEST ?? "")'], {
      env: { ...process.env, GITX_TEST: 'yes' },
    });
    expect(result.stdout).toBe('yes');
  });

  it('writes stdin when input is provided', async () => {
    const result = await exec('node', ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'piped',
    });
    expect(result.stdout).toBe('piped');
  });

  it('streams complete lines to onLine', async () => {
    const lines: Array<[string, string]> = [];
    await exec('node', ['-e', 'console.log("one");console.log("two");console.error("three")'], {
      onLine: (line, stream) => lines.push([stream, line]),
    });

    expect(lines).toEqual([
      ['stdout', 'one'],
      ['stdout', 'two'],
      ['stderr', 'three'],
    ]);
  });

  it('flushes a trailing line that has no newline', async () => {
    const lines: string[] = [];
    await exec('node', ['-e', 'process.stdout.write("no newline")'], {
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['no newline']);
  });

  it('strips carriage returns from streamed lines', async () => {
    const lines: string[] = [];
    await exec('node', ['-e', 'process.stdout.write("a\\r\\nb\\r\\n")'], {
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['a', 'b']);
  });

  it('raises a helpful error when the command does not exist', async () => {
    await expect(exec('gitx-definitely-not-a-real-command')).rejects.toMatchObject({
      code: ExitCode.MissingCommand,
    });
  });
});

describe('execOrThrow', () => {
  it('returns the result on success', async () => {
    expect((await execOrThrow('node', ['-e', 'process.stdout.write("x")'])).stdout).toBe('x');
  });

  it('throws on failure, including the captured stderr', async () => {
    await expect(
      execOrThrow('node', ['-e', 'process.stderr.write("nope");process.exit(1)']),
    ).rejects.toMatchObject({ detail: 'nope' });
  });
});

describe('findExecutable', () => {
  it('resolves a command on PATH', () => {
    expect(findExecutable('node')).toBeDefined();
  });

  it('returns undefined for a missing command', () => {
    expect(findExecutable('gitx-definitely-not-a-real-command')).toBeUndefined();
  });

  it('memoises lookups', () => {
    expect(findExecutable('node')).toBe(findExecutable('node'));
  });

  it('copes with an empty PATH', () => {
    expect(findExecutable('node', { PATH: '' })).toBeUndefined();
  });
});

describe('findExecutable on Windows', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    clearExecutableCache();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    clearExecutableCache();
  });

  it('resolves a full path that already ends in its own extension, without appending another', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gitx-exec-'));
    const exe = path.join(dir, 'Code.exe');
    await writeFile(exe, '', { mode: 0o755 });

    expect(findExecutable(exe)).toBe(exe);
  });
});

describe('hasExecutable', () => {
  it('reports presence', () => {
    expect(hasExecutable('node')).toBe(true);
    expect(hasExecutable('gitx-definitely-not-a-real-command')).toBe(false);
  });
});

describe('requireExecutables', () => {
  it('passes when everything is present', () => {
    expect(() => requireExecutables(['node'], 'test')).not.toThrow();
  });

  it('lists every missing command at once', () => {
    const thrown = captureError(() =>
      requireExecutables(['gitx-missing-one', 'gitx-missing-two'], 'gitx test'),
    );

    expect(thrown).toBeInstanceOf(GitxError);
    expect(thrown?.message).toContain('gitx-missing-one');
    expect(thrown?.message).toContain('gitx-missing-two');
    expect((thrown as GitxError).code).toBe(ExitCode.MissingCommand);
  });

  it('uses the singular for one missing command', () => {
    expect(() => requireExecutables(['gitx-missing-one'], 'gitx test')).toThrow(
      /missing required command:/,
    );
  });
});
