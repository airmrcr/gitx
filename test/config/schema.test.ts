import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  displayKey,
  displayName,
  findKeyDef,
  resolveConcurrency,
  validateValue,
} from '../../src/config/schema.ts';
import { GitxError } from '../../src/util/errors.ts';

describe('findKeyDef', () => {
  it('finds an exact key regardless of casing', () => {
    expect(findKeyDef('core.baseDir')?.display).toBe('core.baseDir');
    expect(findKeyDef('CORE.BASEDIR')?.display).toBe('core.baseDir');
  });

  it('collapses a repo-scoped key onto its base definition, when that key allows it', () => {
    expect(findKeyDef('core.my-repo.editor')?.key).toBe('core.editor');
    expect(findKeyDef('update.my-repo.tidy')?.key).toBe('update.tidy');
    expect(findKeyDef('install.my-repo.npmfrozen')?.key).toBe('install.npmfrozen');
  });

  it('collapses any alias name onto the alias wildcard', () => {
    expect(findKeyDef('alias.up')?.key).toBe('alias.*');
    expect(findKeyDef('alias.WHATEVER')?.key).toBe('alias.*');
  });

  it('does not invent a wildcard for sections that have none', () => {
    expect(findKeyDef('core.nonsense')).toBeUndefined();
    expect(findKeyDef('alias.too.deep')).toBeUndefined();
  });

  it('refuses to scope a key that has not opted in', () => {
    expect(findKeyDef('remote.my-repo.owner')).toBeUndefined();
    expect(findKeyDef('install.my-repo.npmargs')).toBeUndefined();
  });

  it('returns undefined for unknown keys', () => {
    expect(findKeyDef('core.nope')).toBeUndefined();
    expect(findKeyDef('bogus.key')).toBeUndefined();
  });
});

describe('displayKey', () => {
  it('uses the documented casing', () => {
    expect(displayKey('core.basedir')).toBe('core.baseDir');
  });

  it('preserves the repo name for a repo-scoped key, documenting the rest', () => {
    expect(displayKey('core.my-repo.editor')).toBe('core.my-repo.editor');
    expect(displayKey('core.My-Repo.editor')).toBe('core.My-Repo.editor');
  });

  it('keeps the alias name the user chose', () => {
    expect(displayKey('alias.up')).toBe('alias.up');
    expect(displayKey('alias.shipit')).toBe('alias.shipit');
  });

  it('passes unknown keys through unchanged', () => {
    expect(displayKey('weird.key')).toBe('weird.key');
  });
});

describe('displayName', () => {
  it('returns the final segment', () => {
    expect(displayName('core.basedir')).toBe('baseDir');
    expect(displayName('core.my-repo.editor')).toBe('editor');
  });
});

describe('resolveConcurrency', () => {
  it('defaults to the available parallelism', () => {
    expect(resolveConcurrency(undefined)).toBe(availableParallelism());
    expect(resolveConcurrency('auto')).toBe(availableParallelism());
  });

  it('treats 0 and `unlimited` as no limit', () => {
    expect(resolveConcurrency('0')).toBe(Number.POSITIVE_INFINITY);
    expect(resolveConcurrency('unlimited')).toBe(Number.POSITIVE_INFINITY);
  });

  it('accepts explicit counts', () => {
    expect(resolveConcurrency('6')).toBe(6);
  });

  it('rejects negatives and nonsense', () => {
    expect(() => resolveConcurrency('-1')).toThrow(GitxError);
    expect(() => resolveConcurrency('lots')).toThrow(GitxError);
  });
});

describe('validateValue', () => {
  it('normalises booleans', () => {
    expect(validateValue('install.frozen', 'YES')).toBe('true');
    expect(validateValue('install.frozen', 'off')).toBe('false');
  });

  it('normalises enum casing', () => {
    expect(validateValue('core.layout', 'FLAT')).toBe('flat');
  });

  it('rejects out-of-range enums', () => {
    expect(() => validateValue('core.color', 'rainbow')).toThrow(GitxError);
  });

  it('leaves paths and strings untouched', () => {
    expect(validateValue('core.baseDir', '~/Dev/Repos')).toBe('~/Dev/Repos');
    expect(validateValue('remote.owner', 'AcmeCorp')).toBe('AcmeCorp');
  });

  it('passes unknown keys through', () => {
    expect(validateValue('made.up.key', 'whatever')).toBe('whatever');
  });
});

describe('CONFIG_KEYS', () => {
  it('has unique canonical keys', () => {
    const keys = CONFIG_KEYS.map((def) => def.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses lower-case canonical keys that match their display form', () => {
    for (const def of CONFIG_KEYS) {
      expect(def.key).toBe(def.key.toLowerCase());
      // `<manager>`, `<name>` and friends stand in for the canonical `*`.
      expect(def.display.toLowerCase().replaceAll(/<[^>]+>/g, '*')).toBe(def.key);
    }
  });

  it('gives every enum key a valid default', () => {
    const enums = CONFIG_KEYS.filter((def) => def.type === 'enum' && def.fallback !== undefined);
    expect(enums.every((def) => def.values?.includes(def.fallback as string))).toBe(true);
  });

  it('describes every key', () => {
    for (const def of CONFIG_KEYS) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it('prompts for the values that cannot be worked out from the repository', () => {
    const prompted = CONFIG_KEYS.filter((def) => def.prompt !== undefined);
    expect(prompted.map((def) => def.key)).toEqual([
      'core.basedir',
      'core.editor',
      'remote.provider',
      'remote.owner',
      'remote.protocol',
    ]);
  });

  // A prompt with a fallback is one `--no-input` can answer by itself. Only the three that are
  // genuinely personal -- or have no neutral default at all -- stop an unattended run.
  it('only stops an unattended run for the values a default would get wrong', () => {
    const fatal = CONFIG_KEYS.filter(
      (def) => def.prompt !== undefined && def.fallback === undefined,
    );
    expect(fatal.map((def) => def.key)).toEqual(['core.basedir', 'core.editor', 'remote.owner']);
  });
});
