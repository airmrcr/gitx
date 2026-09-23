import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { Config, defaultConfigPath } from './config/store.ts';
import { ExitCode, GitxError } from './util/errors.ts';
import { splitWords } from './util/words.ts';

// A value beginning with this is handed to the shell rather than to gitx.
const SHELL_PREFIX = '!';

// Guards against `alias.a = b` / `alias.b = a`.
const MAX_DEPTH = 10;

// Honours `--config` before the configuration itself is read.
const configPath = (argv: readonly string[], program: Command): string => {
  const flags = valueFlags(program);

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--config') return argv[index + 1] ?? defaultConfigPath();
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && flags.has(arg)) index += 1;
      continue;
    }
    break;
  }

  return defaultConfigPath();
};

// Locates the subcommand in `argv`, skipping the executable, global flags and the values those flags consume.
const findCommandIndex = (argv: readonly string[], program: Command): number => {
  const valued = valueFlags(program);

  // argv[0] is the node binary and argv[1] the script.
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') return -1;

    if (arg.startsWith('-')) {
      // `--config=path` carries its own value; `--config path` eats the next.
      if (!arg.includes('=') && valued.has(arg)) index += 1;
      continue;
    }

    return index;
  }

  return -1;
};

const valueFlags = (program: Command): Set<string> => {
  const flags = new Set<string>();
  for (const option of program.options) {
    if (!option.required && !option.optional) continue;
    if (option.short) flags.add(option.short);
    if (option.long) flags.add(option.long);
  }
  return flags;
};

/**
 * The result of resolving an alias: either a new argv to re-run the program with, or a
 * {@link ShellAlias} to execute as a shell script.
 */
export type AliasResolution =
  | { kind: 'argv'; argv: readonly string[] }
  | { kind: 'shell'; alias: ShellAlias };

/**
 * A shell alias (prefixed with `!`) along with the arguments to run it with.
 */
export interface ShellAlias {
  /** The name of the alias. */
  name: string;
  /** The script body, with the leading `!` removed. */
  script: string;
  /** Arguments the user supplied after the alias name. */
  args: readonly string[];
}

/**
 * Every command name and alias the program already answers to.
 *
 * @param program The command program.
 * @returns A set of all known command names and aliases.
 */
export const commandNames = (program: Command): ReadonlySet<string> => {
  const names = new Set<string>(['help']);
  for (const command of program.commands) {
    names.add(command.name());
    for (const alias of command.aliases()) {
      names.add(alias);
    }
  }
  return names;
};

/**
 * Expands `alias.<name>` configuration into real arguments, the way git does.
 *
 * Built-in commands always win, so an alias can never make `gitx update` mean something else.
 * Anything the alias does not consume is appended, so `alias.up = update --install` still allows
 * `gitx up -j 4 'api-*'`.
 *
 * @param argv The arguments to resolve.
 * @param program The command program.
 * @param [load] The function to load a configuration file.
 * @returns Either a new argv or a shell script to run.
 */
export const resolveAlias = async (
  argv: readonly string[],
  program: Command,
  load: (path: string) => Promise<Config> = (path) => Config.load(path),
): Promise<AliasResolution> => {
  const args = [...argv];
  const index = findCommandIndex(args, program);
  if (index === -1) return { kind: 'argv', argv: args };

  const known = commandNames(program);
  if (known.has(args[index]!)) return { kind: 'argv', argv: args };

  const config = await load(configPath(args, program));

  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const name = args[index]!;
    if (known.has(name)) return { kind: 'argv', argv: args };

    const value = config.getRaw(`alias.${name.toLowerCase()}`);
    if (value === undefined) return { kind: 'argv', argv: args };

    if (seen.has(name.toLowerCase())) {
      throw new GitxError(`alias loop detected: ${name}`, {
        code: ExitCode.Config,
        hint: 'One of your aliases expands back to itself.',
      });
    }
    seen.add(name.toLowerCase());

    if (value.startsWith(SHELL_PREFIX)) {
      return {
        kind: 'shell',
        alias: { name, script: value.slice(SHELL_PREFIX.length), args: args.slice(index + 1) },
      };
    }

    const words = splitWords(value);
    // An empty first word would expand to a command with no name at all.
    if (words.length === 0 || words[0] === '') {
      throw new GitxError(`alias '${name}' is empty`, {
        code: ExitCode.Config,
        hint: `Set it with \`gitx config set alias.${name} <command>\`.`,
      });
    }

    args.splice(index, 1, ...words);
  }

  throw new GitxError('alias expanded too many times', {
    code: ExitCode.Config,
    hint: 'One of your aliases expands back to itself.',
  });
};

/**
 * Runs a `!`-prefixed alias through the shell.
 *
 * As git does, `"$@"` is appended so the `!f() { …; }; f` idiom receives the user's arguments, and
 * `$0` is the alias name so errors name it usefully.
 *
 * @param alias The shell alias to run.
 * @returns The exit code of the shell process.
 */
export const runShellAlias = async (alias: ShellAlias): Promise<number> => {
  const script = alias.script.trim();
  if (script.length === 0) {
    throw new GitxError(`alias '${alias.name}' is empty`, { code: ExitCode.Config });
  }

  // `/bin/sh` rather than $SHELL, so a fish or nushell user still gets the POSIX syntax that git
  // aliases are written in.
  return new Promise<number>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `${script} "$@"`, alias.name, ...alias.args], {
      stdio: 'inherit',
      env: { ...process.env, GITX_PREFIX: process.cwd() },
    });

    child.on('error', (error) => {
      reject(
        new GitxError(`unable to run alias '${alias.name}'`, {
          code: ExitCode.Config,
          cause: error,
        }),
      );
    });

    // A signalled child reports no exit code; mirror the shell's 128+n.
    child.on('close', (code, signal) => {
      resolve(signal ? 128 : (code ?? 0));
    });
  });
};
