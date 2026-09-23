// Everything here is deliberately phrased in neutral terms. Where multiple platforms disagree on
// vocabulary the interface takes the neutral word and each adaptor translates: GitHub's "workflow
// run" and GitLab's "pipeline" are both a `CiRun`.

/**
 * A CI run (GitHub workflow run or GitLab pipeline) as reported by a provider.
 */
export interface CiRun {
  /** When the run was created, as an ISO 8601 timestamp. */
  createdAt: string;
  /**
   * Best available name.
   *
   * GitHub has a real workflow name; GitLab pipelines are usually unnamed, so the adaptor falls
   * back to the trigger source.
   */
  name: string;
  /** Branch or ref the run belongs to. */
  ref: string;
  /** When the run started, as an ISO 8601 timestamp, if it has started. */
  startedAt: string | undefined;
  /** Whether the run has finished, in terms all platforms can agree on. */
  state: RunState;
  /** The provider's own status word, shown verbatim so it matches their UI. */
  status: string;
  /** Link to the run on the provider's site. */
  url: string;
}

/**
 * How a repository is cloned.
 */
export type Protocol = 'ssh' | 'https';

/**
 * Provider abstraction.
 *
 * gitx talks to a forge -- GitHub, GitLab -- only through this interface, so commands never need to
 * know which one they are pointed at. Adding Gitea or Bitbucket means implementing `Provider` and
 * registering it; no command code changes.
 */
export interface Provider {
  /** Host this instance talks to (e.g. `github.com` or `git.acme.internal`). */
  readonly host: string;
  /** Which forge this instance talks to. */
  readonly id: ProviderId;
  /** Display name (e.g. `GitHub`). */
  readonly label: string;
  /**
   * What this provider calls a CI run, singular. Used in messages so the wording matches the
   * platform the user is actually looking at.
   */
  readonly runNoun: string;

  /**
   * Returns the login of the authenticated account, if any.
   *
   * @returns The authenticated login, or `undefined` when signed out.
   */
  currentLogin(): Promise<string | undefined>;
  /**
   * Returns every repository belonging to an organisation, group or user.
   *
   * @param options The options to be used.
   * @returns The matching repositories.
   */
  listRepos(options: ProviderListReposOptions): Promise<RemoteRepo[]>;
  /**
   * Returns recent CI runs for one repository, newest first.
   *
   * @param repoPath Full namespace path of the repository (e.g. `acme/widgets`).
   * @param options The options to be used.
   * @returns The matching CI runs, newest first.
   */
  listRuns(repoPath: string, options: ProviderListRunsOptions): Promise<CiRun[]>;
}

/**
 * The forges gitx can talk to.
 */
export type ProviderId = 'github' | 'gitlab';

/**
 * Options for {@link Provider.listRepos}.
 */
export interface ProviderListReposOptions {
  /** Whether archived repositories should be included. */
  includeArchived: boolean;
  /** Upper bound on repositories returned, across all pages. */
  limit: number;
  /** Organisation, group or user that owns the repositories. */
  owner: string;
  /** Aborted to cancel the listing. */
  signal?: AbortSignal | undefined;
  /** Filters repositories by visibility. */
  visibility: Visibility;
}

/**
 * Options for {@link Provider.listRuns}.
 */
export interface ProviderListRunsOptions {
  /** Upper bound on runs returned, across all pages. */
  limit: number;
  /** Only runs triggered by this login, when given. */
  user?: string | undefined;
  /** Aborted to cancel the listing. */
  signal?: AbortSignal | undefined;
}

/**
 * A repository as reported by a provider.
 */
export interface RemoteRepo {
  /** Whether the repository has been archived. */
  archived: boolean;
  /**
   * Clone URLs exactly as the API reported them.
   *
   * Never rebuilt from parts: the provider already knows about self-hosted ports, nested GitLab
   * subgroups and enterprise host names, and guessing gets all three wrong.
   */
  cloneUrl: Readonly<Record<Protocol, string>>;
  /** The repository's default branch, if known. */
  defaultBranch: string | undefined;
  /**
   * URL-safe slug, used as the directory name on disk.
   *
   * Deliberately not the human-facing title: GitLab's `name` is "Global Feature Flag Hub" where its
   * `path` is "global-feature-flag-hub", and only the latter is fit to be a directory.
   */
  name: string;
  /** Full namespace path (e.g. `acme/widgets` or `acme/team/widgets`). */
  path: string;
}

/**
 * Whether a run has finished, in terms all platforms can agree on.
 */
export type RunState = 'pending' | 'running' | 'finished';

/**
 * How visible a repository is.
 */
export type Visibility = 'all' | 'public' | 'private' | 'internal';
