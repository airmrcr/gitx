import { describe, expect, it, vi } from 'vitest';
import { ApiClient, redactUrl } from '../../src/provider/http.ts';
import { ExitCode } from '../../src/util/errors.ts';

const client = (fetchImpl: typeof fetch) =>
  new ApiClient({
    baseUrl: 'https://api.example.test',
    headers: { authorization: 'Bearer secret' },
    label: 'Example',
    fetchImpl,
  });

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const page = (size: number, from = 0) =>
  Array.from({ length: size }, (_, index) => ({ id: from + index }));

const queued = (responses: Response[]) => {
  const urls: string[] = [];
  const impl = vi.fn<(input: string | URL | Request) => Promise<Response>>(async (input) => {
    urls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${String(input)}`);
    return next;
  }) as unknown as typeof fetch;
  return { impl, urls };
};

describe('ApiClient.get', () => {
  it('resolves paths against the base URL and sends the headers', async () => {
    const { impl, urls } = queued([json({ login: 'acme' })]);

    const body = await client(impl).get<{ login: string }>('/user');

    expect(body).toEqual({ login: 'acme' });
    expect(urls).toEqual(['https://api.example.test/user']);
  });

  it('leaves absolute URLs alone', async () => {
    const { impl, urls } = queued([json({})]);

    await client(impl).get('https://other.test/thing');

    expect(urls).toEqual(['https://other.test/thing']);
  });

  it('appends query parameters and drops undefined ones', async () => {
    const { impl, urls } = queued([json([])]);

    await client(impl).get('/repos', { query: { page: 2, archived: false, type: undefined } });

    expect(urls[0]).toBe('https://api.example.test/repos?page=2&archived=false');
  });

  it('returns undefined for an empty body', async () => {
    const { impl } = queued([new Response(null, { status: 204 })]);

    await expect(client(impl).get('/nothing')).resolves.toBeUndefined();
  });

  it('returns undefined for a tolerated status instead of throwing', async () => {
    const { impl } = queued([new Response('nope', { status: 404 })]);

    await expect(client(impl).get('/maybe', { tolerate: [404] })).resolves.toBeUndefined();
  });

  it('reports unparseable JSON rather than crashing', async () => {
    const { impl } = queued([new Response('<html>oops</html>', { status: 200 })]);

    await expect(client(impl).get('/user')).rejects.toMatchObject({
      message: expect.stringContaining('unable to parse'),
    });
  });

  it('reports an unreachable host', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    await expect(client(impl).get('/user')).rejects.toMatchObject({
      message: 'unable to reach Example',
      code: ExitCode.NotFound,
    });
  });

  it('lets an abort through untouched', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const impl = (async () => {
      throw abort;
    }) as unknown as typeof fetch;

    await expect(client(impl).get('/user')).rejects.toBe(abort);
  });
});

describe('ApiClient error mapping', () => {
  it('treats 401 as an auth failure', async () => {
    const { impl } = queued([json({ message: 'Bad credentials' }, { status: 401 })]);

    await expect(client(impl).get('/user')).rejects.toMatchObject({
      code: ExitCode.Auth,
      detail: expect.stringContaining('Bad credentials'),
    });
  });

  it('treats 403 as an auth failure too', async () => {
    const { impl } = queued([json({ message: 'Forbidden' }, { status: 403 })]);

    await expect(client(impl).get('/user')).rejects.toMatchObject({ code: ExitCode.Auth });
  });

  // A spent rate limit also arrives as 403, but re-authenticating will not help, so it must not be
  // reported as an auth problem.
  it('distinguishes a spent rate limit from bad credentials', async () => {
    const { impl } = queued([
      json(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
        },
      ),
    ]);

    await expect(client(impl).get('/user')).rejects.toMatchObject({
      message: 'Example rate limit exceeded',
      code: ExitCode.NotFound,
      hint: expect.stringContaining('resets at'),
    });
  });

  it('maps 404 to not found with a useful hint', async () => {
    const { impl } = queued([json({ message: 'Not Found' }, { status: 404 })]);

    await expect(client(impl).get('/orgs/nope/repos')).rejects.toMatchObject({
      message: 'Example returned 404',
      code: ExitCode.NotFound,
      hint: expect.stringContaining('owner name'),
    });
  });

  it('falls back to a generic message for other statuses', async () => {
    const { impl } = queued([json({ error: 'boom' }, { status: 500 })]);

    await expect(client(impl).get('/user')).rejects.toMatchObject({
      message: 'Example request failed (500)',
      detail: expect.stringContaining('boom'),
    });
  });

  it('copes with a non-JSON error body', async () => {
    const { impl } = queued([new Response('gateway timeout', { status: 504 })]);

    await expect(client(impl).get('/user')).rejects.toMatchObject({
      detail: expect.stringContaining('gateway timeout'),
    });
  });
});

describe('ApiClient.paginate', () => {
  it('stops on a short page', async () => {
    const { impl, urls } = queued([json(page(100)), json(page(3, 100))]);

    const items = await client(impl).paginate<{ id: number }>('/repos', { limit: 1000 });

    expect(items).toHaveLength(103);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('page=2');
  });

  it('stops on an empty page', async () => {
    const { impl, urls } = queued([json(page(100)), json([])]);

    const items = await client(impl).paginate('/repos', { limit: 1000 });

    expect(items).toHaveLength(100);
    expect(urls).toHaveLength(2);
  });

  it('never asks for more than the limit', async () => {
    const { impl, urls } = queued([json(page(5))]);

    const items = await client(impl).paginate('/repos', { limit: 5 });

    expect(items).toHaveLength(5);
    expect(urls[0]).toContain('per_page=5');
    expect(urls).toHaveLength(1);
  });

  it('trims an over-long final page down to the limit', async () => {
    const { impl } = queued([json(page(100)), json(page(100, 100))]);

    const items = await client(impl).paginate('/repos', { limit: 150 });

    expect(items).toHaveLength(150);
  });

  // All forges silently clamp per_page above 100, so asking for more would make the short-page
  // check fire on a full page and end pagination early.
  it('clamps per_page to 100', async () => {
    const { impl, urls } = queued([json(page(100)), json(page(1, 100))]);

    await client(impl).paginate('/repos', { limit: 1000, perPage: 500 });

    expect(urls[0]).toContain('per_page=100');
  });

  it('carries the caller query through to every page', async () => {
    const { impl, urls } = queued([json(page(100)), json(page(1, 100))]);

    await client(impl).paginate('/repos', { limit: 1000, query: { affiliation: 'owner' } });

    expect(urls[0]).toContain('affiliation=owner');
    expect(urls[1]).toContain('affiliation=owner');
  });

  it('returns nothing when the first page is not a list', async () => {
    const { impl } = queued([json({ message: 'weird' })]);

    await expect(client(impl).paginate('/repos', { limit: 10 })).resolves.toEqual([]);
  });
});

describe('redactUrl', () => {
  it('masks tokens passed in the query string', () => {
    expect(redactUrl('https://example.test/api?private_token=abc&page=1')).toBe(
      'https://example.test/api?private_token=REDACTED&page=1',
    );
  });

  it('masks access_token too', () => {
    expect(redactUrl('https://example.test/api?access_token=abc')).toContain('REDACTED');
  });

  it('leaves innocent URLs alone', () => {
    expect(redactUrl('https://example.test/api?page=1')).toBe('https://example.test/api?page=1');
  });

  it('returns the input when it is not a URL', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
