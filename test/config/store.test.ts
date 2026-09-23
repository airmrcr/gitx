import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, defaultConfigPath, expandHome } from '../../src/config/store.ts';
import { GitxError } from '../../src/util/errors.ts';

const temporaryDirs: string[] = [];

const temporaryConfig = async (contents = '') => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-config-'));
  temporaryDirs.push(dir);
  const file = path.join(dir, '.gitxconfig');
  if (contents) await writeFile(file, contents, 'utf8');
  return file;
};

afterEach(() => {
  temporaryDirs.length = 0;
});

describe('Config.load', () => {
  it('treats a missing file as empty', async () => {
    const config = await Config.load(path.join(tmpdir(), 'gitx-does-not-exist', 'nope'));
    expect(config.list()).toEqual([]);
  });

  it('reads an existing file', async () => {
    const file = await temporaryConfig('[core]\n\tbaseDir = /tmp/dev\n');
    const config = await Config.load(file);
    expect(config.get('core.baseDir')).toBe('/tmp/dev');
  });

  it('raises a helpful error for a malformed file', async () => {
    const file = await temporaryConfig('[core\n');
    await expect(Config.load(file)).rejects.toThrow(GitxError);
  });
});

describe('Config get', () => {
  it('is case-insensitive for sections and keys', () => {
    const config = Config.parse('[CORE]\n\tBASEDIR = /x\n');
    expect(config.get('core.baseDir')).toBe('/x');
    expect(config.get('CoRe.BaseDir')).toBe('/x');
  });

  it('is case-sensitive for subsections', () => {
    const config = Config.parse('[install "npm"]\n\tfrozen = false\n');
    expect(config.getRaw('install.npm.frozen')).toBe('false');
    expect(config.getRaw('install.NPM.frozen')).toBeUndefined();
  });

  it('returns the last value when a key repeats', () => {
    const config = Config.parse('[core]\n\tlayout = nested\n\tlayout = flat\n');
    expect(config.getRaw('core.layout')).toBe('flat');
    expect(config.getAll('core.layout')).toEqual(['nested', 'flat']);
  });

  it('falls back to the schema default', () => {
    const config = Config.parse('');
    expect(config.get('core.layout')).toBe('nested');
    expect(config.getRaw('core.layout')).toBeUndefined();
  });

  it('returns undefined for keys with no value and no default', () => {
    expect(Config.parse('').get('core.baseDir')).toBeUndefined();
  });
});

describe('Config typed accessors', () => {
  it('parses booleans in every accepted spelling', () => {
    for (const value of ['true', 'yes', 'on', '1']) {
      expect(Config.parse(`[update]\n\ttidy = ${value}\n`).getBoolean('update.tidy')).toBe(true);
    }
    for (const value of ['false', 'no', 'off', '0']) {
      expect(Config.parse(`[update]\n\ttidy = ${value}\n`).getBoolean('update.tidy')).toBe(false);
    }
  });

  it('rejects nonsense booleans', () => {
    expect(() => Config.parse('[update]\n\ttidy = maybe\n').getBoolean('update.tidy')).toThrow(
      GitxError,
    );
  });

  it('parses numbers', () => {
    expect(Config.parse('[runs]\n\tlimit = 25\n').getNumber('runs.limit')).toBe(25);
    expect(Config.parse('').getNumber('runs.limit')).toBe(10);
  });

  it('resolves concurrency, treating 0 as unlimited', () => {
    expect(Config.parse('[core]\n\tconcurrency = 4\n').getConcurrency()).toBe(4);
    expect(Config.parse('[core]\n\tconcurrency = 0\n').getConcurrency()).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(Config.parse('[core]\n\tconcurrency = unlimited\n').getConcurrency()).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(Config.parse('').getConcurrency()).toBeGreaterThan(0);
  });
});

describe('Config.getList', () => {
  it('returns every value', () => {
    const config = Config.parse('[skip]\n\tinstall = a\n\tinstall = b\n');
    expect(config.getList('skip.install')).toEqual(['a', 'b']);
  });

  it('returns an empty list when unset with no default', () => {
    expect(Config.parse('').getList('skip.install')).toEqual([]);
  });

  it('uses the default only when the key is entirely absent', () => {
    expect(Config.parse('').getList('update.ignoreDirty')).toEqual(['.idea/']);
    expect(
      Config.parse('[update]\n\tignoreDirty = .vscode/\n').getList('update.ignoreDirty'),
    ).toEqual(['.vscode/']);
  });
});

describe('Config.getForRepo', () => {
  it('prefers a repo-scoped override', () => {
    const config = Config.parse('[core]\n\teditor = code\n[core "my-repo"]\n\teditor = idea\n');
    expect(config.getForRepo('core', 'my-repo', 'editor')).toBe('idea');
    expect(config.getForRepo('core', 'other-repo', 'editor')).toBe('code');
  });

  it('falls back to the plain key when no repo is given', () => {
    const config = Config.parse('[core]\n\teditor = code\n');
    expect(config.getForRepo('core', undefined, 'editor')).toBe('code');
  });

  it('falls back to the schema default when nothing is configured', () => {
    expect(Config.parse('').getForRepo('update', 'my-repo', 'tidy')).toBe('true');
  });
});

describe('Config.getForRepoBoolean', () => {
  it('parses the resolved value as a boolean', () => {
    const config = Config.parse('[update "my-repo"]\n\ttidy = false\n');
    expect(config.getForRepoBoolean('update', 'my-repo', 'tidy')).toBe(false);
    expect(config.getForRepoBoolean('update', 'other-repo', 'tidy')).toBe(true);
  });
});

describe('Config.getInstallBoolean', () => {
  it('prefers the per-manager override', () => {
    const config = Config.parse('[install]\n\tfrozen = true\n\tnpmFrozen = false\n');
    expect(config.getInstallBoolean('frozen', 'npm')).toBe(false);
    expect(config.getInstallBoolean('frozen', 'pnpm')).toBe(true);
  });

  it('falls back to the generic key', () => {
    const config = Config.parse('[install]\n\trestoreLockfile = false\n');
    expect(config.getInstallBoolean('restorelockfile', 'yarn')).toBe(false);
  });

  it('falls back to the schema default when nothing is configured', () => {
    const config = Config.parse('');
    expect(config.getInstallBoolean('restorelockfile', 'npm')).toBe(true);
    expect(config.getInstallBoolean('frozen', 'npm')).toBe(true);
  });

  // Regression: `install.<manager>enabled` has no plain-key form, so an earlier implementation
  // resolved it to false and disabled every install.
  it('defaults manager-only keys to their own default', () => {
    const config = Config.parse('');
    expect(config.getInstallBoolean('enabled', 'npm')).toBe(true);
    expect(config.getInstallBoolean('enabled', 'pnpm')).toBe(true);
  });

  it('still honours an explicit manager disable', () => {
    const config = Config.parse('[install]\n\tyarnEnabled = false\n');
    expect(config.getInstallBoolean('enabled', 'yarn')).toBe(false);
    expect(config.getInstallBoolean('enabled', 'npm')).toBe(true);
  });

  // The subsection is reserved for the repository, not the manager, so a repo override takes
  // priority over both the manager and plain settings.
  it('prefers a repo-scoped override over the manager and plain settings', () => {
    const config = Config.parse(
      '[install]\n\tfrozen = true\n\tyarnFrozen = true\n[install "my-repo"]\n\tyarnFrozen = false\n',
    );
    expect(config.getInstallBoolean('frozen', 'yarn', 'my-repo')).toBe(false);
    expect(config.getInstallBoolean('frozen', 'yarn', 'other-repo')).toBe(true);
    expect(config.getInstallBoolean('frozen', 'yarn')).toBe(true);
  });
});

describe('Config.set', () => {
  it('replaces an existing value in place', () => {
    const config = Config.parse('[core]\n\tlayout = nested\n[remote]\n\towner = acme\n');
    config.set('core.layout', 'flat');
    expect(config.getAll('core.layout')).toEqual(['flat']);
    expect(config.get('remote.owner')).toBe('acme');
  });

  it('collapses a multi-valued key down to one value', () => {
    const config = Config.parse('[skip]\n\tinstall = a\n\tinstall = b\n');
    config.set('skip.install', 'c');
    expect(config.getAll('skip.install')).toEqual(['c']);
  });

  it('validates the value against the schema', () => {
    const config = Config.parse('');
    expect(() => config.set('core.layout', 'sideways')).toThrow(GitxError);
    expect(() => config.set('install.frozen', 'perhaps')).toThrow(GitxError);
  });

  it('normalises booleans and enum casing', () => {
    const config = Config.parse('');
    config.set('install.frozen', 'YES');
    config.set('core.layout', 'FLAT');
    expect(config.getRaw('install.frozen')).toBe('true');
    expect(config.getRaw('core.layout')).toBe('flat');
  });

  it('writes keys using their documented casing', () => {
    const config = Config.parse('');
    config.set('core.basedir', '/x');
    config.set('install.npmrestorelockfile', 'false');
    config.set('core.my-repo.editor', 'idea');
    expect(config.toString()).toContain('baseDir = /x');
    expect(config.toString()).toContain('npmRestoreLockfile = false');
    expect(config.toString()).toContain('[core "my-repo"]');
    expect(config.toString()).toContain('editor = idea');
  });
});

describe('Config.add', () => {
  it('appends rather than replacing', () => {
    const config = Config.parse('[skip]\n\tinstall = a\n');
    config.add('skip.install', 'b');
    expect(config.getAll('skip.install')).toEqual(['a', 'b']);
  });
});

describe('Config.unset', () => {
  it('removes a single-valued key', () => {
    const config = Config.parse('[core]\n\tlayout = flat\n');
    expect(config.unset('core.layout')).toBe(1);
    expect(config.getRaw('core.layout')).toBeUndefined();
  });

  it('refuses to remove a multi-valued key without --all', () => {
    const config = Config.parse('[skip]\n\tinstall = a\n\tinstall = b\n');
    expect(() => config.unset('skip.install')).toThrow(GitxError);
    expect(config.getAll('skip.install')).toEqual(['a', 'b']);
  });

  it('removes every value with --all', () => {
    const config = Config.parse('[skip]\n\tinstall = a\n\tinstall = b\n');
    expect(config.unset('skip.install', { all: true })).toBe(2);
    expect(config.getAll('skip.install')).toEqual([]);
  });

  it('reports zero when the key is absent', () => {
    expect(Config.parse('').unset('core.layout')).toBe(0);
  });
});

describe('Config.save', () => {
  it('round-trips through the filesystem', async () => {
    const file = await temporaryConfig();
    const config = await Config.load(file);

    config.set('core.baseDir', '/tmp/dev');
    config.set('remote.owner', 'acme');
    config.add('skip.install', 'one');
    config.add('skip.install', 'two');
    await config.save();

    const reloaded = await Config.load(file);
    expect(reloaded.get('core.baseDir')).toBe('/tmp/dev');
    expect(reloaded.getAll('skip.install')).toEqual(['one', 'two']);
    expect(reloaded.dirty).toBe(false);
  });

  it('writes a private file', async () => {
    const file = await temporaryConfig();
    const config = await Config.load(file);
    config.set('remote.owner', 'acme');
    await config.save();

    expect(await readFile(file, 'utf8')).toContain('owner = acme');
  });
});

describe('expandHome', () => {
  it('expands a leading tilde', () => {
    expect(expandHome('~/dev')).not.toContain('~');
    expect(expandHome('~/dev').endsWith(path.join('dev'))).toBe(true);
  });

  it('leaves a tilde in the middle alone', () => {
    expect(expandHome('/a/~/b')).toBe('/a/~/b');
  });

  it('expands environment variables', () => {
    expect(expandHome('$FOO/bar', { FOO: '/x' })).toBe('/x/bar');
    expect(expandHome('${FOO}/bar', { FOO: '/x' })).toBe('/x/bar');
  });

  it('leaves unknown variables untouched', () => {
    expect(expandHome('$NOPE/bar', {})).toBe('$NOPE/bar');
  });
});

describe('defaultConfigPath', () => {
  it('honours GITX_CONFIG', () => {
    expect(defaultConfigPath({ GITX_CONFIG: '/tmp/custom' })).toBe('/tmp/custom');
  });

  it('defaults to ~/.gitxconfig', () => {
    expect(defaultConfigPath({})).toMatch(/\.gitxconfig$/);
  });
});
