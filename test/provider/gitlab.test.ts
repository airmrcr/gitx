import { describe, expect, it } from 'vitest';
import { gitlabApiBase, GitlabProvider } from '../../src/provider/gitlab.ts';

interface Call {
  headers: Record<string, string>;
  url: string;
}

const API = '/api/v4';
const ENV = { GITX_TOKEN: 'test-token' };
const listOptions = {
  includeArchived: false,
  limit: 100,
  owner: 'acme',
  visibility: 'all' as const,
};

const pipeline = (overrides: Record<string, unknown> = {}) => ({
  created_at: '2024-01-01T00:00:00Z',
  name: null,
  ref: 'main',
  source: 'push',
  status: 'success',
  updated_at: '2024-01-01T00:01:00Z',
  web_url: 'https://gitlab.com/acme/alpha/-/pipelines/1',
  ...overrides,
});

const project = (path: string, overrides: Record<string, unknown> = {}) => ({
  archived: false,
  default_branch: 'main',
  http_url_to_repo: `https://gitlab.com/acme/${path}.git`,
  name: path.toUpperCase(),
  path,
  path_with_namespace: `acme/${path}`,
  ssh_url_to_repo: `git@gitlab.com:acme/${path}.git`,
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

    if (match === undefined) return new Response('{"message":"404 Not found"}', { status: 404 });

    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
};

describe('gitlabApiBase', () => {
  // Unlike GitHub, the path is the same everywhere, self-managed included.
  it('is always /api/v4 on the configured host', () => {
    expect(gitlabApiBase('gitlab.com')).toBe('https://gitlab.com/api/v4');
    expect(gitlabApiBase('git.acme.dev')).toBe('https://git.acme.dev/api/v4');
  });
});

describe('GitlabProvider.listRepos', () => {
  it('lists a group through the group endpoint', async () => {
    const { fetchImpl, calls } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [project('alpha'), project('beta')],
    });

    const repos = await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(repos.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
    expect(calls.some((call) => call.url.includes('/groups/acme/projects'))).toBe(true);
  });

  it('lists a user through the user endpoint', async () => {
    const { fetchImpl, calls } = stub({
      [`${API}/namespaces/acme`]: { kind: 'user' },
      [`${API}/users/acme/projects`]: [project('alpha')],
    });

    const repos = await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(repos).toHaveLength(1);
    expect(calls.some((call) => call.url.includes('/users/acme/projects'))).toBe(true);
  });

  it('assumes a group when the namespace cannot be resolved', async () => {
    const { fetchImpl, calls } = stub({ [`${API}/groups/acme/projects`]: [project('alpha')] });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(calls.some((call) => call.url.includes('/groups/acme/projects'))).toBe(true);
  });

  // `name` is a human title -- "Gitway" for `gitway` -- and using it would produce mangled
  // directory names on clone.
  it('names repositories by slug, not by title', async () => {
    const { fetchImpl } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [
        project('gitway', { name: 'Gitway', path_with_namespace: 'acme/team/gitway' }),
      ],
    });

    const [entry] = await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(entry?.name).toBe('gitway');
    expect(entry?.path).toBe('acme/team/gitway');
  });

  it('reaches into subgroups but not into other groups projects', async () => {
    const { fetchImpl, calls } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [],
    });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    const request = calls.find((call) => call.url.includes('/groups/acme/projects'))?.url ?? '';
    expect(request).toContain('include_subgroups=true');
    expect(request).toContain('with_shared=false');
  });

  // GitLab can filter server-side, so unlike GitHub these become query params.
  it('asks the server to exclude archived projects', async () => {
    const { fetchImpl, calls } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [],
    });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(calls.at(-1)?.url).toContain('archived=false');
  });

  it('omits the archived filter when archived projects are wanted', async () => {
    const { fetchImpl, calls } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [],
    });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRepos({
      ...listOptions,
      includeArchived: true,
    });

    expect(calls.at(-1)?.url).not.toContain('archived=');
  });

  it('passes a visibility filter through to the server', async () => {
    const { fetchImpl, calls } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [],
    });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRepos({
      ...listOptions,
      visibility: 'private',
    });

    expect(calls.at(-1)?.url).toContain('visibility=private');
  });

  it('takes clone URLs from the API', async () => {
    const { fetchImpl } = stub({
      [`${API}/namespaces/acme`]: { kind: 'group' },
      [`${API}/groups/acme/projects`]: [project('alpha')],
    });

    const [entry] = await new GitlabProvider({ fetchImpl, env: ENV }).listRepos(listOptions);

    expect(entry?.cloneUrl).toEqual({
      ssh: 'git@gitlab.com:acme/alpha.git',
      https: 'https://gitlab.com/acme/alpha.git',
    });
  });
});

describe('GitlabProvider.listRuns', () => {
  // Namespaced project paths are a single URL-encoded path segment.
  it('encodes the project path, slashes included', async () => {
    const { fetchImpl, calls } = stub({ [`${API}/projects/acme%2Fteam%2Falpha/pipelines`]: [] });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRuns('acme/team/alpha', { limit: 5 });

    expect(calls[0]?.url).toContain('/projects/acme%2Fteam%2Falpha/pipelines');
  });

  // Pipelines are nearly always unnamed, so the trigger source is shown.
  it('falls back to the trigger source when a pipeline is unnamed', async () => {
    const { fetchImpl } = stub({
      [`${API}/projects/acme%2Falpha/pipelines`]: [pipeline({ source: 'merge_request_event' })],
    });

    const runs = await new GitlabProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs[0]?.name).toBe('merge_request_event');
  });

  it('prefers a real pipeline name when there is one', async () => {
    const { fetchImpl } = stub({
      [`${API}/projects/acme%2Falpha/pipelines`]: [pipeline({ name: 'Nightly' })],
    });

    const runs = await new GitlabProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs[0]?.name).toBe('Nightly');
  });

  it.each([
    ['success', 'finished'],
    ['failed', 'finished'],
    ['canceled', 'finished'],
    ['skipped', 'finished'],
    ['running', 'running'],
    ['pending', 'pending'],
    ['created', 'pending'],
    ['preparing', 'pending'],
    // An unknown status is treated as in flight rather than dropped, because GitLab keeps adding
    // new ones.
    ['waiting_for_callback', 'pending'],
  ])('reads %s as %s', async (status, state) => {
    const { fetchImpl } = stub({
      [`${API}/projects/acme%2Falpha/pipelines`]: [pipeline({ status })],
    });

    const runs = await new GitlabProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs[0]?.state).toBe(state);
  });

  it('filters by username when one is given', async () => {
    const { fetchImpl, calls } = stub({ [`${API}/projects/acme%2Falpha/pipelines`]: [] });

    await new GitlabProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
      user: 'acme',
    });

    expect(calls[0]?.url).toContain('username=acme');
  });

  it('returns nothing when the project has no pipelines enabled', async () => {
    const { fetchImpl } = stub({});

    const runs = await new GitlabProvider({ fetchImpl, env: ENV }).listRuns('acme/alpha', {
      limit: 5,
    });

    expect(runs).toEqual([]);
  });
});

describe('GitlabProvider.currentLogin', () => {
  it('reads the username of the token owner', async () => {
    const { fetchImpl } = stub({ [`${API}/user`]: { username: 'acme' } });

    await expect(new GitlabProvider({ fetchImpl, env: ENV }).currentLogin()).resolves.toBe('acme');
  });

  // Listing should still work with a token that cannot read /user.
  it('returns undefined rather than failing on a rejected token', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"401 Unauthorized"}', { status: 401 })) as unknown as typeof fetch;

    await expect(
      new GitlabProvider({ fetchImpl, env: ENV }).currentLogin(),
    ).resolves.toBeUndefined();
  });
});
