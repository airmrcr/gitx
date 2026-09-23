import { Command } from 'commander';
import type { Context } from '../context.ts';
import { Git } from '../git/git.ts';
import { filterRepos, isDirty, type Repo } from '../git/repo.ts';
import { installDependencies } from '../ops/install.ts';
import { tidyRepo } from '../ops/tidy.ts';
import { printSummary, sweep } from '../runner/sweep.ts';
import { outcome, type Task, type TaskContext, type TaskOutcome } from '../runner/task.ts';
import { ExitCode } from '../util/errors.ts';
import { requireExecutables } from '../util/exec.ts';
import { matchesAny } from '../util/match.ts';
import { theme } from '../util/theme.ts';

interface UpdateData {
  dir: string;
  gone: boolean;
  installed: boolean;
}

interface UpdateRepoOptions {
  allowDirty: boolean;
  clean: boolean;
  context: Context;
  force: boolean;
  ignoreDirty: readonly string[];
  install: boolean;
  prune: boolean;
  repo: Repo;
  skipInstall: readonly string[];
  submodulesFlag: boolean | undefined;
  task: TaskContext;
  tidyFlag: boolean | undefined;
}

const updateRepo = async (options: UpdateRepoOptions): Promise<TaskOutcome> => {
  const { context, repo, task } = options;
  const git = new Git({ cwd: repo.dir });
  const data: UpdateData = { installed: false, gone: false, dir: repo.dir };

  const tidy = options.tidyFlag ?? context.config.getForRepoBoolean('update', repo.name, 'tidy');
  const submodules =
    options.submodulesFlag ?? context.config.getForRepoBoolean('update', repo.name, 'submodules');

  task.setStatus('fetching');
  task.echo('git', ['fetch', options.prune ? '--prune' : '']);

  const fetched = await git.fetch({ prune: options.prune });

  if (!fetched.ok) {
    // A deleted or renamed remote is reported, not treated as a hard failure, so one dead
    // repository cannot fail the whole sweep.
    if (Git.isRepositoryGone(fetched.output)) {
      data.gone = true;
      return outcome.skipped('not found on remote', data);
    }
    for (const line of fetched.output.split('\n')) {
      if (line.trim()) task.log(line);
    }
    return outcome.failure('fetch failed', undefined, data);
  }

  const [branch, defaultBranch, status] = await Promise.all([
    git.currentBranch(),
    git.defaultBranch(),
    git.status(),
  ]);

  if (branch === undefined) {
    return outcome.skipped('detached HEAD', data);
  }

  if (defaultBranch !== undefined && branch !== defaultBranch) {
    return outcome.skipped(`on ${theme.branch(branch)}`, data);
  }

  const dirty = isDirty(status, options.ignoreDirty);
  if (dirty && !options.allowDirty) {
    return outcome.skipped('dirty working tree', data);
  }

  if (submodules && (await git.hasSubmodules())) {
    task.setStatus('updating submodules');
    task.echo('git', ['submodule', 'update', '--init', '--recursive']);

    const submodule = await git.submoduleUpdate();
    if (!submodule.ok) {
      for (const line of submodule.output.split('\n')) {
        if (line.trim()) task.log(line);
      }
      return outcome.failure('submodule update failed', undefined, data);
    }
  }

  task.setStatus('pulling');
  task.echo('git', ['pull', '--ff-only']);

  const pulled = await git.pull(['--ff-only']);
  for (const line of pulled.output.split('\n')) {
    if (line.trim()) task.log(line);
  }

  if (!pulled.ok) {
    return outcome.failure('pull failed', undefined, data);
  }

  const upToDate = Git.isUpToDate(pulled.output);

  if (tidy) {
    // The fetch above already pruned, so there is nothing left to fetch here.
    const tidied = await tidyRepo(git, task, { fetch: false });
    if (tidied.deleted.length > 0) {
      task.log(`deleted ${tidied.deleted.length} stale branch(es)`);
    }
  }

  const shouldInstall =
    options.install && (!upToDate || options.force) && !matchesAny(repo.name, options.skipInstall);

  if (shouldInstall) {
    const installed = await installDependencies({
      dir: repo.dir,
      config: context.config,
      task,
      clean: options.clean,
    });

    if (installed.state === 'failed') {
      return outcome.failure(installed.reason ?? 'install failed', undefined, data);
    }
    data.installed = installed.state === 'installed';
  }

  return outcome.success(upToDate ? 'up to date' : 'updated', data);
};

/**
 * Options for `gitx update`.
 */
export interface UpdateOptions {
  /** Only update repositories sorted after this one. */
  after?: string;
  /** Install dependencies cleanly (implies `install`). */
  clean?: boolean;
  /** Update repositories even when the working tree is dirty. */
  dirty?: boolean;
  /** Install dependencies even when already up to date. */
  force?: boolean;
  /** Install dependencies after updating. */
  install?: boolean;
  /** Update submodules. */
  submodules?: boolean;
  /** Delete branches whose upstream has gone. */
  tidy?: boolean;
}

/**
 * Runs `gitx update`, fetching and fast-forwarding every cloned repository in parallel.
 *
 * @param context Resolved {@link Context}.
 * @param repoNames Repository names or globs to update (default: all).
 * @param options The options to be used.
 * @returns The process exit code.
 */
export const runUpdate = async (
  context: Context,
  repoNames: readonly string[],
  options: UpdateOptions,
): Promise<number> => {
  requireExecutables(['git'], 'gitx update');

  const workspace = await context.workspace();
  const discovered = await workspace.discover();

  const { selected, unmatched } = filterRepos(discovered, {
    only: repoNames,
    skip: context.skipList('update'),
    after: options.after,
  });

  for (const name of unmatched) {
    process.stderr.write(`${theme.warn('!')} no repository matched '${name}'\n`);
  }

  const config = context.config;
  const install =
    options.install === true || options.clean === true || config.getBoolean('update.install');
  const clean = options.clean ?? config.getBoolean('update.clean');
  const force = options.force ?? config.getBoolean('update.force');
  const prune = config.getBoolean('update.prune');
  const ignoreDirty = config.getList('update.ignoreDirty');

  const skipInstall = context.skipList('install');

  const tasks: Task[] = selected.map((repo) => ({
    id: repo.name,
    title: repo.name,
    run: (task) =>
      updateRepo({
        repo,
        task,
        context,
        install,
        clean,
        force,
        // Resolved per repository, not once up front: a repo can override
        // `update.tidy`/`update.submodules` for itself.
        tidyFlag: options.tidy,
        submodulesFlag: options.submodules,
        prune,
        ignoreDirty,
        skipInstall,
        allowDirty: options.dirty === true,
      }),
  }));

  const result = await sweep({
    context,
    tasks,
    emptyMessage:
      discovered.length === 0
        ? `No repositories found in ${workspace.root}`
        : 'No repositories matched the given filters.',
    signal: context.signal,
  });

  const installed = result.records.filter(
    (record) => (record.data as UpdateData | undefined)?.installed,
  ).length;
  const gone = result.records.filter((record) => (record.data as UpdateData | undefined)?.gone);

  printSummary({
    Updated: result.succeeded.length,
    Skipped: result.skipped.length,
    Failed: result.failed.length,
    Installed: installed,
  });

  if (gone.length > 0) {
    process.stdout.write(`\n${theme.warn('Missing from the remote:')}\n`);
    for (const record of gone) {
      process.stdout.write(`  ${(record.data as UpdateData).dir}\n`);
    }
    // A real pull failure elsewhere in the sweep is more important than reporting a repository
    // whose remote is merely gone.
    if (result.failed.length === 0) return ExitCode.NotFound;
  }

  return result.failed.length > 0 ? ExitCode.Pull : ExitCode.Ok;
};

/**
 * Builds the `update` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `update` {@link Command}.
 */
export const updateCommand = (getContext: () => Promise<Context>): Command =>
  new Command('update')
    .description('Fetch and fast-forward every cloned repository, in parallel')
    .argument('[repos...]', 'repository names or globs to update (default: all)')
    .option('-a, --after <repo>', 'only update repositories sorted after this one')
    .option('-c, --clean', 'install dependencies cleanly (implies --install)')
    .option('--dirty', 'update repositories even when the working tree is dirty')
    .option('-f, --force', 'install dependencies even when already up to date')
    .option('-i, --install', 'install dependencies after updating')
    .option('--no-submodules', 'do not update submodules')
    .option('--tidy', 'delete branches whose upstream has gone')
    .option('--no-tidy', 'keep branches whose upstream has gone')
    .action(async (repos: string[], options: UpdateOptions) => {
      process.exitCode = await runUpdate(await getContext(), repos, options);
    });
