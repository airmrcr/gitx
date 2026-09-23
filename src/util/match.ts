const cache = new Map<string, RegExp>();

/**
 * Compiles a glob pattern into a case-insensitive {@link RegExp}.
 *
 * Deliberately not path-aware: patterns are matched against a single repository name or path
 * fragment.
 *
 * @param pattern The glob pattern, supporting `*` and `?`.
 * @returns A regular expression that matches a whole value against `pattern`.
 */
export const globToRegExp = (pattern: string): RegExp => {
  const cached = cache.get(pattern);
  if (cached) return cached;

  const source = pattern
    .replaceAll(/[$()+.[\\\]^{|}]/g, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.');

  const regexp = new RegExp(`^${source}$`, 'i');
  cache.set(pattern, regexp);
  return regexp;
};

/**
 * Checks whether `value` matches any of the specified glob patterns. An empty list never matches.
 *
 * @param value The value to test, e.g. a repository name.
 * @param patterns The glob patterns to test against, each supporting `*` and `?`.
 * @returns `true` if `value` matches at least one pattern in `patterns`; otherwise `false`.
 */
export const matchesAny = (value: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => matchesGlob(value, pattern));

/**
 * Checks whether `value` matches the specified glob pattern.
 *
 * @param value The value to test, e.g. a repository name.
 * @param pattern The glob pattern, supporting `*` and `?`.
 * @returns `true` if `value` matches `pattern`; otherwise `false`.
 */
export const matchesGlob = (value: string, pattern: string): boolean =>
  globToRegExp(pattern).test(value);
