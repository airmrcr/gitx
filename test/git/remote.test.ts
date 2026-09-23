import { describe, expect, it } from 'vitest';
import { parseRemoteUrl } from '../../src/git/remote.ts';

describe('parseRemoteUrl', () => {
  it('reads scp-like syntax', () => {
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets',
    });
  });

  it('reads scp-like syntax without a user', () => {
    expect(parseRemoteUrl('github.com:acme/widgets')).toEqual({
      host: 'github.com',
      path: 'acme/widgets',
    });
  });

  it('reads https URLs', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      path: 'acme/widgets',
    });
  });

  // The scp-like pattern also matches `https://...`, where it would report a host of `https`.
  // Schemes therefore have to win.
  it('does not mistake a scheme for a host', () => {
    expect(parseRemoteUrl('https://gitlab.com/acme/widgets.git')?.host).toBe('gitlab.com');
  });

  it('drops credentials embedded in the URL', () => {
    expect(parseRemoteUrl('https://user:token@gitlab.com/acme/widgets.git')).toEqual({
      host: 'gitlab.com',
      path: 'acme/widgets',
    });
  });

  it('reads ssh URLs with a port', () => {
    expect(parseRemoteUrl('ssh://git@git.acme.dev:2222/acme/widgets.git')).toEqual({
      host: 'git.acme.dev',
      path: 'acme/widgets',
    });
  });

  it('keeps GitLab subgroups intact', () => {
    expect(parseRemoteUrl('git@gitlab.com:acme/team/sub/widgets.git')?.path).toBe(
      'acme/team/sub/widgets',
    );
  });

  it('lowercases the host but not the path', () => {
    expect(parseRemoteUrl('git@GitHub.COM:Acme/Widgets.git')).toEqual({
      host: 'github.com',
      path: 'Acme/Widgets',
    });
  });

  it('tolerates trailing slashes', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets/')?.path).toBe('acme/widgets');
  });

  it('ignores surrounding whitespace', () => {
    expect(parseRemoteUrl('  git@github.com:acme/widgets.git\n')?.path).toBe('acme/widgets');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['a bare path', '/srv/git/widgets.git'],
    ['a host with no path', 'git@github.com:'],
    ['a URL with no path', 'https://github.com'],
  ])('returns undefined for %s', (_label, url) => {
    expect(parseRemoteUrl(url)).toBeUndefined();
  });

  it('handles local file remotes by refusing them', () => {
    // `file:///srv/widgets.git` has no host, so there is no forge to query.
    expect(parseRemoteUrl('file:///srv/widgets.git')).toBeUndefined();
  });
});
