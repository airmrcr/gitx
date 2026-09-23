import { ExitCode, GitxError } from '../util/errors.ts';
import { GITHUB_DEFAULT_HOST, GithubProvider } from './github.ts';
import { GITLAB_DEFAULT_HOST, GitlabProvider } from './gitlab.ts';
import type { Provider, ProviderId } from './types.ts';

/**
 * Metadata and a factory for a registered provider.
 */
export interface ProviderInfo {
  /** The host this provider talks to when nothing is configured. */
  defaultHost: string;
  /** Which forge this entry registers. */
  id: ProviderId;
  /** Display name (e.g. `GitHub`). */
  label: string;

  /**
   * Builds a {@link Provider} instance for this forge.
   *
   * @param options The options to be used.
   * @returns The provider instance.
   */
  create(options: ProviderInfoCreateOptions): Provider;
}

/**
 * Options for {@link ProviderInfo.create}.
 */
export interface ProviderInfoCreateOptions {
  /** The host to use instead of the provider's default. */
  host?: string;
}

/**
 * Registered providers.
 *
 * Supporting other forges (e.g. Gitea or Bitbucket) is a matter of implementing {@link Provider}
 * and adding an entry here; no command knows the difference.
 */
export const PROVIDERS: readonly ProviderInfo[] = Object.freeze([
  {
    id: 'github',
    label: 'GitHub',
    defaultHost: GITHUB_DEFAULT_HOST,
    create: (options) => new GithubProvider(options),
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    defaultHost: GITLAB_DEFAULT_HOST,
    create: (options) => new GitlabProvider(options),
  },
]);

/** The IDs of every registered provider, in {@link PROVIDERS} order. */
export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(
  PROVIDERS.map((provider) => provider.id),
);

/**
 * Builds a {@link Provider} instance for a registered provider ID.
 *
 * @param id The provider ID to build an instance for.
 * @param [host] The host to use instead of the provider's default.
 * @returns The constructed {@link Provider}.
 * @throws GitxError If `id` is not a registered provider.
 */
export const createProvider = (id: string, host?: string): Provider => {
  const info = providerInfo(id);
  return info.create(host === undefined || host.length === 0 ? {} : { host });
};

/**
 * The host a provider talks to when nothing is configured.
 *
 * @param id The provider ID to look up.
 * @returns The provider's default host.
 * @throws GitxError If `id` is not a registered provider.
 */
export const defaultHostFor = (id: string): string => providerInfo(id).defaultHost;

/**
 * Looks up a provider by ID, without failing when it is unknown.
 *
 * @param id The provider ID to look up.
 * @returns The matching {@link ProviderInfo}, or `undefined` if `id` is not registered.
 */
export const findProvider = (id: string): ProviderInfo | undefined =>
  PROVIDERS.find((provider) => provider.id === id);

/**
 * Looks up a provider, failing with the list of valid ones when unknown.
 *
 * @param id The provider ID to look up.
 * @returns The matching {@link ProviderInfo}.
 * @throws GitxError If `id` is not a registered provider.
 */
export const providerInfo = (id: string): ProviderInfo => {
  const found = findProvider(id);
  if (found) return found;

  throw new GitxError(`unknown provider: ${id}`, {
    code: ExitCode.Config,
    hint: `Supported providers: ${PROVIDER_IDS.join(', ')}.`,
  });
};
