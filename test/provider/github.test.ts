import { describe, expect, it } from 'vitest';
import { githubApiBase, GithubProvider } from '../../src/provider/github.ts';

interface Call {
  headers: Record<string, string>;
  url: string;
}

const ENV = { GITX_TOKEN: 'test-token' };
const listOptions = {
  includeArchived: false,
  limit: 100,
  owner: 'acme',
  visibility: 'all' as const,
};

const repo = (name: string, overrides: Record<string, unknown> = {}) => ({
  archived: false,
  clone_url: `https://github.com/acme/${name}.git`,
  default_branch: 'main',
  full_name: `acme/${name}`,
  name,
  private: false,
  ssh_url: `git@github.com:acme/${name}.git`,
  visibility: 'public',
  ...overrides,
});

const run = (overrides: Record<string, unknown> = {}) => ({
  created_at: '2024-01-01T00:00:00Z',
  head_branch: 'main',
  name: 'CI',
  status: 'completed',
  run_started_at: '2024-01-01T00:00:05Z',
  html_url: 'https://github.com/acme/alpha/actions/runs/1',
  ...overrides,
});

const stub = (routes: Record<string, unknown>) => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });

    const path = new URL(url).pathname;
    const match = Object.keys(routes)
      .filter((route) => path.startsWith(route))
      .toSorted((a, b) => b.length - a.length)[0];

    if (match === undefined) return new Response('{"message":"Not Found"}', { status: 404 });

    const body = routes[match];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
};

describe('githubApiBase', () => {
  it('uses the dedicated API host for github.com', () => {
    expect(githubApiBase('github.com')).toBe('https://api.github.com');
  });

  // Enterprise Server has no `api.` host; it serves the v3 API in-place.
  it('uses /api/v3 for Enterprise Server', () => {
    expect(githubApiBase('git.acme.dev')).toBe('https://git.acme.dev/api/v3');
  });
});

describe('GithubProvider.listRepos', () => {
  it('lists an organisation through the org endpoint', async () => {
    const { fetchImpl, calls } = stub({
      '/user': { login: 'someone-else' },
      '/orgs/acme': { login: 'acme' },
      '/orgs/acme/repos': [repo('alpha'), repo('beta')],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(repos.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(calls.some((call) => call.url.includes('/orgs/acme/repos'))).toBe(true);
  });

  // `/users/{u}/repos` only ever returns public repositories, so listing your own account has to go
  // through `/user/repos` or half the repos vanish.
  it('lists your own account through /user/repos', async () => {
    const { fetchImpl, calls } = stub({
      '/user/repos': [repo('mine', { private: true, visibility: 'private' })],
      '/user': { login: 'acme' },
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(repos.map((entry) => entry.name)).toEqual(['mine']);
    expect(calls.some((call) => call.url.includes('affiliation=owner'))).toBe(true);
    expect(calls.some((call) => call.url.includes('/users/acme/repos'))).toBe(false);
  });

  it('matches your own login case-insensitively', async () => {
    const { fetchImpl, calls } = stub({
      '/user/repos': [repo('mine')],
      '/user': { login: 'AcMe' },
    });

    await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(calls.some((call) => call.url.includes('/user/repos'))).toBe(true);
  });

  // `/orgs/{name}` 404s for a personal account, which is how the two are told apart without a
  // second guess.
  it('falls back to the user endpoint when the owner is not an org', async () => {
    const { fetchImpl, calls } = stub({
      '/user': { login: 'someone-else' },
      '/users/acme/repos': [repo('alpha')],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(repos).toHaveLength(1);
    expect(calls.some((call) => call.url.includes('/users/acme/repos'))).toBe(true);
  });

  it('hides archived repositories by default', async () => {
    const { fetchImpl } = stub({
      '/user': { login: 'x' },
      '/orgs/acme': {},
      '/orgs/acme/repos': [repo('alpha'), repo('old', { archived: true })],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(repos.map((entry) => entry.name)).toEqual(['alpha']);
  });

  it('keeps archived repositories when asked', async () => {
    const { fetchImpl } = stub({
      '/user': { login: 'x' },
      '/orgs/acme': {},
      '/orgs/acme/repos': [repo('alpha'), repo('old', { archived: true })],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos({
      ...listOptions,
      includeArchived: true,
    });

    expect(repos).toHaveLength(2);
  });

  it('filters by visibility client-side', async () => {
    const { fetchImpl } = stub({
      '/user': { login: 'x' },
      '/orgs/acme': {},
      '/orgs/acme/repos': [repo('open'), repo('closed', { private: true, visibility: 'private' })],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos({
      ...listOptions,
      visibility: 'private',
    });

    expect(repos.map((entry) => entry.name)).toEqual(['closed']);
  });

  it('falls back to `private` when visibility is absent', async () => {
    const { fetchImpl } = stub({
      '/user': { login: 'x' },
      '/orgs/acme': {},
      '/orgs/acme/repos': [
        repo('open', { visibility: null }),
        repo('closed', {
          private: true,
          visibility: null,
        }),
      ],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos({
      ...listOptions,
      visibility: 'public',
    });

    expect(repos.map((entry) => entry.name)).toEqual(['open']);
  });

  // `repo.private` cannot distinguish 'internal' from 'public', so a repo missing the `visibility`
  // field must not silently match an `internal` filter the way it would if this fell back to
  // `!repo.private`.
  it('matches nothing for `internal` when visibility is absent', async () => {
    const { fetchImpl } = stub({
      '/user': { login: 'x' },
      '/orgs/acme': {},
      '/orgs/acme/repos': [
        repo('open', { visibility: null }),
        repo('closed', { private: true, visibility: null }),
      ],
    });

    const repos = await new GithubProvider({ fetchImpl, env: ENV }).listRepos({
      ...listOptions,
      visibility: 'internal',
    });

    expect(repos).toEqual([]);
  });

  // Hand-built URLs break on Enterprise hosts and custom SSH ports; the API already knows the right
  // answer.
  it('takes clone URLs from the API rather than building them', async () => {
    const { fetchImpl } = stub({
      '/user': { login: 'x' },
      '/orgs/acme': {},
      '/orgs/acme/repos': [
        repo('alpha', {
          ssh_url: 'ssh://git@git.acme.dev:2222/acme/alpha.git',
          clone_url: 'https://git.acme.dev/acme/alpha.git',
        }),
      ],
    });

    const [entry] = await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(entry?.cloneUrl).toEqual({
      ssh: 'ssh://git@git.acme.dev:2222/acme/alpha.git',
      https: 'https://git.acme.dev/acme/alpha.git',
    });
  });

  it('pins the API version so response shapes cannot drift', async () => {
    const { fetchImpl, calls } = stub({ '/user': { login: 'acme' }, '/user/repos': [] });

    await new GithubProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(calls[0]?.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });
});

describe('GithubProvider.listRuns', () => {
  it('maps workflow runs onto the shared shape', async () => {
    const { fetchImpl } = stub({ '/repos/acme/alpha/actions/runs': { workflow_runs: [run()] } });

    const runs = await new GithubProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs).toEqual([
      {
        name: 'CI',
        ref: 'main',
        status: 'completed',
        state: 'finished',
        createdAt: '2024-01-01T00:00:00Z',
        startedAt: '2024-01-01T00:00:05Z',
        url: 'https://github.com/acme/alpha/actions/runs/1',
      },
    ]);
  });

  it.each([
    ['queued', 'pending'],
    ['requested', 'pending'],
    ['waiting', 'pending'],
    ['in_progress', 'running'],
    ['completed', 'finished'],
  ])('reads %s as %s', async (status, state) => {
    const { fetchImpl } = stub({
      '/repos/acme/alpha/actions/runs': { workflow_runs: [run({ status })] },
    });

    const runs = await new GithubProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs[0]?.state).toBe(state);
  });

  it('filters by actor when a user is given', async () => {
    const { fetchImpl, calls } = stub({
      '/repos/acme/alpha/actions/runs': { workflow_runs: [] },
    });

    await new GithubProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
      user: 'acme',
    });

    expect(calls[0]?.url).toContain('actor=acme');
  });

  // Actions being switched off is a normal state, not an error to report.
  it('returns nothing when Actions is disabled', async () => {
    const { fetchImpl } = stub({});

    const runs = await new GithubProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs).toEqual([]);
  });
});
