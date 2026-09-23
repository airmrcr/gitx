import { describe, expect, it } from 'vitest';
import {
  createProvider,
  defaultHostFor,
  findProvider,
  PROVIDER_IDS,
  providerInfo,
  PROVIDERS,
} from '../../src/provider/registry.ts';
import { ExitCode } from '../../src/util/errors.ts';

describe('the provider registry', () => {
  it('registers GitHub and GitLab', () => {
    expect(PROVIDER_IDS).toEqual(['github', 'gitlab']);
  });

  it('gives every provider a label and a default host', () => {
    for (const provider of PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.defaultHost).toMatch(/\./);
    }
  });

  it('finds a provider by id', () => {
    expect(findProvider('gitlab')?.label).toBe('GitLab');
  });

  it('returns undefined for an unknown id', () => {
    expect(findProvider('bitbucket')).toBeUndefined();
  });
});

describe('providerInfo', () => {
  it('lists the valid providers when given an unknown one', () => {
    expect(() => providerInfo('bitbucket')).toThrowError(/unknown provider: bitbucket/);
    expect(() => providerInfo('bitbucket')).toThrowError(
      expect.objectContaining({
        code: ExitCode.Config,
        hint: 'Supported providers: github, gitlab.',
      }),
    );
  });
});

describe('createProvider', () => {
  it('defaults to the provider host', () => {
    expect(createProvider('github').host).toBe('github.com');
    expect(createProvider('gitlab').host).toBe('gitlab.com');
  });

  it('honours an override host', () => {
    expect(createProvider('github', 'git.acme.dev').host).toBe('git.acme.dev');
  });

  it('treats an empty host as unset', () => {
    expect(createProvider('gitlab', '').host).toBe('gitlab.com');
  });

  it('gives each provider its own word for a CI run', () => {
    expect(createProvider('github').runNoun).toBe('workflow run');
    expect(createProvider('gitlab').runNoun).toBe('pipeline');
  });
});

describe('defaultHostFor', () => {
  it('reports the default host without building a provider', () => {
    expect(defaultHostFor('github')).toBe('github.com');
    expect(defaultHostFor('gitlab')).toBe('gitlab.com');
  });
});
