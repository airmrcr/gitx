import { requireCredential } from './auth.ts';
import { ApiClient } from './http.ts';
import type {
  CiRun,
  Provider,
  ProviderListReposOptions,
  ProviderListRunsOptions,
  RemoteRepo,
  RunState,
} from './types.ts';

interface GithubRepo {
  archived: boolean;
  clone_url: string;
  default_branch: string | null;
  full_name: string;
  name: string;
  private: boolean;
  ssh_url: string;
  visibility?: string | null;
}

interface GithubRun {
  created_at: string;
  head_branch: string | null;
  html_url: string;
  name: string | null;
  run_started_at?: string | null;
  status: string | null;
}

interface GithubUser {
  login: string;
  type?: string;
}

// Statuses that mean a run has not finished.
//
// GitHub's `status` moves queued -> in_progress -> completed, with the outcome reported separately
// as `conclusion`, so anything that is not `completed` is still in flight.
const PENDING_STATUSES = new Set(['queued', 'requested', 'waiting', 'pending']);

const matchesVisibility = (
  repo: GithubRepo,
  visibility: ProviderListReposOptions['visibility'],
): boolean => {
  // GitHub's list endpoints have no usable visibility filter -- `/orgs` offers `type` and `/users`
  // offers nothing -- so this is applied to the response.
  if (visibility === 'all') return true;
  if (repo.visibility) return repo.visibility === visibility;
  // Without a visibility field, only public/private can be inferred from `repo.private` --
  // 'internal' cannot be, so it matches nothing rather than silently falling back to every public
  // repo.
  if (visibility === 'internal') return false;
  return visibility === 'private' ? repo.private : !repo.private;
};

const runState = (status: string): RunState => {
  if (status === 'in_progress') return 'running';
  return PENDING_STATUSES.has(status) ? 'pending' : 'finished';
};

/**
 * Options for constructing a {@link GithubProvider}.
 */
export interface GithubProviderOptions {
  /**
   * Environment to read a token from.
   *
   * @default process.env
   */
  env?: NodeJS.ProcessEnv;
  /** Overrides the `fetch` implementation used, mainly for tests. */
  fetchImpl?: typeof fetch;
  /**
   * The host to talk to.
   *
   * @default {@link GITHUB_DEFAULT_HOST}
   */
  host?: string;
}

/** The default host for github.com, as opposed to a GitHub Enterprise Server instance. */
export const GITHUB_DEFAULT_HOST = 'github.com';

/** Environment variables other GitHub tooling already uses. */
export const GITHUB_ENV_NAMES = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN'] as const);

/**
 * GitHub Enterprise Server serves its API under `/api/v3`; github.com uses a dedicated `api.` host
 * instead.
 *
 * @param host The host to build an API base for.
 * @returns The absolute API base URL for `host`.
 */
export const githubApiBase = (host: string): string =>
  host === GITHUB_DEFAULT_HOST ? 'https://api.github.com' : `https://${host}/api/v3`;

/**
 * {@link Provider} implementation for GitHub and GitHub Enterprise Server.
 */
export class GithubProvider implements Provider {
  readonly host: string;
  readonly id = 'github' as const;
  readonly label = 'GitHub';
  readonly runNoun = 'workflow run';

  #client: ApiClient | undefined;
  #login: Promise<string | undefined> | undefined;
  readonly #options: GithubProviderOptions;

  /**
   * Creates a new {@link GithubProvider} instance with the specified `options`.
   *
   * @param [options] The options to be used.
   */
  constructor(options: GithubProviderOptions = {}) {
    this.host = options.host ?? GITHUB_DEFAULT_HOST;
    this.#options = options;
  }

  /**
   * @inheritDoc
   */
  async currentLogin(): Promise<string | undefined> {
    this.#login ??= this.#fetchLogin();
    return this.#login;
  }

  /**
   * @inheritDoc
   */
  async listRepos(options: ProviderListReposOptions): Promise<RemoteRepo[]> {
    const api = await this.#api(options.signal);
    const repos = await this.#fetchRepos(api, options);

    return repos
      .filter((repo) => options.includeArchived || !repo.archived)
      .filter((repo) => matchesVisibility(repo, options.visibility))
      .map((repo) => ({
        archived: repo.archived,
        cloneUrl: { ssh: repo.ssh_url, https: repo.clone_url },
        defaultBranch: repo.default_branch ?? undefined,
        name: repo.name,
        path: repo.full_name,
      }));
  }

  /**
   * @inheritDoc
   */
  async listRuns(repoPath: string, options: ProviderListRunsOptions): Promise<CiRun[]> {
    const api = await this.#api(options.signal);

    const response = await api.get<{ workflow_runs?: GithubRun[] }>(
      `/repos/${repoPath}/actions/runs`,
      {
        query: {
          per_page: Math.min(options.limit, 100),
          ...(options.user ? { actor: options.user } : {}),
        },
        // A repository with Actions disabled is not a failure worth reporting.
        tolerate: [404, 403],
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    return (response?.workflow_runs ?? []).map((run) => ({
      createdAt: run.created_at,
      name: run.name ?? 'workflow',
      ref: run.head_branch ?? '',
      startedAt: run.run_started_at ?? undefined,
      state: runState(run.status ?? ''),
      status: run.status ?? 'unknown',
      url: run.html_url,
    }));
  }

  async #api(signal?: AbortSignal): Promise<ApiClient> {
    if (this.#client) return this.#client;

    const credential = await requireCredential({
      envNames: GITHUB_ENV_NAMES,
      host: this.host,
      label: this.label,
      tokenUrl: `https://${this.host}/settings/tokens`,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(signal ? { signal } : {}),
    });

    this.#client = new ApiClient({
      baseUrl: githubApiBase(this.host),
      label: this.label,
      headers: {
        Authorization: `Bearer ${credential.token}`,
        Accept: 'application/vnd.github+json',
        // Pinned so a future default version cannot change our response shapes.
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gitx',
      },
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
    });

    return this.#client;
  }

  async #fetchLogin(): Promise<string | undefined> {
    const api = await this.#api();
    const user = await api.get<GithubUser>('/user', { tolerate: [401, 403] });
    return user?.login;
  }

  async #fetchRepos(api: ApiClient, options: ProviderListReposOptions): Promise<GithubRepo[]> {
    const page = {
      limit: options.limit,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const login = await this.currentLogin();
    if (login !== undefined && login.toLowerCase() === options.owner.toLowerCase()) {
      return api.paginate<GithubRepo>('/user/repos', {
        ...page,
        query: { affiliation: 'owner', sort: 'full_name' },
      });
    }

    const owner = encodeURIComponent(options.owner);
    const asOrg = await api.get<unknown>(`/orgs/${owner}`, { ...page, tolerate: [404] });

    return asOrg === undefined
      ? api.paginate<GithubRepo>(`/users/${owner}/repos`, { ...page, query: { sort: 'full_name' } })
      : api.paginate<GithubRepo>(`/orgs/${owner}/repos`, { ...page, query: { sort: 'full_name' } });
  }
}
