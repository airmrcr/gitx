import { exec, type ExecOptions, type ExecResult } from '../util/exec.ts';

const stripRemotePrefix = (ref: string, remote: string): string =>
  ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;

/**
 * Options for {@link Git.deleteBranch}.
 */
export interface GitDeleteBranchOptions {
  /** Whether to force-delete the branch. */
  force?: boolean;
}

/**
 * Options for {@link Git.fetch}.
 */
export interface GitFetchOptions {
  /**
   * Whether to prune deleted remote branches.
   *
   * @default true
   */
  prune?: boolean;
  /** Whether to fetch tags. */
  tags?: boolean;
}

/**
 * Options for constructing a {@link Git} wrapper.
 */
export interface GitOptions {
  /** Force coloured output from git itself. */
  color?: boolean;
  /** The working directory git commands are run in. */
  cwd: string;
  /** Environment variables for the git process. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Options for {@link Git.run}.
 */
export type GitRunOptions = Omit<ExecOptions, 'cwd' | 'env'>;

/**
 * Options for {@link Git.submoduleUpdate}.
 */
export interface GitSubmoduleUpdateOptions {
  /**
   * Whether to initialise submodules.
   *
   * @default true
   */
  init?: boolean;
  /**
   * Whether to update submodules recursively.
   *
   * @default true
   */
  recursive?: boolean;
}

/**
 * A thin, typed wrapper around the `git` binary.
 *
 * Everything gitx needs is expressed here rather than relying on the user's local aliases, so
 * behaviour is identical on any machine.
 */
export class Git {
  /**
   * Detects the "this repo no longer exists on the remote" fetch failure.
   *
   * @param output The stdout/stderr of a `git fetch`/`git pull` command.
   * @returns `true` if `output` indicates the remote repository no longer exists; otherwise
   * `false`.
   */
  static isRepositoryGone(output: string): boolean {
    return (
      /remote: (Repository not found|Not Found)/i.test(output) ||
      /ERROR: Repository not found/i.test(output) ||
      /fatal: repository '.*' not found/i.test(output)
    );
  }

  /**
   * Whether a pull reported that there was nothing to bring in.
   *
   * @param pullOutput The stdout of a `git pull` command.
   * @returns `true` if `pullOutput` indicates nothing needed pulling; otherwise `false`.
   */
  static isUpToDate(pullOutput: string): boolean {
    return /^Already up to date\.?$/m.test(pullOutput);
  }

  /** The working directory git commands are run in. */
  readonly cwd: string;
  readonly #color: boolean;
  readonly #env: NodeJS.ProcessEnv | undefined;

  /**
   * Creates a new {@link Git} instance with the specified `options`.
   *
   * @param options The options to be used.
   */
  constructor(options: GitOptions) {
    this.cwd = options.cwd;
    this.#color = options.color ?? false;
    this.#env = options.env;
  }

  /**
   * Runs git and returns trimmed stdout, or `undefined` when the command fails.
   *
   * @param args The arguments to pass to git.
   * @returns Trimmed stdout, or `undefined` if the command failed.
   */
  async capture(args: readonly string[]): Promise<string | undefined> {
    const result = await exec('git', args, { cwd: this.cwd, env: this.#env });
    return result.ok ? result.stdout.trim() : undefined;
  }

  /**
   * Checks out a ref.
   *
   * @param ref The ref to check out.
   * @returns The captured result.
   */
  checkout(ref: string): Promise<ExecResult> {
    return this.run(['checkout', ref]);
  }

  /**
   * The current branch name, or `undefined` when HEAD is detached.
   *
   * @returns The current branch name, or `undefined` when HEAD is detached.
   */
  async currentBranch(): Promise<string | undefined> {
    return this.capture(['symbolic-ref', '--short', '--quiet', 'HEAD']);
  }

  /**
   * Resolves the remote's default branch.
   *
   * Tries the cached `origin/HEAD` ref first, then asks the remote and caches the answer, and
   * finally falls back to whichever conventional branch exists.
   *
   * @param [remote='origin'] The remote to resolve the default branch for.
   * @returns The remote's default branch, or `undefined` if none could be determined.
   */
  async defaultBranch(remote = 'origin'): Promise<string | undefined> {
    const symbolic = await this.capture([
      'symbolic-ref',
      '--short',
      '--quiet',
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (symbolic) return stripRemotePrefix(symbolic, remote);

    // `set-head --auto` repairs a missing origin/HEAD, which is common in clones made before the
    // default branch was renamed.
    const repaired = await this.run(['remote', 'set-head', remote, '--auto']);
    if (repaired.ok) {
      const retried = await this.capture([
        'symbolic-ref',
        '--short',
        '--quiet',
        `refs/remotes/${remote}/HEAD`,
      ]);
      if (retried) return stripRemotePrefix(retried, remote);
    }

    for (const candidate of ['main', 'master', 'develop', 'trunk']) {
      const exists = await this.capture([
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/${remote}/${candidate}`,
      ]);
      if (exists) return candidate;
    }

    return undefined;
  }

  /**
   * Deletes a local branch.
   *
   * @param name The branch to delete.
   * @param [options] The options to be used.
   * @returns The captured result.
   */
  deleteBranch(name: string, options: GitDeleteBranchOptions = {}): Promise<ExecResult> {
    return this.run(['branch', options.force === true ? '-D' : '-d', name]);
  }

  /**
   * Fetches from a remote.
   *
   * @param [options] The options to be used.
   * @returns The captured result.
   */
  fetch(options: GitFetchOptions = {}): Promise<ExecResult> {
    const args = ['fetch'];
    if (options.prune !== false) args.push('--prune');
    if (options.tags) args.push('--tags');
    return this.run(args);
  }

  /**
   * Local branches whose upstream has been deleted, as reported by `git branch -vv`. These are what
   * `tidy` removes.
   *
   * @returns The names of branches whose upstream is gone.
   */
  async goneBranches(): Promise<string[]> {
    const output = await this.capture([
      'for-each-ref',
      '--format=%(refname:short)\t%(upstream)\t%(upstream:track)',
      'refs/heads',
    ]);
    if (!output) return [];

    return output
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([, upstream, track]) => Boolean(upstream) && track === '[gone]')
      .map(([name]) => name!)
      .filter((name) => name.length > 0);
  }

  /**
   * Returns whether a named remote is configured.
   *
   * @param [remote='origin'] The remote to check for.
   * @returns `true` if `remote` is configured; otherwise `false`.
   */
  async hasRemote(remote = 'origin'): Promise<boolean> {
    const remotes = await this.capture(['remote']);
    return remotes?.split('\n').includes(remote) ?? false;
  }

  /**
   * Returns whether the repository has any submodules.
   *
   * @returns `true` if the repository has at least one submodule; otherwise `false`.
   */
  async hasSubmodules(): Promise<boolean> {
    return (await this.submoduleStatus()).length > 0;
  }

  /**
   * Returns whether {@link cwd} is inside a git working tree.
   *
   * @returns `true` if {@link cwd} is inside a git working tree; otherwise `false`.
   */
  async isRepository(): Promise<boolean> {
    return (await this.capture(['rev-parse', '--is-inside-work-tree'])) === 'true';
  }

  /**
   * Pulls the current branch.
   *
   * @param [extraArgs] Additional arguments passed to `git pull`.
   * @returns The captured result.
   */
  pull(extraArgs: readonly string[] = []): Promise<ExecResult> {
    return this.run(['pull', ...extraArgs]);
  }

  /**
   * The working tree's top level, which may be above {@link cwd}.
   *
   * @returns The working tree's root directory, or `undefined` if not inside a repository.
   */
  async root(): Promise<string | undefined> {
    return this.capture(['rev-parse', '--show-toplevel']);
  }

  /**
   * Runs git, returning the result without throwing on failure.
   *
   * @param args The arguments to pass to git.
   * @param [options] The options to be used.
   * @returns The captured result.
   */
  run(args: readonly string[], options: GitRunOptions = {}): Promise<ExecResult> {
    // `-c` is used instead of GIT_CONFIG_PARAMETERS so quoting stays our problem, not the shell's.
    const prefix = this.#color ? ['-c', 'color.ui=always'] : [];
    return exec('git', [...prefix, ...args], {
      ...options,
      cwd: this.cwd,
      env: this.#env,
    });
  }

  /**
   * Porcelain status entries, one per changed path.
   *
   * @returns The non-empty `git status --porcelain` lines.
   */
  async status(): Promise<string[]> {
    const output = await this.capture(['status', '--porcelain']);
    if (!output) return [];
    return output.split('\n').filter((line) => line.trim().length > 0);
  }

  /**
   * Raw `git submodule status` lines, empty when the repo has no submodules.
   *
   * @returns The non-empty `git submodule status --recursive` lines.
   */
  async submoduleStatus(): Promise<string[]> {
    const output = await this.capture(['submodule', 'status', '--recursive']);
    if (!output) return [];
    return output.split('\n').filter((line) => line.trim().length > 0);
  }

  /**
   * Initialises and updates submodules.
   *
   * @param [options] The options to be used.
   * @returns The captured result.
   */
  submoduleUpdate(options: GitSubmoduleUpdateOptions = {}): Promise<ExecResult> {
    const args = ['submodule', 'update'];
    if (options.init !== false) args.push('--init');
    if (options.recursive !== false) args.push('--recursive');
    return this.run(args);
  }
}
