import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ExitCode, GitxError } from '../util/errors.ts';
import { matchesAny } from '../util/match.ts';

const pathMatchesIgnore = (filePath: string, ignore: string): boolean => {
  const normalised = ignore.replaceAll('\\', '/').replace(/\/+$/, '');
  const target = filePath.replaceAll('\\', '/').replace(/\/+$/, '');
  if (matchesAny(target, [normalised])) return true;
  // A directory entry ignores everything beneath it.
  return target.startsWith(`${normalised}/`);
};

const unquoteStatusPath = (value: string): string => {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value
    .slice(1, -1)
    .replaceAll(String.raw`\"`, '"')
    .replaceAll('\\\\', '\\');
};

/** Options for {@link filterRepos}. */
export interface FilterReposOptions {
  /**
   * Resume cursor: keep only repositories sorting strictly after this value.
   *
   * A partial name works, so `--after m` resumes from the second half.
   */
  after?: string | undefined;
  /** Explicit repository names/globs requested on the command line. */
  only?: readonly string[];
  /** Names/globs to always exclude. */
  skip?: readonly string[];
}

/** The outcome of {@link filterRepos}. */
export interface FilterReposResult {
  /** The repositories that survived filtering. */
  selected: Repo[];
  /** Requested names that matched nothing, so the caller can warn about typos. */
  unmatched: string[];
}

/**
 * How repositories are arranged beneath a workspace's base directory.
 */
export type Layout = 'nested' | 'flat';

/**
 * A discovered repository.
 */
export interface Repo {
  /** Absolute path to the working tree. */
  dir: string;
  /** Directory name, which is also the repository name. */
  name: string;
}

/**
 * Options for constructing a {@link Workspace}.
 */
export interface WorkspaceOptions {
  /** Directory that repositories live beneath. */
  baseDir: string;
  /** How repositories are arranged beneath `baseDir`. */
  layout: Layout;
  /** Organisation, group or user that owns the repositories. */
  owner: string;
}

/**
 * Describes where repositories live on disk and how to find them.
 *
 * Discovery is intentionally shallow: only the immediate children of the workspace root are
 * considered, which keeps scanning fast and avoids descending into vendored or nested checkouts.
 */
export class Workspace {
  /** Directory that repositories live beneath. */
  readonly baseDir: string;
  /** How repositories are arranged beneath `baseDir`. */
  readonly layout: Layout;
  /** Organisation, group or user that owns the repositories. */
  readonly owner: string;

  /**
   * Creates a new {@link Workspace} instance with the specified `options`.
   *
   * @param options The options to be used.
   */
  constructor(options: WorkspaceOptions) {
    this.baseDir = options.baseDir;
    this.layout = options.layout;
    this.owner = options.owner;
  }

  /** The directory that repositories are direct children of. */
  get root(): string {
    return this.layout === 'nested' ? path.join(this.baseDir, this.owner) : this.baseDir;
  }

  /**
   * Absolute path for a repository, whether or not it exists yet.
   *
   * `owner` defaults to the workspace's own, but a repository cloned from a different owner
   * (`gitx clone other-org/widgets`) must resolve under *that* owner in a nested layout, or it
   * collides on disk with -- and gets mistaken for -- a same-named repository belonging to the real
   * owner.
   *
   * @param repoName The repository's directory name.
   * @param [owner] The owner to resolve the directory under, defaulting to the workspace's own.
   * @returns The absolute directory for the repository.
   */
  dirFor(repoName: string, owner: string = this.owner): string {
    const root = this.layout === 'nested' ? path.join(this.baseDir, owner) : this.baseDir;
    return path.join(root, repoName);
  }

  /**
   * Shallowly finds every git working tree directly beneath the root.
   *
   * @returns The discovered repositories, sorted by name.
   * @throws GitxError If the root exists but could not be read.
   */
  async discover(): Promise<Repo[]> {
    let dirents;
    try {
      dirents = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new GitxError(`unable to read directory: ${this.root}`, {
        code: ExitCode.Filesystem,
        cause: error,
      });
    }

    const candidates = dirents
      .filter((dirent) => dirent.isDirectory() || dirent.isSymbolicLink())
      .filter((dirent) => !dirent.name.startsWith('.'))
      .map((dirent) => ({ name: dirent.name, dir: path.join(this.root, dirent.name) }));

    const checked = await Promise.all(
      candidates.map(async (repo) => ((await isGitWorkTree(repo.dir)) ? repo : undefined)),
    );

    return checked
      .filter((repo): repo is Repo => repo !== undefined)
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Creates the workspace root if it is missing.
   *
   * @returns The workspace root.
   * @throws GitxError If the directory could not be created.
   */
  async ensureRoot(): Promise<string> {
    try {
      await mkdir(this.root, { recursive: true });
      return this.root;
    } catch (error) {
      throw new GitxError(`unable to create directory: ${this.root}`, {
        code: ExitCode.Filesystem,
        cause: error,
      });
    }
  }

  /**
   * Resolves a repository's directory, throwing when it hasn't been cloned.
   *
   * @param repoName The repository's directory name.
   * @returns The absolute directory for the repository.
   * @throws GitxError If the repository has not been cloned.
   */
  async requireDir(repoName: string): Promise<string> {
    const dir = this.dirFor(repoName);
    if (!(await isGitWorkTree(dir))) {
      throw new GitxError(`not cloned: ${repoName}`, {
        code: ExitCode.NotFound,
        hint: `Run \`gitx clone ${repoName}\` first, or check \`gitx list\` for the name.`,
      });
    }
    return dir;
  }
}

/**
 * Applies name filters, skip lists and the `--after` cursor to a repo list.
 *
 * @param repos The repositories to filter.
 * @param [options] The options to be used.
 * @returns The filtered repositories, and any requested names that matched nothing.
 */
export const filterRepos = (
  repos: readonly Repo[],
  options: FilterReposOptions = {},
): FilterReposResult => {
  const only = options.only ?? [];
  const skip = options.skip ?? [];

  let selected = [...repos];

  if (only.length > 0) {
    selected = selected.filter((repo) => matchesAny(repo.name, only));
  }

  if (skip.length > 0) {
    selected = selected.filter((repo) => !matchesAny(repo.name, skip));
  }

  const after = options.after;
  if (after !== undefined && after.length > 0) {
    // Compared lexicographically rather than by exact name so an interrupted sweep can be resumed
    // with any prefix, not just a repository that exists.
    selected = selected.filter((repo) => repo.name.localeCompare(after) > 0);
  }

  const unmatched = only.filter(
    (pattern) => !repos.some((repo) => matchesAny(repo.name, [pattern])),
  );

  return { selected, unmatched };
};

/**
 * Decides whether a working tree counts as dirty, ignoring paths the user has told us not to care
 * about (`update.ignoreDirty`, e.g. `.idea/`).
 *
 * @param statusLines Lines from `git status --porcelain`.
 * @param [ignorePaths] Paths/globs to ignore when deciding dirtiness.
 * @returns `true` if any non-ignored path has changes; otherwise `false`.
 */
export const isDirty = (
  statusLines: readonly string[],
  ignorePaths: readonly string[] = [],
): boolean => {
  if (statusLines.length === 0) return false;
  if (ignorePaths.length === 0) return true;

  return statusLines.some((line) => {
    const filePath = statusPath(line);
    return !ignorePaths.some((ignore) => pathMatchesIgnore(filePath, ignore));
  });
};

/**
 * Returns whether the specified directory is a git working tree (i.e. it contains a `.git` entry).
 *
 * A `.git` entry may be a directory, or a file when using worktrees/submodules.
 *
 * @param dir The directory to check.
 * @returns `true` if `dir` is a git working tree; otherwise `false`.
 */
export const isGitWorkTree = async (dir: string): Promise<boolean> => {
  try {
    const stats = await stat(path.join(dir, '.git'));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
};

/**
 * Extracts the path from a `git status --porcelain` line, handling renames.
 *
 * @param line A single `git status --porcelain` line.
 * @returns The affected path, unquoted.
 */
export const statusPath = (line: string): string => {
  const raw = line.slice(3).trim();
  const renameIndex = raw.indexOf(' -> ');
  const target = renameIndex === -1 ? raw : raw.slice(renameIndex + 4);
  return unquoteStatusPath(target);
};
