import path from 'node:path';
import { Command } from 'commander';
import type { Context } from '../context.ts';
import { Git } from '../git/git.ts';
import { installDependencies } from '../ops/install.ts';
import { tidyRepo } from '../ops/tidy.ts';
import type { TaskContext } from '../runner/task.ts';
import { ExitCode, GitxError } from '../util/errors.ts';
import { requireExecutables } from '../util/exec.ts';
import { matchesAny } from '../util/match.ts';
import { formatCommand, theme } from '../util/theme.ts';

const currentRepo = async (): Promise<Git> => {
  requireExecutables(['git'], 'gitx');

  const git = new Git({ cwd: process.cwd(), color: true });
  if (!(await git.isRepository())) {
    throw new GitxError('not inside a git repository', {
      code: ExitCode.Usage,
      hint: 'Run this command from within a repository working tree.',
    });
  }
  return git;
};

// A `TaskContext` that writes straight to the terminal.
//
// The single-repository commands are not part of a parallel sweep, so their output should stream
// normally rather than being captured and truncated.
const directTask = (stream: NodeJS.WriteStream = process.stdout): TaskContext => ({
  log: (line) => stream.write(`${line}\n`),
  echo: (command, args = []) => stream.write(`${formatCommand(command, args)}\n`),
  setStatus: () => {
    // Nothing to update when writing directly
  },
  signal: new AbortController().signal,
});

// Installs the current repository's dependencies.
//
// Unlike `gitx update`, this runs whether or not the pull brought anything down: you asked for it
// by name, in one repository you are standing in, and silently doing nothing would be the more
// surprising answer. For the same reason there is no `--force` to go with `--clean`: there is
// nothing left for it to force.
const runInstall = async (git: Git, context: Context, clean: boolean): Promise<number> => {
  // Not `git.cwd`: you may be several directories inside the working tree.
  const dir = (await git.root()) ?? git.cwd;
  const name = path.basename(dir);

  if (matchesAny(name, context.skipList('install'))) {
    process.stdout.write(`${theme.muted(`Skipping install: ${name} is in skip.install`)}\n`);
    return ExitCode.Ok;
  }

  const task = directTask();
  const outcome = await installDependencies({ dir, config: context.config, task, clean });

  if (outcome.state === 'failed') {
    process.stderr.write(`${theme.failure(outcome.reason ?? 'install failed')}\n`);
    return ExitCode.Install;
  }

  if (outcome.state === 'skipped') {
    process.stdout.write(`${theme.muted(`Skipping install: ${outcome.reason}`)}\n`);
    return ExitCode.Ok;
  }

  process.stdout.write(`${theme.success(`Installed with ${outcome.manager}`)}\n`);
  return ExitCode.Ok;
};

/**
 * Options for `gitx pull`.
 */
export interface PullOptions {
  /** Force a frozen install regardless of `install.frozen`. */
  clean?: boolean;
  /**
   * Supplied only when `--install` or `--clean` was passed.
   *
   * `gitx pull` is otherwise a single-repository command that needs no configuration, and loading
   * it regardless would make a broken `~/.gitxconfig` break a plain pull.
   */
  getContext?: (() => Promise<Context>) | undefined;
  /** Run `gitx tidy` after a successful pull. */
  tidy?: boolean;
}

/**
 * Options for `gitx tidy`.
 */
export interface TidyOptions {
  /**
   * Fetch with pruning before looking for stale branches.
   *
   * @default true
   */
  fetch?: boolean;
}

/**
 * Builds the `default` command.
 *
 * @returns The configured `default` {@link Command}.
 */
export const defaultCommand = (): Command =>
  new Command('default').description("Switch to the remote's default branch").action(async () => {
    process.exitCode = await runDefault();
  });

/**
 * Builds the `pull` command.
 *
 * @param getContext Lazily resolves the current {@link Context}, used only when installing.
 * @returns The configured `pull` {@link Command}.
 */
export const pullCommand = (getContext: () => Promise<Context>): Command =>
  new Command('pull')
    .description('Pull the current branch, optionally tidying afterwards')
    // Unknown options and extra arguments are handed straight to `git pull`.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]', 'arguments passed through to `git pull`')
    .option('-c, --clean', 'install dependencies cleanly (implies --install)')
    .option('-i, --install', 'install dependencies after a successful pull')
    .option('-t, --tidy', 'run `gitx tidy` after a successful pull')
    .action(
      async (args: string[], options: { tidy?: boolean; install?: boolean; clean?: boolean }) => {
        const install = options.install === true || options.clean === true;
        process.exitCode = await runPull(args, {
          tidy: options.tidy === true,
          clean: options.clean === true,
          ...(install ? { getContext } : {}),
        });
      },
    );

/**
 * Runs `gitx default`, switching to the remote's default branch.
 *
 * @returns The process exit code.
 * @throws GitxError If the current directory is not inside a git repository, or the default
 * branch cannot be determined.
 */
export const runDefault = async (): Promise<number> => {
  const git = await currentRepo();
  const branch = await git.defaultBranch();

  if (branch === undefined) {
    throw new GitxError('unable to determine the default branch', {
      code: ExitCode.NotFound,
      hint: 'Run `git remote set-head origin --auto` and try again.',
    });
  }

  const current = await git.currentBranch();
  if (current === branch) {
    process.stdout.write(`${theme.muted(`Already on ${theme.branch(branch)}`)}\n`);
    return ExitCode.Ok;
  }

  process.stdout.write(`${formatCommand('git', ['checkout', branch])}\n`);
  const result = await git.checkout(branch);
  process.stdout.write(result.output);

  return result.ok ? ExitCode.Ok : ExitCode.Usage;
};

/**
 * Runs `gitx tidy`, deleting local branches whose upstream has been deleted.
 *
 * @param [options] The options to be used.
 * @returns The process exit code.
 * @throws GitxError If the current directory is not inside a git repository.
 */
export const runTidy = async (options: TidyOptions = {}): Promise<number> => {
  const git = await currentRepo();
  const task = directTask();

  const result = await tidyRepo(git, task, { fetch: options.fetch !== false });

  if (result.deleted.length === 0) {
    process.stdout.write(`${theme.muted('Nothing to tidy.')}\n`);
  } else {
    process.stdout.write(
      `${theme.success(`Deleted ${result.deleted.length} branch(es):`)} ${result.deleted
        .map((branch) => theme.branch(branch))
        .join(', ')}\n`,
    );
  }

  if (result.failed.length > 0) {
    process.stderr.write(`${theme.failure(`Failed to delete: ${result.failed.join(', ')}`)}\n`);
    return ExitCode.Usage;
  }

  return ExitCode.Ok;
};

/**
 * Builds the `tidy` command.
 *
 * @returns The configured `tidy` {@link Command}.
 */
export const tidyCommand = (): Command =>
  new Command('tidy')
    .description('Delete local branches whose upstream has been deleted')
    .option('--no-fetch', 'skip the pruning fetch before looking for stale branches')
    .action(async (options: { fetch?: boolean }) => {
      process.exitCode = await runTidy({ fetch: options.fetch !== false });
    });

/**
 * Runs `gitx pull`, pulling the current branch and optionally tidying/installing afterwards.
 *
 * @param args Extra arguments passed through to `git pull`.
 * @param [options] The options to be used.
 * @returns The process exit code.
 * @throws GitxError If the current directory is not inside a git repository.
 */
export async function runPull(args: readonly string[], options: PullOptions = {}): Promise<number> {
  const git = await currentRepo();

  process.stdout.write(`${formatCommand('git', ['pull', ...args])}\n`);
  const result = await git.pull(args);
  process.stdout.write(result.output);

  if (!result.ok) return ExitCode.Pull;

  // `--tidy` is a convenience for the `git pt` alias: pull, then prune.
  if (options.tidy === true) {
    const code = await runTidy({ fetch: true });
    if (code !== ExitCode.Ok) return code;
  }

  if (options.getContext === undefined) return ExitCode.Ok;

  return runInstall(git, await options.getContext(), options.clean === true);
}
