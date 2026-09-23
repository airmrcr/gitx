import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path, { delimiter } from 'node:path';
import { ExitCode, GitxError } from './errors.ts';

const executableCache = new Map<string, string | undefined>();

const createLineSplitter = (onLine: (line: string) => void) => {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        onLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
    },
  };
};

const resolveExecutable = (command: string, env: NodeJS.ProcessEnv): string | undefined => {
  const isWindows = process.platform === 'win32';
  // Tried first so a candidate that already ends in its own extension (e.g. a
  // full path to `Code.exe`) resolves without another suffix being appended.
  const extensions = isWindows
    ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];

  const candidates =
    command.includes(path.sep) || command.includes('/')
      ? [path.resolve(command)]
      : (env['PATH'] ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, command));

  for (const candidate of candidates) {
    for (const extension of extensions) {
      const full = candidate + extension;
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // Not executable or does not exist; keep looking.
      }
    }
  }

  return undefined;
};

/**
 * Options for {@link exec}.
 */
export interface ExecOptions {
  /**
   * Working directory for the child process.
   *
   * @default process.cwd()
   */
  cwd?: string | undefined;
  /**
   * Environment variables for the child process.
   *
   * @default process.env
   */
  env?: NodeJS.ProcessEnv | undefined;
  /** Written to the child's stdin, which is then closed. */
  input?: string | undefined;
  /** Invoked for every complete line emitted by the child. */
  onLine?: ((line: string, stream: OutputStream) => void) | undefined;
  /** Aborted to kill the child process before it exits naturally. */
  signal?: AbortSignal | undefined;
}

/**
 * Options for {@link execOrThrow}.
 */
export interface ExecOrThrowOptions extends ExecOptions {
  /**
   * The exit code to use if the command fails.
   *
   * @default ExitCode.Usage
   */
  code?: ExitCode | undefined;
}

/**
 * The outcome of running a command via {@link exec}.
 */
export interface ExecResult {
  /** The arguments passed to the command. */
  args: readonly string[];
  /** The command that was run. */
  command: string;
  /** The working directory the command was run in. */
  cwd: string;
  /** The process's exit code, or a synthesised value if it was signalled. */
  exitCode: number;
  /** Whether the process exited with code `0`. */
  ok: boolean;
  /** stdout and stderr interleaved in emission order. */
  output: string;
  /** The signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  /** Everything written to stderr. */
  stderr: string;
  /** Everything written to stdout. */
  stdout: string;
}

/**
 * Which stream a line of output was emitted on.
 */
export type OutputStream = 'stdout' | 'stderr';

/**
 * Clears the memoized executable lookups.
 *
 * This is intended for internal use only.
 *
 * @internal
 */
export const clearExecutableCache = (): void => {
  executableCache.clear();
};

/**
 * Spawns a command and resolves with its captured output. Never rejects on a non-zero exit code --
 * inspect {@link ExecResult.ok} or use {@link execOrThrow}.
 *
 * @param command The command to run.
 * @param [args] The command-line arguments to be passed.
 * @param [options] The options to be used.
 * @returns The captured result, rejecting only if the child process itself errors (e.g. spawn
 * failure).
 */
export const exec = (
  command: string,
  args: readonly string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> => {
  const cwd = options.cwd ?? process.cwd();

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });

    let stdout = '';
    let stderr = '';
    let output = '';

    const stdoutLines = createLineSplitter((line) => options.onLine?.(line, 'stdout'));
    const stderrLines = createLineSplitter((line) => options.onLine?.(line, 'stderr'));

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      output += chunk;
      if (options.onLine) stdoutLines.push(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      output += chunk;
      if (options.onLine) stderrLines.push(chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new GitxError(`command not found: ${command}`, {
            code: ExitCode.MissingCommand,
            cause: error,
            hint: `Install \`${command}\` and make sure it is on your PATH.`,
          }),
        );
        return;
      }
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      if (options.onLine) {
        stdoutLines.flush();
        stderrLines.flush();
      }
      const resolvedExitCode = exitCode ?? (signal ? 128 : 1);
      resolve({
        command,
        args,
        cwd,
        exitCode: resolvedExitCode,
        signal,
        stdout,
        stderr,
        output,
        ok: resolvedExitCode === 0,
      });
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
};

/**
 * Like {@link exec} but throws a {@link GitxError} when the command fails.
 *
 * @param command The command to run.
 * @param [args] The command-line arguments to be passed.
 * @param [options] The options to be used.
 * @returns The captured result, once the command has exited successfully.
 * @throws GitxError If the command fails.
 */
export const execOrThrow = async (
  command: string,
  args: readonly string[] = [],
  options: ExecOrThrowOptions = {},
): Promise<ExecResult> => {
  const result = await exec(command, args, options);
  if (!result.ok) {
    throw new GitxError(`\`${command} ${args.join(' ')}\` exited with ${result.exitCode}`, {
      code: options.code ?? ExitCode.Usage,
      detail: (result.stderr.trim() || result.stdout.trim()) ?? undefined,
    });
  }
  return result;
};

/**
 * Resolves an executable by scanning PATH directly, rather than shelling out to `which`/`where`.
 * Results are memoized for the lifetime of the process.
 *
 * @param command The command to resolve, either a bare name or a path.
 * @param [env=process.env] The environment to read `PATH`/`PATHEXT` from.
 * @returns The resolved, executable path, or `undefined` if none was found.
 */
export const findExecutable = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const cached = executableCache.get(command);
  if (cached !== undefined || executableCache.has(command)) return cached;

  const resolved = resolveExecutable(command, env);
  executableCache.set(command, resolved);
  return resolved;
};

/**
 * Checks whether an executable can be found on `PATH`.
 *
 * @param command The command to check, either a bare name or a path.
 * @param [env=process.env] The environment to read `PATH`/`PATHEXT` from.
 * @returns `true` if the command resolves to an executable; otherwise `false`.
 */
export const hasExecutable = (command: string, env?: NodeJS.ProcessEnv): boolean =>
  findExecutable(command, env) !== undefined;

/**
 * Throws if any of the given commands are missing, listing all of them at once.
 *
 * @param commands The commands that must be present on `PATH`.
 * @param context A short label identifying why the commands are required, used in the error message.
 * @throws GitxError If any of the commands are missing.
 */
export const requireExecutables = (commands: readonly string[], context: string): void => {
  const missing = commands.filter((command) => !hasExecutable(command));
  if (missing.length === 0) return;

  const label = missing.length === 1 ? 'command' : 'commands';
  throw new GitxError(`${context}: missing required ${label}: ${missing.join(', ')}`, {
    code: ExitCode.MissingCommand,
    hint: `Install the missing ${label} and ensure they are on your PATH.`,
  });
};
