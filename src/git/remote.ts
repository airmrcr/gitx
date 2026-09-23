const build = (host: string | undefined, path: string | undefined): RemoteRef | undefined => {
  if (!host || !path) return undefined;

  const cleaned = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');

  if (cleaned.length === 0) return undefined;
  return { host: host.toLowerCase(), path: cleaned };
};

/**
 * A parsed git remote URL.
 */
export interface RemoteRef {
  /** The remote's host, lowercased. */
  host: string;
  /** Namespace path with no leading slash or `.git` suffix (e.g. `acme/widgets`). */
  path: string;
}

/**
 * Understands the three forms git accepts:
 *
 * - scp-like: `git@github.com:acme/widgets.git`
 * - ssh URL: `ssh://git@github.com:2222/acme/widgets.git`
 * - http URL: `https://user@gitlab.com/acme/team/widgets.git`
 *
 * @param url The remote URL to parse.
 * @returns The parsed host and path, or `undefined` if `url` does not match a recognised form.
 */
export const parseRemoteUrl = (url: string): RemoteRef | undefined => {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  // Anything carrying a scheme is a real URL. Checked first because `https://host/path` also
  // satisfies the scp-like shape, where it would be read as host `https`.
  if (/^[a-z][\w+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return build(parsed.hostname, parsed.pathname);
    } catch {
      return undefined;
    }
  }

  const scpLike = /^(?:[^@/]+@)?(?<host>[^:/]+):(?<path>.+)$/.exec(trimmed);
  if (scpLike?.groups) return build(scpLike.groups['host'], scpLike.groups['path']);

  return undefined;
};
