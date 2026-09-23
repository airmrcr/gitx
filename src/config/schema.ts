import { availableParallelism } from 'node:os';
import { ExitCode, GitxError } from '../util/errors.ts';
import { splitKey } from './ini.ts';

// Settings that override an `install.*` default for one package manager.
//
// The manager is folded into the key name (`install.npmFrozen`) rather than a subsection: the
// subsection is reserved for the repository override instead (`[install "my-repo"]`), so the two
// never compete for the same slot.
interface InstallManagerSetting {
  // Lower-case suffix appended to the manager name for the canonical key.
  suffix: string;
  // Capitalised suffix appended to the manager name for the display form.
  display: string;
  type: ConfigType;
  fallback?: string | undefined;
  multiple?: boolean | undefined;
  repoScopable?: boolean | undefined;
  description: string;
}

const FALSY = new Set(['false', 'no', 'off', '0', '']);
const TRUTHY = new Set(['true', 'yes', 'on', '1']);

const INSTALL_MANAGER_SETTINGS: readonly InstallManagerSetting[] = [
  {
    suffix: 'restorelockfile',
    display: 'RestoreLockfile',
    type: 'boolean',
    repoScopable: true,
    description: 'Per-package-manager override of install.restoreLockfile.',
  },
  {
    suffix: 'frozen',
    display: 'Frozen',
    type: 'boolean',
    repoScopable: true,
    description: 'Per-package-manager override of install.frozen.',
  },
  {
    suffix: 'enabled',
    display: 'Enabled',
    type: 'boolean',
    fallback: 'true',
    repoScopable: true,
    description: 'Disable a package manager entirely.',
  },
  {
    suffix: 'args',
    display: 'Args',
    type: 'string',
    multiple: true,
    description: 'Extra arguments appended to the install command for a package manager.',
  },
];

/** Describes a single recognised config key: its type, default, and validation rules. */
export interface ConfigKeyDef {
  /** Human-readable explanation shown in `gitx config` help output. */
  description: string;
  /** Human-friendly casing used when writing the key back out. */
  display: string;
  /** Default applied when the key is absent. */
  fallback?: string | undefined;
  /** Canonical dotted key, lower-cased. `alias.*` uses `*` as a placeholder. */
  key: string;
  /** When true the key may be repeated to build a list. */
  multiple?: boolean | undefined;
  /** When set, the key is prompted for if missing, using this message and placeholder. */
  prompt?: { message: string; placeholder?: string } | undefined;
  /**
   * When true, `section.<repo>.name` (a subsection) overrides this key for one repository (e.g.
   * `core.editor` -> `[core "my-repo"]\n\teditor = ...`).
   */
  repoScopable?: boolean | undefined;
  /** The kind of value this key holds. */
  type: ConfigType;
  /** Permitted values for `enum` keys. */
  values?: readonly string[] | undefined;
}

/**
 * The kind of value a {@link ConfigKeyDef} holds, controlling parsing and validation.
 */
export type ConfigType = 'string' | 'path' | 'boolean' | 'number' | 'enum' | 'concurrency';

/**
 * One of the {@link PACKAGE_MANAGERS}.
 */
export type PackageManagerId = (typeof PACKAGE_MANAGERS)[number];

/** Package manager identifiers that may prefix a flattened `install.*` key. */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;

const INSTALL_MANAGER_KEYS: ConfigKeyDef[] = PACKAGE_MANAGERS.flatMap((manager) =>
  INSTALL_MANAGER_SETTINGS.map((setting) => ({
    key: `install.${manager}${setting.suffix}`,
    display: `install.${manager}${setting.display}`,
    type: setting.type,
    description: setting.description,
    fallback: setting.fallback,
    multiple: setting.multiple,
    repoScopable: setting.repoScopable,
  })),
);

/** Every recognised config key, in the order shown by `gitx config list --all`. */
export const CONFIG_KEYS: readonly ConfigKeyDef[] = [
  {
    key: 'core.basedir',
    display: 'core.baseDir',
    type: 'path',
    description: 'Directory that all repositories are cloned beneath.',
    prompt: {
      message: 'Where should gitx keep your repositories?',
      placeholder: '~',
    },
  },
  {
    key: 'core.layout',
    display: 'core.layout',
    type: 'enum',
    values: ['nested', 'flat'],
    fallback: 'nested',
    description:
      'Whether repositories live at <baseDir>/<owner>/<repo> (nested) or <baseDir>/<repo> (flat).',
  },
  {
    key: 'core.concurrency',
    display: 'core.concurrency',
    type: 'concurrency',
    fallback: 'auto',
    description:
      'Maximum number of repositories operated on in parallel. `auto` uses the available CPU parallelism, `0` means unlimited.',
  },
  {
    key: 'core.color',
    display: 'core.color',
    type: 'enum',
    values: ['auto', 'always', 'never'],
    fallback: 'auto',
    description: 'When to emit ANSI colour.',
  },
  {
    key: 'core.outputlines',
    display: 'core.outputLines',
    type: 'number',
    fallback: '1',
    description: 'How many trailing output lines to show per in-flight task.',
  },
  {
    key: 'core.editor',
    display: 'core.editor',
    type: 'string',
    description:
      'Command used to open a repository, e.g. `code`, `idea`, `subl -n` or `vim`. The repository path is appended as its final argument.',
    prompt: {
      message: 'Which command should gitx use to open a repository?',
      placeholder: 'code',
    },
    repoScopable: true,
  },

  {
    key: 'remote.provider',
    display: 'remote.provider',
    type: 'enum',
    values: ['github', 'gitlab'],
    fallback: 'github',
    description: 'Which forge repositories are hosted on.',
    prompt: {
      message: 'Which provider hosts your repositories?',
      placeholder: 'github',
    },
  },
  {
    key: 'remote.owner',
    display: 'remote.owner',
    type: 'string',
    description:
      'Organisation, group or user that repositories are cloned from. A GitLab group may be nested, e.g. `acme/platform`.',
    prompt: {
      message: 'Which organisation, group or user owns your repositories?',
      placeholder: 'my-org',
    },
  },
  {
    key: 'remote.user',
    display: 'remote.user',
    type: 'string',
    description: 'Login used to filter CI runs to your own. Defaults to the authenticated account.',
  },
  {
    key: 'remote.protocol',
    display: 'remote.protocol',
    type: 'enum',
    values: ['https', 'ssh'],
    fallback: 'https',
    description: 'Which clone URL to use.',
    prompt: {
      message: 'Which protocol should gitx clone with?',
      placeholder: 'https',
    },
  },
  {
    key: 'remote.visibility',
    display: 'remote.visibility',
    type: 'enum',
    values: ['all', 'public', 'private', 'internal'],
    fallback: 'all',
    description: 'Visibility filter applied when listing repositories.',
  },
  {
    key: 'remote.limit',
    display: 'remote.limit',
    type: 'number',
    fallback: '1000',
    description: 'Maximum number of repositories to list.',
  },
  {
    key: 'remote.includearchived',
    display: 'remote.includeArchived',
    type: 'boolean',
    fallback: 'false',
    description: 'Include archived repositories when listing.',
  },

  {
    key: 'github.host',
    display: 'github.host',
    type: 'string',
    fallback: 'github.com',
    description: 'GitHub host to talk to. Set this for GitHub Enterprise Server.',
  },
  {
    key: 'gitlab.host',
    display: 'gitlab.host',
    type: 'string',
    fallback: 'gitlab.com',
    description: 'GitLab host to talk to. Set this for a self-managed GitLab.',
  },

  {
    key: 'clone.install',
    display: 'clone.install',
    type: 'boolean',
    fallback: 'false',
    description: 'Install dependencies after cloning.',
  },

  {
    key: 'update.install',
    display: 'update.install',
    type: 'boolean',
    fallback: 'false',
    description: 'Install dependencies after updating.',
  },
  {
    key: 'update.clean',
    display: 'update.clean',
    type: 'boolean',
    fallback: 'false',
    description: 'Prefer clean installs (npm ci and friends) when updating.',
  },
  {
    key: 'update.force',
    display: 'update.force',
    type: 'boolean',
    fallback: 'false',
    description: 'Install dependencies even when the repository was already up to date.',
  },
  {
    key: 'update.tidy',
    display: 'update.tidy',
    type: 'boolean',
    fallback: 'true',
    description: 'Delete local branches whose upstream has gone after pulling.',
    repoScopable: true,
  },
  {
    key: 'update.submodules',
    display: 'update.submodules',
    type: 'boolean',
    fallback: 'true',
    description: 'Update git submodules as part of an update.',
    repoScopable: true,
  },
  {
    key: 'update.prune',
    display: 'update.prune',
    type: 'boolean',
    fallback: 'true',
    description: 'Pass --prune when fetching.',
  },
  {
    key: 'update.ignoredirty',
    display: 'update.ignoreDirty',
    type: 'string',
    multiple: true,
    fallback: '.idea/',
    description:
      'Paths that should not mark a repository as dirty. Repeat the key to ignore several paths.',
  },

  {
    key: 'install.restorelockfile',
    display: 'install.restoreLockfile',
    type: 'boolean',
    fallback: 'true',
    description:
      'Restore the lock file after installing so that a sync never leaves a repository dirty.',
  },
  {
    key: 'install.frozen',
    display: 'install.frozen',
    type: 'boolean',
    fallback: 'true',
    description: 'Use frozen/immutable installs when a lock file is present.',
  },
  {
    key: 'install.frozenfallback',
    display: 'install.frozenFallback',
    type: 'boolean',
    fallback: 'true',
    description:
      'Retry with a regular install when a frozen install fails because the lock file is stale.',
  },
  {
    key: 'install.volta',
    display: 'install.volta',
    type: 'enum',
    values: ['auto', 'always', 'never'],
    fallback: 'auto',
    description:
      'How to interact with Volta. `auto` relies on Volta shims if installed, `always` wraps commands in `volta run`, `never` bypasses Volta entirely.',
  },
  ...INSTALL_MANAGER_KEYS,

  {
    key: 'skip.install',
    display: 'skip.install',
    type: 'string',
    multiple: true,
    description:
      'Repositories that should never have dependencies installed. Supports `*` and `?` glob wildcards.',
  },
  {
    key: 'skip.update',
    display: 'skip.update',
    type: 'string',
    multiple: true,
    description: 'Repositories that should never be updated. Supports `*` and `?` glob wildcards.',
  },

  {
    key: 'runs.limit',
    display: 'runs.limit',
    type: 'number',
    fallback: '10',
    description: 'Maximum number of CI runs to inspect per repository.',
  },

  {
    key: 'alias.*',
    display: 'alias.<name>',
    type: 'string',
    description:
      'Shorthand for a longer command, e.g. `alias.up = update --install`. A value starting with `!` is run by the shell instead, with any extra arguments appended.',
  },
];

const KEY_INDEX = new Map<string, ConfigKeyDef>(CONFIG_KEYS.map((def) => [def.key, def]));

/**
 * Renders a key with its documented casing, preserving a real repo subsection. For example,
 * `install.npmrestorelockfile.my-repo` becomes `install.npmRestoreLockfile.my-repo` (the repo name
 * is kept exactly as written; only the key's own casing is documented).
 *
 * @param key Dotted key (e.g. `install.npmrestorelockfile`).
 * @returns The key, rendered with documented casing. Returns `key` unchanged if not recognised.
 */
export const displayKey = (key: string): string => {
  const def = findKeyDef(key);
  if (!def) return key;

  // `alias.*`: the wildcard segment is the user's own name, kept verbatim.
  if (def.key.includes('*')) {
    const parts = key.split('.');
    const defParts = def.key.split('.');
    const displayParts = def.display.split('.');
    return parts
      .map((part, index) => (defParts[index] === '*' ? part : displayParts[index]))
      .join('.');
  }

  const { subsection } = splitKey(key);
  if (subsection === undefined) return def.display;

  // Repo-scoped: the middle segment is the repo name, kept exactly as written.
  const [displaySection, displayLeaf] = def.display.split('.');
  return `${displaySection}.${subsection}.${displayLeaf}`;
};

/**
 * The documented casing of just the key's final segment, e.g. `restoreLockfile`.
 *
 * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
 * @returns The final segment's documented casing, or `undefined` if `key` is not recognised.
 */
export const displayName = (key: string): string | undefined => {
  const def = findKeyDef(key);
  if (!def) return undefined;
  // A trailing wildcard means the final segment is the user's own name.
  if (def.key.endsWith('.*')) return key.split('.').at(-1);
  return def.display.split('.').at(-1);
};

/**
 * Looks up a key definition, collapsing a repo-scoped key (`core.my-repo.editor`) onto its base
 * definition (`core.editor`) when that key allows it.
 *
 * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
 * @returns The matching definition, or `undefined` if `key` is not recognised.
 */
export const findKeyDef = (key: string): ConfigKeyDef | undefined => {
  const normalised = key.toLowerCase();
  const direct = KEY_INDEX.get(normalised);
  if (direct) return direct;

  const parts = normalised.split('.');

  // A subsection always means "this repo" now, so `core.my-repo.editor` collapses onto
  // `core.editor` -- but only when that key opted in.
  if (parts.length >= 3) {
    const base = KEY_INDEX.get([parts[0], parts.at(-1)].join('.'));
    return base?.repoScopable ? base : undefined;
  }

  // `alias.up` collapses onto `alias.*`, where the name itself is the wildcard.
  if (parts.length === 2) {
    return KEY_INDEX.get(`${parts[0]}.*`);
  }

  return undefined;
};

/**
 * Parses a config value as a boolean, accepting git's usual spellings.
 *
 * @param value Raw config value.
 * @param key Key the value belongs to, used only for the error message.
 * @returns The parsed boolean.
 * @throws GitxError If `value` is not a recognised boolean spelling.
 */
export const parseBoolean = (value: string, key: string): boolean => {
  const normalised = value.trim().toLowerCase();
  if (TRUTHY.has(normalised)) return true;
  if (FALSY.has(normalised)) return false;
  throw new GitxError(`bad boolean value for '${key}': ${value}`, {
    code: ExitCode.Config,
    hint: 'Expected one of: true, false, yes, no, on, off, 1, 0.',
  });
};

/**
 * Parses a config value as a number.
 *
 * @param value Raw config value.
 * @param key Key the value belongs to, used only for the error message.
 * @returns The parsed number.
 * @throws GitxError If `value` is not a finite number.
 */
export const parseNumber = (value: string, key: string): number => {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new GitxError(`bad numeric value for '${key}': ${value}`, {
      code: ExitCode.Config,
      hint: 'Expected a number.',
    });
  }
  return parsed;
};

/**
 * Resolves the `concurrency` pseudo-type into a concrete worker count.
 *
 * @param value Raw config value: a non-negative integer, `auto`, `unlimited`, or `undefined`.
 * @returns The resolved worker count (`Infinity` for `0` or `unlimited`).
 * @throws GitxError If `value` is not a recognised concurrency value.
 */
export const resolveConcurrency = (value: string | undefined): number => {
  if (value === undefined || value === 'auto' || value === '') {
    return availableParallelism();
  }
  if (value === 'unlimited') return Number.POSITIVE_INFINITY;

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new GitxError(`invalid concurrency: ${value}`, {
      code: ExitCode.Config,
      hint: 'Expected a non-negative integer, `auto` or `unlimited`.',
    });
  }
  return parsed === 0 ? Number.POSITIVE_INFINITY : parsed;
};

/**
 * Validates a value against its key definition, returning the normalised form.
 *
 * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
 * @param value Candidate value.
 * @returns The normalised value. Returns `value` unchanged if `key` is not recognised.
 * @throws GitxError If `value` fails validation for `key`'s type.
 */
export function validateValue(key: string, value: string): string {
  const def = findKeyDef(key);
  if (!def) return value;

  switch (def.type) {
    case 'boolean':
      return String(parseBoolean(value, key));
    case 'number':
      return String(parseNumber(value, key));
    case 'concurrency':
      resolveConcurrency(value);
      return value;
    case 'enum': {
      const normalised = value.trim().toLowerCase();
      if (def.values && !def.values.includes(normalised)) {
        throw new GitxError(`bad value for '${key}': ${value}`, {
          code: ExitCode.Config,
          hint: `Expected one of: ${def.values.join(', ')}.`,
        });
      }
      return normalised;
    }
    case 'path':
    case 'string':
      return value;
  }
}
