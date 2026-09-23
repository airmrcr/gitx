import { Command } from 'commander';
import type { Context } from '../context.ts';
import { cloneRepo } from '../git/clone.ts';
import { isGitWorkTree, type Workspace } from '../git/repo.ts';
import { installDependencies } from '../ops/install.ts';
import type { Provider, Visibility } from '../provider/types.ts';
import { printSummary, sweep } from '../runner/sweep.ts';
import { outcome, type Task, type TaskContext, type TaskOutcome } from '../runner/task.ts';
import { ExitCode } from '../util/errors.ts';
import { matchesAny } from '../util/match.ts';
import { withSpinner } from '../util/spinner.ts';
import { parseLimit } from './options.ts';

interface CloneData {
  cloned: boolean;
  installed: boolean;
}

interface CloneOneOptions {
  clean: boolean;
  context: Context;
  install: boolean;
  name: string;
  // The owner this repository actually belongs to, which may differ from `workspace.owner`.
  owner: string;
  task: TaskContext;
  url: string;
  workspace: Workspace;
}

const cloneOne = async (options: CloneOneOptions): Promise<TaskOutcome> => {
  const { context, name, owner, task, workspace } = options;
  const dir = workspace.dirFor(name, owner);
  const data: CloneData = { cloned: false, installed: false };

  if (await isGitWorkTree(dir)) {
    return outcome.skipped('already cloned', data);
  }

  task.setStatus('cloning');
  task.echo('git', ['clone', '--recurse-submodules', options.url, dir]);

  const result = await cloneRepo(options.url, dir, {
    onLine: (line) => task.log(line),
    signal: task.signal,
  });

  if (!result.ok) {
    return outcome.failure(`clone failed (exit ${result.exitCode})`, undefined, data);
  }

  data.cloned = true;

  if (options.install && !matchesAny(name, context.skipList('install'))) {
    const installed = await installDependencies({
      dir,
      config: context.config,
      task,
      clean: options.clean,
    });

    if (installed.state === 'failed') {
      return outcome.failure(installed.reason ?? 'install failed', undefined, data);
    }
    data.installed = installed.state === 'installed';
  }

  return outcome.success('cloned', data);
};

// Builds a clone URL for a repository we have not listed.
//
// `gitx clone acme/widgets` names a repository directly, so there is no API response to take a URL
// from and one has to be constructed. Listings always use the provider's own URLs instead, which
// handle self-hosted ports and nested subgroups that this cannot.
const cloneUrlFor = (provider: Provider, path: string, protocol: 'ssh' | 'https'): string =>
  protocol === 'ssh' ? `git@${provider.host}:${path}.git` : `https://${provider.host}/${path}.git`;

/**
 * Options for `gitx clone-all`.
 */
export interface CloneAllOptions extends CloneOptions {
  /** Include archived repositories. */
  archived?: boolean;
  /** Maximum number of repositories to list. */
  limit?: string;
  /** Visibility filter: `all`, `public`, `private` or `internal`. */
  visibility?: string;
}

/**
 * Options shared by `gitx clone` and `gitx clone-all`.
 */
export interface CloneOptions {
  /** Install dependencies cleanly (implies `install`). */
  clean?: boolean;
  /** Install dependencies after cloning. */
  install?: boolean;
}

/**
 * Builds the `clone-all` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `clone-all` {@link Command}.
 */
export const cloneAllCommand = (getContext: () => Promise<Context>): Command =>
  new Command('clone-all')
    .description('Clone every repository belonging to the configured owner')
    .argument('[filters...]', 'optional name globs to limit what is cloned')
    .option('--archived', 'include archived repositories')
    .option('-c, --clean', 'install dependencies cleanly (implies --install)')
    .option('-i, --install', 'install dependencies after cloning')
    .option('-l, --limit <count>', 'maximum number of repositories to list', parseLimit)
    .option('--visibility <visibility>', 'all, public, private or internal')
    .action(async (filters: string[], options: CloneAllOptions) => {
      process.exitCode = await runCloneAll(await getContext(), filters, options);
    });

/**
 * Builds the `clone` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `clone` {@link Command}.
 */
export const cloneCommand = (getContext: () => Promise<Context>): Command =>
  new Command('clone')
    .description('Clone one or more repositories into your workspace')
    .argument('<repos...>', 'repository names, or owner/name to override the configured owner')
    .option('-c, --clean', 'install dependencies cleanly (implies --install)')
    .option('-i, --install', 'install dependencies after cloning')
    .action(async (repos: string[], options: CloneOptions) => {
      process.exitCode = await runClone(await getContext(), repos, options);
    });

/**
 * Runs `gitx clone`, cloning the named repositories into the workspace.
 *
 * @param context Resolved {@link Context}.
 * @param repoNames Repository names, or `owner/name` to override the configured owner.
 * @param options The options to be used.
 * @returns The process exit code.
 */
export const runClone = async (
  context: Context,
  repoNames: readonly string[],
  options: CloneOptions,
): Promise<number> => {
  const workspace = await context.workspace();
  const provider = await context.provider();
  const protocol = await context.protocol();
  const owner = workspace.owner;
  const install =
    options.install === true ||
    options.clean === true ||
    context.config.getBoolean('clone.install');

  const tasks: Task[] = repoNames.map((requested) => {
    // Accept `owner/name` (or, for a nested GitLab subgroup, `group/subgroup/name`) so you can grab
    // a repository from outside your default org. Only the last segment is the repository name;
    // everything before it is the owner/path.
    const lastSlash = requested.lastIndexOf('/');
    const [maybeOwner, name] =
      lastSlash === -1
        ? [owner, requested]
        : [requested.slice(0, lastSlash), requested.slice(lastSlash + 1)];

    return {
      id: name,
      title: name,
      run: (task) =>
        cloneOne({
          task,
          context,
          workspace,
          owner: maybeOwner,
          name,
          url: cloneUrlFor(provider, `${maybeOwner}/${name}`, protocol),
          install,
          clean: options.clean === true,
        }),
    };
  });

  const result = await sweep({
    context,
    tasks,
    emptyMessage: 'Nothing to clone.',
    signal: context.signal,
  });

  const cloned = result.records.filter((r) => (r.data as CloneData | undefined)?.cloned).length;
  const installed = result.records.filter(
    (r) => (r.data as CloneData | undefined)?.installed,
  ).length;

  printSummary({
    Cloned: cloned,
    Skipped: result.skipped.length,
    Failed: result.failed.length,
    Installed: installed,
  });

  return result.failed.length > 0 ? ExitCode.Clone : ExitCode.Ok;
};

/**
 * Runs `gitx clone-all`, cloning every repository belonging to the configured owner.
 *
 * @param context Resolved {@link Context}.
 * @param filters Optional name globs to limit what is cloned.
 * @param options The options to be used.
 * @returns The process exit code.
 */
export const runCloneAll = async (
  context: Context,
  filters: readonly string[],
  options: CloneAllOptions,
): Promise<number> => {
  const workspace = await context.workspace();
  const provider = await context.provider();
  const protocol = await context.protocol();
  const config = context.config;

  const repos = await withSpinner(
    `Asking ${provider.label} what ${workspace.owner} has…`,
    async () =>
      provider.listRepos({
        owner: workspace.owner,
        limit: options.limit ? Number(options.limit) : config.getNumber('remote.limit'),
        visibility: (options.visibility ?? config.get('remote.visibility') ?? 'all') as Visibility,
        includeArchived: options.archived ?? config.getBoolean('remote.includeArchived'),
      }),
  );

  const candidates = repos.filter((repo) => filters.length === 0 || matchesAny(repo.name, filters));

  const install =
    options.install === true || options.clean === true || config.getBoolean('clone.install');

  const tasks: Task[] = candidates.map((repo) => ({
    id: repo.name,
    title: repo.name,
    run: (task) =>
      cloneOne({
        task,
        context,
        workspace,
        owner: workspace.owner,
        name: repo.name,
        url: repo.cloneUrl[protocol],
        install,
        clean: options.clean === true,
      }),
  }));

  const result = await sweep({
    context,
    tasks,
    emptyMessage: `No repositories found for ${workspace.owner}.`,
    signal: context.signal,
  });

  const cloned = result.records.filter((r) => (r.data as CloneData | undefined)?.cloned).length;
  const installed = result.records.filter(
    (r) => (r.data as CloneData | undefined)?.installed,
  ).length;

  printSummary({
    Cloned: cloned,
    Skipped: result.skipped.length,
    Failed: result.failed.length,
    Installed: installed,
  });

  return result.failed.length > 0 ? ExitCode.Clone : ExitCode.Ok;
};
