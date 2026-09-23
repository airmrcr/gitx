import { Command } from 'commander';
import type { Context } from '../context.ts';
import { Git } from '../git/git.ts';
import { parseRemoteUrl } from '../git/remote.ts';
import { filterRepos } from '../git/repo.ts';
import type { CiRun, Provider } from '../provider/types.ts';
import { relativeTime } from '../runner/renderer.ts';
import { printSummary, sweep } from '../runner/sweep.ts';
import { outcome, type Task } from '../runner/task.ts';
import { theme } from '../util/theme.ts';
import { parseLimit } from './options.ts';

interface RunsData {
  repo: string;
  runs: CiRun[];
}

interface Unresolved {
  reason: string;
}

const isInFlight = (run: CiRun): boolean => run.state !== 'finished';

const printRunTable = (
  entries: readonly RunsData[],
  provider: Provider,
  stdout: NodeJS.WriteStream,
): void => {
  if (entries.length === 0) return;

  stdout.write(`\n${theme.heading(`In-flight ${provider.runNoun}s`)}\n`);

  for (const entry of entries) {
    stdout.write(`\n${theme.repo(entry.repo)}\n`);

    for (const run of entry.runs) {
      const when = relativeTime(run.startedAt || run.createdAt);
      stdout.write(
        `  ${theme.warn(run.status.padEnd(12))} ${run.name}  ${theme.branch(run.ref)}  ${theme.muted(
          when,
        )}\n    ${theme.muted(theme.link(run.url))}\n`,
      );
    }
  }
};

// Maps a local clone to its project path on the forge.
//
// Read from `origin` rather than assumed from `<owner>/<directory>`: those disagree whenever a
// repository has been renamed, transferred, or lives in a nested GitLab subgroup. A repository
// pointing somewhere else entirely is reported as unresolved so the caller can skip it, with a
// reason, rather than ask the wrong server about it.
const projectPath = async (dir: string, provider: Provider): Promise<string | Unresolved> => {
  const git = new Git({ cwd: dir });
  const url = await git.capture(['remote', 'get-url', 'origin']);
  if (url === undefined) return { reason: 'no origin remote' };

  const remote = parseRemoteUrl(url);
  if (remote === undefined) return { reason: 'origin is not a recognisable URL' };

  if (remote.host !== provider.host.toLowerCase()) {
    return { reason: `hosted on ${remote.host}, not ${provider.host}` };
  }

  return remote.path;
};

/**
 * Options for `gitx runs`.
 */
export interface RunsOptions {
  /** Show runs from every user, not just your own. */
  all?: boolean;
  /** Maximum number of runs to inspect per repository. */
  limit?: string;
  /** Only show runs triggered by this user. */
  user?: string;
}

/**
 * Builds the `runs` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `runs` {@link Command}.
 */
export const runsCommand = (getContext: () => Promise<Context>): Command =>
  new Command('runs')
    .description('Report in-flight CI runs across your repositories')
    .argument('[repos...]', 'repository names or globs to check (default: all)')
    .option('--all', 'show runs from every user, not just your own')
    .option('-l, --limit <count>', 'maximum number of runs to inspect per repository', parseLimit)
    .option('-u, --user <login>', 'only show runs triggered by this user')
    .addHelpText(
      'after',
      `
"Run" is whatever your provider calls it: a workflow run on GitHub, a pipeline
on GitLab. Only runs that have not finished yet are reported.

Each repository is matched to its project by reading its \`origin\` remote, so
renamed and moved repositories are still found.

  $ gitx runs              # your own in-flight runs
  $ gitx runs --all        # everyone's
  $ gitx runs 'api-*'      # only matching repositories
`,
    )
    .action(async (repos: string[], options: RunsOptions) => {
      process.exitCode = await runRuns(await getContext(), repos, options);
    });

/**
 * Runs `gitx runs`, reporting in-flight CI runs across repositories.
 *
 * @param context Resolved {@link Context}.
 * @param repoNames Repository names or globs to check (default: all).
 * @param options The options to be used.
 * @param [stdout=process.stdout] Stream to write the run table and summary to.
 * @param [stderr=process.stderr] Stream to write warnings to.
 * @returns The process exit code.
 */
export const runRuns = async (
  context: Context,
  repoNames: readonly string[],
  options: RunsOptions,
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<number> => {
  const workspace = await context.workspace();
  const provider = await context.provider();
  const discovered = await workspace.discover();

  const { selected, unmatched } = filterRepos(discovered, { only: repoNames });

  for (const name of unmatched) {
    stderr.write(`${theme.warn('!')} no repository matched '${name}'\n`);
  }

  const limit = options.limit ? Number(options.limit) : context.config.getNumber('runs.limit');
  const user = options.all === true ? undefined : (options.user ?? (await context.remoteUser()));

  const tasks: Task[] = selected.map((repo) => ({
    id: repo.name,
    title: repo.name,
    run: async (task) => {
      task.setStatus('resolving remote');

      const project = await projectPath(repo.dir, provider);
      if (typeof project !== 'string') {
        return outcome.skipped(project.reason, { repo: repo.name, runs: [] });
      }

      task.setStatus(`querying ${provider.runNoun}s`);

      const runs = (await provider.listRuns(project, { limit, user, signal: task.signal })).filter(
        (run) => isInFlight(run),
      );

      const data: RunsData = { repo: repo.name, runs };

      return runs.length === 0
        ? outcome.success('nothing in flight', data)
        : outcome.success(`${runs.length} in flight`, data);
    },
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

  const active = result.records
    .map((record) => record.data as RunsData | undefined)
    .filter((data): data is RunsData => (data?.runs.length ?? 0) > 0);

  printRunTable(active, provider, stdout);

  printSummary({
    Repositories: result.records.length,
    'In flight': active.reduce((total, data) => total + data.runs.length, 0),
    Skipped: result.skipped.length,
    Failed: result.failed.length,
  });

  return result.failed.length > 0 ? 1 : 0;
};
