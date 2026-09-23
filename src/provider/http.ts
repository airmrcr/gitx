import { ExitCode, GitxError } from '../util/errors.ts';

const extractMessage = (body: string): string => {
  if (body.trim().length === 0) return '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'string') return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      // GitHub uses `message`; GitLab uses `message` or `error`.
      for (const key of ['message', 'error', 'error_description']) {
        const value = record[key];
        if (typeof value === 'string') return value;
      }
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.slice(0, 200);
};

const resetHint = (response: Response): string => {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(reset) || reset <= 0) return '';
  const when = new Date(reset * 1000);
  return ` (resets at ${when.toLocaleTimeString()})`;
};

/**
 * Options for constructing an {@link ApiClient}.
 */
export interface ApiClientOptions {
  /** Absolute API base (e.g. `https://api.github.com` or `https://gitlab.com/api/v4`). */
  baseUrl: string;
  /** Overrides the `fetch` implementation used, mainly for tests. */
  fetchImpl?: typeof fetch;
  /** Headers sent with every request, typically authentication. */
  headers: Readonly<Record<string, string>>;
  /** Provider display name, used in error messages. */
  label: string;
}

/**
 * Options for {@link ApiClient.paginate}.
 */
export interface ApiClientPaginateOptions extends ApiClientRequestOptions {
  /** Stop once this many items have been collected. */
  limit: number;
  /** Items per request; all platforms cap this at 100. */
  perPage?: number;
}

/**
 * Options for a single request via {@link ApiClient}.
 */
export interface ApiClientRequestOptions {
  /** Query-string parameters; `undefined` values are omitted. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Aborted to cancel the request. */
  signal?: AbortSignal | undefined;
  /** Treat these statuses as `undefined` rather than an error. */
  tolerate?: readonly number[];
}

/** The maximum items a single page request may ask for. */
export const MAX_PER_PAGE = 100;

/**
 * A small REST client shared by the provider adaptors, handling auth, JSON decoding and pagination.
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #label: string;

  /**
   * Creates a new {@link ApiClient} instance with the specified `options`.
   *
   * @param options The options to be used.
   */
  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#headers = options.headers;
    this.#label = options.label;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * One request, decoded as JSON. Returns `undefined` for tolerated statuses.
   *
   * @param path An absolute URL, or a path relative to the client's base URL.
   * @param [options] The options to be used.
   * @returns The decoded JSON body, or `undefined` if the body was empty or the status was
   * tolerated.
   * @throws GitxError If the request fails, the response is not OK, or the body cannot be parsed as
   * JSON.
   */
  async get<T>(path: string, options: ApiClientRequestOptions = {}): Promise<T | undefined> {
    const { body } = await this.#request(path, options);
    return body as T | undefined;
  }

  /**
   * Follows pages until `limit` items are collected or the results run out.
   *
   * Uses plain page numbers, which both platforms support and which stay correct up to far more
   * repositories than anyone clones onto one laptop.
   *
   * @param path An absolute URL, or a path relative to the client's base URL.
   * @param options The options to be used.
   * @returns Up to {@link ApiClientPaginateOptions.limit} collected items.
   */
  async paginate<T>(path: string, options: ApiClientPaginateOptions): Promise<T[]> {
    const perPage = Math.min(options.perPage ?? MAX_PER_PAGE, MAX_PER_PAGE);
    const collected: T[] = [];

    for (let page = 1; collected.length < options.limit; page += 1) {
      const remaining = options.limit - collected.length;
      const items = await this.get<T[]>(path, {
        ...options,
        query: {
          ...options.query,
          per_page: Math.min(perPage, remaining),
          page,
        },
      });

      if (!Array.isArray(items) || items.length === 0) break;
      collected.push(...items);
      // A short page is the last page, on all platforms.
      if (items.length < Math.min(perPage, remaining)) break;
    }

    return collected.slice(0, options.limit);
  }

  async #httpError(response: Response, url: string): Promise<GitxError> {
    const body = await response.text().catch(() => '');
    const detail = [redactUrl(url), extractMessage(body)].filter(Boolean).join('\n');

    if (response.status === 401 || response.status === 403) {
      const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
      return new GitxError(
        rateLimited
          ? `${this.#label} rate limit exceeded`
          : `${this.#label} rejected the credentials (${response.status})`,
        {
          code: rateLimited ? ExitCode.NotFound : ExitCode.Auth,
          detail,
          hint: rateLimited
            ? `Wait for the limit to reset${resetHint(response)}.`
            : 'The token may be expired or missing a scope. See `gitx auth status`.',
        },
      );
    }

    if (response.status === 404) {
      return new GitxError(`${this.#label} returned 404`, {
        code: ExitCode.NotFound,
        detail,
        hint: 'Check the owner name, and that your token can see it.',
      });
    }

    return new GitxError(`${this.#label} request failed (${response.status})`, {
      code: ExitCode.NotFound,
      detail,
    });
  }

  async #request(
    path: string,
    options: ApiClientRequestOptions,
  ): Promise<{ body: unknown; response: Response | undefined }> {
    const url = this.#url(path, options.query);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { ...this.#headers },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // An abort is the runner cancelling us, not a failure worth dressing up.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new GitxError(`unable to reach ${this.#label}`, {
        code: ExitCode.NotFound,
        cause: error,
        detail: redactUrl(url),
        hint: 'Check your network connection and the configured host.',
      });
    }

    if (options.tolerate?.includes(response.status)) {
      return { body: undefined, response: undefined };
    }

    if (!response.ok) throw await this.#httpError(response, url);

    const text = await response.text();
    if (text.trim().length === 0) return { body: undefined, response };

    try {
      return { body: JSON.parse(text), response };
    } catch (error) {
      throw new GitxError(`unable to parse the ${this.#label} response`, {
        code: ExitCode.Usage,
        cause: error,
        detail: text.slice(0, 300),
      });
    }
  }

  #url(path: string, query: ApiClientRequestOptions['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

/**
 * Strips any query string that might carry a token.
 *
 * @param url The URL to redact.
 * @returns `url` with any token-bearing query parameters replaced with `REDACTED`.
 */
export const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    for (const key of ['private_token', 'access_token']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return url;
  }
};
