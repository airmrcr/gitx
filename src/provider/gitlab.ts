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

interface GitlabNamespace {
  kind?: string;
}

interface GitlabPipeline {
  created_at: string;
  name: string | null;
  ref: string | null;
  source?: string | null;
  status: string;
  updated_at?: string | null;
  web_url: string;
}

interface GitlabProject {
  archived: boolean;
  default_branch: string | null;
  http_url_to_repo: string;
  name: string;
  path: string;
  path_with_namespace: string;
  ssh_url_to_repo: string;
}

// Pipeline statuses that mean the run has finished.
//
// Listed as terminal rather than pending because GitLab keeps adding new in-flight states
// (`waiting_for_callback` arrived long after `preparing`), and a new one should default to "still
// going" rather than silently vanishing from the report.
const FINISHED_STATUSES = new Set(['success', 'failed', 'canceled', 'skipped']);

const runState = (status: string): RunState => {
  if (FINISHED_STATUSES.has(status)) return 'finished';
  return status === 'running' ? 'running' : 'pending';
};

/** The default host for gitlab.com, as opposed to a self-hosted instance. */
export const GITLAB_DEFAULT_HOST = 'gitlab.com';

/** Environment variables the official `glab` CLI already understands. */
export const GITLAB_ENV_NAMES = Object.freeze(['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN'] as const);

/**
 * Builds the absolute API base for a GitLab host.
 *
 * @param host The host to build an API base for.
 * @returns The absolute API base URL for `host`.
 */
export const gitlabApiBase = (host: string): string => `https://${host}/api/v4`;

/**
 * Options for constructing a {@link GitlabProvider}.
 */
export interface GitlabProviderOptions {
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
   * @default {@link GITLAB_DEFAULT_HOST}
   */
  host?: string;
}

/**
 * {@link Provider} implementation for GitLab and self-hosted GitLab instances.
 */
export class GitlabProvider implements Provider {
  readonly host: string;
  readonly id = 'gitlab' as const;
  readonly label = 'GitLab';
  readonly runNoun = 'pipeline';

  #client: ApiClient | undefined;
  #login: Promise<string | undefined> | undefined;
  readonly #options: GitlabProviderOptions;

  /**
   * Creates a new {@link GitlabProvider} instance with the specified `options`.
   *
   * @param [options] The options to be used.
   */
  constructor(options: GitlabProviderOptions = {}) {
    this.host = options.host ?? GITLAB_DEFAULT_HOST;
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
    const projects = await this.#fetchProjects(api, options);

    return projects.map((project) => ({
      // `path` is the slug; `name` is a human title such as "Gitway", which would make a poor
      // directory name.
      archived: project.archived,
      cloneUrl: { ssh: project.ssh_url_to_repo, https: project.http_url_to_repo },
      defaultBranch: project.default_branch ?? undefined,
      name: project.path,
      path: project.path_with_namespace,
    }));
  }

  /**
   * @inheritDoc
   */
  async listRuns(repoPath: string, options: ProviderListRunsOptions): Promise<CiRun[]> {
    const api = await this.#api(options.signal);
    // Namespaced paths must be fully URL-encoded, slashes included.
    const project = encodeURIComponent(repoPath);

    const pipelines = await api.get<GitlabPipeline[]>(`/projects/${project}/pipelines`, {
      query: {
        per_page: Math.min(options.limit, 100),
        ...(options.user ? { username: options.user } : {}),
      },
      tolerate: [403, 404],
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return (pipelines ?? []).map((pipeline) => ({
      // Pipelines are usually unnamed; the trigger source is the most useful thing left to show.
      createdAt: pipeline.created_at,
      name: pipeline.name ?? pipeline.source ?? 'pipeline',
      ref: pipeline.ref ?? '',
      startedAt: pipeline.updated_at ?? undefined,
      state: runState(pipeline.status),
      status: pipeline.status,
      url: pipeline.web_url,
    }));
  }

  async #api(signal?: AbortSignal): Promise<ApiClient> {
    if (this.#client) return this.#client;

    const credential = await requireCredential({
      envNames: GITLAB_ENV_NAMES,
      host: this.host,
      label: this.label,
      tokenUrl: `https://${this.host}/-/user_settings/personal_access_tokens`,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(signal ? { signal } : {}),
    });

    this.#client = new ApiClient({
      baseUrl: gitlabApiBase(this.host),
      label: this.label,
      headers: {
        // Bearer works for both personal access tokens and OAuth tokens, where PRIVATE-TOKEN only
        // accepts the former.
        Authorization: `Bearer ${credential.token}`,
        'User-Agent': 'gitx',
      },
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
    });

    return this.#client;
  }

  async #fetchLogin(): Promise<string | undefined> {
    const api = await this.#api();
    const user = await api.get<{ username?: string }>('/user', { tolerate: [401, 403] });
    return user?.username;
  }

  async #fetchProjects(
    api: ApiClient,
    options: ProviderListReposOptions,
  ): Promise<GitlabProject[]> {
    // Groups and users need different endpoints, so the namespace is resolved first: `kind` tells
    // us which one this owner is.
    const owner = encodeURIComponent(options.owner);
    const query: Record<string, string | number | boolean | undefined> = {
      order_by: 'path',
      sort: 'asc',
      ...(options.includeArchived ? {} : { archived: false }),
      ...(options.visibility === 'all' ? {} : { visibility: options.visibility }),
    };

    const page = {
      limit: options.limit,
      query,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const namespace = await api.get<GitlabNamespace>(`/namespaces/${owner}`, {
      tolerate: [404],
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (namespace?.kind === 'user') {
      return api.paginate<GitlabProject>(`/users/${owner}/projects`, page);
    }

    return api.paginate<GitlabProject>(`/groups/${owner}/projects`, {
      ...page,
      query: {
        ...query,
        include_subgroups: true,
        // Projects merely shared with the group belong to someone else, and cloning them into this
        // owner's directory would be surprising.
        with_shared: false,
      },
    });
  }
}
