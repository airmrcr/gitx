import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny, matchesGlob } from '../../src/util/match.ts';

describe('matchesGlob', () => {
  it('matches exact names', () => {
    expect(matchesGlob('api', 'api')).toBe(true);
    expect(matchesGlob('api', 'apis')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesGlob('API', 'api')).toBe(true);
  });

  it('supports * as any run of characters', () => {
    expect(matchesGlob('api-gateway', 'api-*')).toBe(true);
    expect(matchesGlob('api', 'api-*')).toBe(false);
    expect(matchesGlob('anything', '*')).toBe(true);
  });

  it('supports ? as a single character', () => {
    expect(matchesGlob('api1', 'api?')).toBe(true);
    expect(matchesGlob('api12', 'api?')).toBe(false);
  });

  it('anchors the pattern at both ends', () => {
    expect(matchesGlob('my-api-thing', 'api')).toBe(false);
    expect(matchesGlob('my-api-thing', '*api*')).toBe(true);
  });

  it('treats regex metacharacters literally', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('axb', 'a.b')).toBe(false);
    expect(matchesGlob('a+b', 'a+b')).toBe(true);
    expect(matchesGlob('repo(1)', 'repo(1)')).toBe(true);
    expect(matchesGlob('a$b', 'a$b')).toBe(true);
    expect(matchesGlob('a[b]c', 'a[b]c')).toBe(true);
  });
});

describe('matchesAny', () => {
  it('returns false for an empty pattern list', () => {
    expect(matchesAny('anything', [])).toBe(false);
  });

  it('returns true when any pattern matches', () => {
    expect(matchesAny('api-gateway', ['web-*', 'api-*'])).toBe(true);
    expect(matchesAny('api-gateway', ['web-*', 'jobs-*'])).toBe(false);
  });
});

describe('globToRegExp', () => {
  it('caches compiled patterns', () => {
    expect(globToRegExp('api-*')).toBe(globToRegExp('api-*'));
  });
});
