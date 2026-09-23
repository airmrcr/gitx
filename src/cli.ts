import { createRequire } from 'node:module';
import { Command, InvalidArgumentError } from 'commander';
import { commandNames, resolveAlias, runShellAlias } from './alias.ts';
import { authCommand } from './commands/auth.ts';
import { cloneAllCommand, cloneCommand } from './commands/clone.ts';
import { completionCommand } from './commands/completion.ts';
import { configCommand } from './commands/config.ts';
import { listCommand } from './commands/list.ts';
import { openCommand } from './commands/open.ts';
import {
  addConcurrencyOption,
  addRemoteOptions,
  nearestOption,
  parseConcurrency,
} from './commands/options.ts';
import { pwdCommand } from './commands/pwd.ts';
import { defaultCommand, pullCommand, tidyCommand } from './commands/repo-commands.ts';
import { runsCommand } from './commands/runs.ts';
import { updateCommand } from './commands/update.ts';
import { defaultConfigPath } from './config/store.ts';
import { Context, type GlobalOptions } from './context.ts';
import { AbortError, ExitCode, isGitxError } from './util/errors.ts';
import { type ColorMode, setColorMode, theme } from './util/theme.ts';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const COLOR_MODES: ReadonlySet<ColorMode> = new Set(['auto', 'always', 'never']);

const isCommanderExit = (error: unknown): error is { code: string; exitCode?: number } =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { code: unknown }).code === 'string' &&
  (error as { code: string }).code.startsWith('commander.');

const parseColor = (value: string): ColorMode => {
  if (!COLOR_MODES.has(value as ColorMode)) {
    throw new InvalidArgumentError('expected auto, always or never');
  }
  return value as ColorMode;
};

/**
 * Builds the `gitx` CLI program, wiring up global options, commands and shared context.
 *
 * The returned program resolves a lazily-created, shared {@link Context} for all commands, so
 * configuration and provider clients are only created once per invocation.
 *
 * @param [signal] An abort signal propagated to the shared context and commands.
 * @returns The configured commander {@link Command} instance, ready to be parsed or inspected.
 */
export const createProgram = (signal?: AbortSignal): Command => {
  const program = new Command('gitx')
    .description('Wrangle many git repositories at once, in parallel.')
    .option('-b, --base-dir <path>', 'directory that repositories live beneath')
    .option('--color <mode>', 'auto, always or never', parseColor)
    .option(
      '-j, --concurrency <count>',
      'maximum repositories processed in parallel (`auto`, `unlimited` or a number)',
      parseConcurrency,
    )
    .option('--config <path>', 'path to the configuration file', defaultConfigPath())
    .option('-H, --host <host>', 'provider host, for self-hosted instances')
    .option('--no-input', 'never prompt; fail instead when configuration is missing')
    .option('-o, --owner <owner>', 'organisation, group or user that owns the repositories')
    .option('-P, --provider <name>', 'github or gitlab')
    .version(version, '-v, --version')
    .showHelpAfterError();

  // The command whose action is running, so an option written next to the command can take
  // precedence over the same option written before it.
  let active: Command | undefined;

  const globals = (): GlobalOptions => {
    const opts = program.opts();
    const scoped = <T>(key: string): T | undefined =>
      nearestOption<T>(active ?? program, key) ?? (opts[key] as T | undefined);

    return {
      config: opts['config'] as string | undefined,
      baseDir: opts['baseDir'] as string | undefined,
      owner: scoped<string>('owner'),
      provider: scoped<string>('provider'),
      host: scoped<string>('host'),
      concurrency: opts['concurrency'] as string | undefined,
      color: opts['color'] as ColorMode | undefined,
      // Commander maps `--no-input` onto `input: false`.
      noInput: opts['input'] === false,
      signal,
    };
  };

  let context: Context | undefined;
  const getContext = async (): Promise<Context> => {
    context ??= await Context.create(globals());
    return context;
  };

  program.hook('preAction', (_thisCommand, actionCommand) => {
    active = actionCommand;
    const mode = globals().color;
    if (mode) setColorMode(mode);
  });

  // `auth` works on a host rather than an owner's repositories.
  program.addCommand(addRemoteOptions(authCommand(getContext), { owner: false }));
  program.addCommand(addRemoteOptions(addConcurrencyOption(cloneCommand(getContext))));
  program.addCommand(addRemoteOptions(addConcurrencyOption(cloneAllCommand(getContext))));
  program.addCommand(completionCommand(() => program));
  program.addCommand(
    configCommand({
      configPath: () => globals().config ?? defaultConfigPath(),
      // Aliases can never shadow a real command, so warn rather than let someone set one that will
      // silently never run.
      reservedNames: () => commandNames(program),
    }),
  );
  program.addCommand(defaultCommand());
  program.addCommand(addRemoteOptions(listCommand(getContext)));
  program.addCommand(openCommand(getContext));
  program.addCommand(pullCommand(getContext));
  program.addCommand(pwdCommand(getContext));
  program.addCommand(addRemoteOptions(addConcurrencyOption(runsCommand(getContext))));
  program.addCommand(tidyCommand());
  program.addCommand(addRemoteOptions(addConcurrencyOption(updateCommand(getContext))));

  program.addHelpText(
    'after',
    `
Examples:
  $ gitx clone-all --install        clone every repository and install dependencies
  $ gitx update --install --tidy    fast-forward everything, then prune dead branches
  $ gitx update -j 4 api-*          update matching repositories, four at a time
  $ gitx list --all                 show what is cloned and what is still missing
  $ gitx runs                       show CI runs still in flight
  $ gitx auth status                check you are signed in to your provider
  $ gitx open my-repo               open it in your editor
  $ cd "$(gitx pwd my-repo)"        jump straight to it
  $ gitx config set core.baseDir ~/dev
`,
  );

  return program;
};

/**
 * Entry point function for the application.
 *
 * This function initializes a program, resolves command aliases, and executes the appropriate
 * functionality based on the provided arguments. The behavior includes parsing command-line
 * arguments, handling errors, and safely managing program exits.
 *
 * @param [argv=process.argv] An array of command-line arguments to process.
 * @param [signal] An abort signal to handle cancellation of the program.
 * @returns An appropriate exit code.
 */
export const main = async (
  argv: readonly string[] = process.argv,
  signal?: AbortSignal,
): Promise<number> => {
  const program = createProgram(signal);

  try {
    const resolved = await resolveAlias(argv, program);
    if (resolved.kind === 'shell') return await runShellAlias(resolved.alias);

    await program.parseAsync(resolved.argv);
    return process.exitCode === undefined ? ExitCode.Ok : Number(process.exitCode);
  } catch (error) {
    // Commander throws for `--help`/`--version` and for usage errors; it has already printed
    // everything the user needs to see.
    if (isCommanderExit(error)) return error.exitCode ?? ExitCode.Ok;
    return reportError(error);
  }
};

/**
 * Formats and writes an error to the given stream, then returns the exit code it implies.
 *
 * {@link AbortError AbortErrors} and recognised {@link GitxError GitxErrors} are rendered with
 * their own message, optional detail and hint; anything else falls back to the error's stack (or
 * stringified value) and a generic usage exit code.
 *
 * @param error The error to report, typically caught from {@link main}.
 * @param [stream=process.stderr] The stream to write the formatted message to.
 * @returns The exit code associated with the error.
 */
export const reportError = (
  error: unknown,
  stream: NodeJS.WriteStream = process.stderr,
): number => {
  if (error instanceof AbortError) {
    stream.write(`${theme.warn(error.message)}\n`);
    return error.code;
  }

  if (isGitxError(error)) {
    stream.write(`${theme.failure('gitx:')} ${error.message}\n`);
    if (error.detail) {
      for (const line of error.detail.split('\n')) {
        stream.write(`  ${theme.muted(line)}\n`);
      }
    }
    if (error.hint) stream.write(`${theme.muted(error.hint)}\n`);
    return error.code;
  }

  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  stream.write(`${theme.failure('gitx:')} ${message}\n`);
  return ExitCode.Usage;
};
