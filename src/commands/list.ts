import { Command, Option } from 'commander';
import type { Context } from '../context.ts';
import { filterRepos } from '../git/repo.ts';
import type { Visibility } from '../provider/types.ts';
import { ExitCode } from '../util/errors.ts';
import { withSpinner } from '../util/spinner.ts';
import { symbols, theme } from '../util/theme.ts';
import { parseLimit } from './options.ts';

const emptyMessage = (options: ListOptions): string => {
  if (options.missing === true) return 'Everything is already cloned.';
  if (options.all === true) return 'No repositories found.';
  return 'No repositories cloned yet. Try `gitx clone-all`.';
};

const marker = (state: ListState): string =>
  state === 'cloned' ? theme.success(symbols.success) : theme.muted(symbols.pending);

const plural = (count: number): string => (count === 1 ? 'repository' : 'repositories');

const writeSummary = (
  listing: readonly ListEntry[],
  options: ListOptions,
  stderr: NodeJS.WriteStream,
): void => {
  if (listing.length === 0) {
    stderr.write(`${theme.muted(emptyMessage(options))}\n`);
    return;
  }

  const cloned = listing.filter((entry) => entry.state === 'cloned').length;
  const missing = listing.length - cloned;

  const parts = [`${theme.count(String(listing.length))} ${plural(listing.length)}`];
  // Only worth breaking down when the listing actually holds both states.
  if (cloned > 0 && missing > 0) {
    parts.push(`${theme.count(String(cloned))} cloned`, `${theme.count(String(missing))} missing`);
  }

  // Separated from the listing above it, so the eye can tell output from commentary at a glance.
  stderr.write(`\n${parts.join(theme.muted(' | '))}\n`);
};

/**
 * A single repository entry produced by `gitx list`.
 */
export interface ListEntry {
  /** Repository name. */
  name: string;
  /** Whether this repository is cloned locally. */
  state: ListState;
}

/**
 * Options for `gitx list`.
 */
export interface ListOptions {
  /** Also list repositories that are not cloned yet. */
  all?: boolean;
  /** Include archived repositories. */
  archived?: boolean;
  /** Maximum number of repositories to list. */
  limit?: string;
  /** List only repositories that are not cloned yet. */
  missing?: boolean;
  /** Print bare names and nothing else, for scripts. */
  porcelain?: boolean;
  /** Visibility filter: `all`, `public`, `private` or `internal`. */
  visibility?: string;
}

/**
 * Whether a listed repository is cloned into the workspace.
 */
export type ListState = 'cloned' | 'missing';

/**
 * Builds the `list` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `list` {@link Command}.
 */
export const listCommand = (getContext: () => Promise<Context>): Command =>
  new Command('list')
    .description('List the repositories in your workspace')
    .argument('[filters...]', 'optional name globs to limit the listing')
    .addOption(new Option('-a, --all', 'also list repositories that are not cloned yet'))
    .option('--archived', 'include archived repositories')
    .option('-l, --limit <count>', 'maximum number of repositories to list', parseLimit)
    .addOption(
      new Option('-m, --missing', 'list only repositories that are not cloned yet').conflicts(
        'all',
      ),
    )
    .option('-p, --porcelain', 'print bare names and nothing else, for scripts')
    .option('--visibility <visibility>', 'all, public, private or internal')
    .addHelpText(
      'after',
      `
Only locally cloned repositories are listed by default, which needs no network
access. \`--all\` and \`--missing\` ask your provider what else exists, so they
need credentials for it.

Every line is prefixed with \`${symbols.success}\` when the repository is cloned and
\`${symbols.pending}\` when it is not.

\`--porcelain\` is the mode for scripts: bare names, no markers, no spinner and
no summary. Warnings about filters that matched nothing are still reported, and
missing configuration fails rather than prompting.

  $ gitx list --porcelain | xargs -n1 echo
  $ gitx list --missing --porcelain | xargs gitx clone
`,
    )
    .action(async (filters: string[], options: ListOptions) => {
      process.exitCode = await runList(await getContext(), filters, options);
    });

/**
 * Runs `gitx list`, listing cloned (and optionally remote) repositories.
 *
 * @param context Resolved {@link Context}.
 * @param filters Optional name globs to limit the listing.
 * @param options The options to be used.
 * @param [stdout=process.stdout] Stream to write repository names to.
 * @param [stderr=process.stderr] Stream to write warnings and the summary to.
 * @returns The process exit code.
 */
export const runList = async (
  context: Context,
  filters: readonly string[],
  options: ListOptions,
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<number> => {
  const needsRemote = options.all === true || options.missing === true;

  // `--porcelain` is for scripts, so it drops everything that is decoration: the markers, the
  // spinner and the summary. Real diagnostics still show.
  const bare = options.porcelain === true;
  // Nobody is watching a pipeline, so fail with a usable error rather than blocking forever on a
  // question.
  if (bare) context.disablePrompts();

  // Resolved before the spinner starts: these may need to prompt, and a prompt and a spinner must
  // never share the terminal.
  const workspace = await context.workspace();
  const provider = needsRemote ? await context.provider() : undefined;

  const entries = await withSpinner(
    'Looking for cloned repositories…',
    async (spinner) => {
      const cloned = await workspace.discover();
      const found: ListEntry[] =
        options.missing === true
          ? []
          : cloned.map((repo) => ({ name: repo.name, state: 'cloned' }));

      if (!needsRemote) return found;

      if (!provider) return found;

      spinner.message(`Asking ${provider.label} what ${workspace.owner} has…`);
      const config = context.config;
      const remote = await provider.listRepos({
        owner: workspace.owner,
        limit: options.limit ? Number(options.limit) : config.getNumber('remote.limit'),
        visibility: (options.visibility ?? config.get('remote.visibility') ?? 'all') as Visibility,
        includeArchived: options.archived ?? config.getBoolean('remote.includeArchived'),
      });

      const local = new Set(cloned.map((repo) => repo.name));
      for (const repo of remote) {
        if (!local.has(repo.name)) found.push({ name: repo.name, state: 'missing' });
      }
      return found;
    },
    { stream: stderr, ...(bare ? { interactive: false } : {}) },
  );

  // Reuse the shared filter so globs behave exactly as they do everywhere else, then restore the
  // original state for each surviving name.
  const states = new Map(entries.map((entry) => [entry.name, entry.state]));
  const { selected, unmatched } = filterRepos(
    entries.map((entry) => ({ name: entry.name, dir: workspace.dirFor(entry.name) })),
    { only: filters },
  );

  for (const name of unmatched) {
    stderr.write(`${theme.warn('!')} no repository matched '${name}'\n`);
  }

  const listing = selected
    .map((repo) => ({ name: repo.name, state: states.get(repo.name) ?? 'cloned' }) as ListEntry)
    .toSorted((a, b) => a.name.localeCompare(b.name));

  for (const entry of listing) {
    stdout.write(bare ? `${entry.name}\n` : `${marker(entry.state)} ${entry.name}\n`);
  }

  if (!bare) writeSummary(listing, options, stderr);

  return listing.length === 0 && filters.length > 0 && unmatched.length > 0
    ? ExitCode.NotFound
    : ExitCode.Ok;
};
