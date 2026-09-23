import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExitCode, GitxError } from '../util/errors.ts';
import {
  canonicalKey,
  entryKey,
  formatIni,
  type IniEntry,
  IniParseError,
  parseIni,
  splitKey,
} from './ini.ts';
import {
  displayName,
  findKeyDef,
  parseBoolean,
  parseNumber,
  resolveConcurrency,
  validateValue,
} from './schema.ts';

const normaliseKey = (key: string): string => {
  const parts = splitKey(key);
  return canonicalKey(parts.section, parts.subsection, parts.name);
};

/**
 * A single `key=value` pair as returned by {@link Config.list}.
 */
export interface ConfigListItem {
  /** Canonical dotted key (e.g. `install.npm.restoreLockfile`). */
  key: string;
  /** The entry's value. */
  value: string;
}

/**
 * Options for {@link Config.unset}.
 */
export interface ConfigUnsetOptions {
  /** Whether to remove all values for a multi-value key. */
  all?: boolean;
}

/**
 * An in-memory, ordered view of a `~/.gitxconfig` file, with git-like get/set/unset semantics
 * layered on top.
 */
export class Config {
  /**
   * Reads a config file, treating a missing file as empty.
   *
   * @param [filePath] Path to the config file.
   * @returns The loaded {@link Config}.
   * @throws GitxError If the file exists but cannot be read, or is not valid git-config syntax.
   */
  static async load(filePath: string = defaultConfigPath()): Promise<Config> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Config([], filePath);
      }
      throw new GitxError(`unable to read config: ${filePath}`, {
        code: ExitCode.Config,
        cause: error,
      });
    }

    try {
      return new Config(parseIni(text), filePath);
    } catch (error) {
      if (error instanceof IniParseError) {
        throw new GitxError(`invalid config: ${filePath}`, {
          code: ExitCode.Config,
          cause: error,
          detail: error.message,
        });
      }
      throw error;
    }
  }

  /**
   * Parses config text directly, without touching the filesystem.
   *
   * @param text Raw git-config formatted text.
   * @param [filePath] Path this config will be saved to.
   * @returns The parsed {@link Config}.
   * @throws IniParseError If `text` is not valid git-config syntax.
   */
  static parse(text: string, filePath: string = defaultConfigPath()): Config {
    return new Config(parseIni(text), filePath);
  }

  /** Path this config was loaded from, or will be saved to. */
  readonly filePath: string;
  #dirty = false;
  #entries: IniEntry[];

  /**
   * Creates a new {@link Config} instance.
   *
   * @param [entries] Initial entries, in file order.
   * @param [filePath] Path this config will be saved to.
   */
  constructor(entries: IniEntry[] = [], filePath: string = defaultConfigPath()) {
    this.filePath = filePath;
    this.#entries = [...entries];
  }

  /** Whether this config has unsaved changes. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** All entries, in file order. */
  get entries(): readonly IniEntry[] {
    return this.#entries;
  }

  /**
   * Appends an additional value, building a multi-value key.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @param value Value to append.
   * @throws GitxError If `value` fails schema validation for `key`.
   */
  add(key: string, value: string): void {
    const validated = validateValue(key, value);
    const parts = splitKey(key);
    this.#entries.push({
      section: parts.section,
      subsection: parts.subsection,
      name: parts.name,
      displayName: displayName(key) ?? parts.name,
      value: validated,
    });
    this.#dirty = true;
  }

  /**
   * Returns the configured value, or the schema fallback when unset.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @returns The value, or `undefined` if unset and there is no schema fallback.
   */
  get(key: string): string | undefined {
    return this.getRaw(key) ?? findKeyDef(key)?.fallback;
  }

  /**
   * Returns all values for a key, in file order.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @returns The matching values, in file order.
   */
  getAll(key: string): string[] {
    const target = normaliseKey(key);
    return this.#entries.filter((entry) => entryKey(entry) === target).map((entry) => entry.value);
  }

  /**
   * Returns the configured value, parsed as a boolean.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @returns The parsed value, or `false` if unset.
   * @throws GitxError If the value is not a valid boolean.
   */
  getBoolean(key: string): boolean {
    const value = this.get(key);
    return value === undefined ? false : parseBoolean(value, key);
  }

  /**
   * Resolves `core.concurrency` to a worker count (`Infinity` when unlimited).
   *
   * @param [key='core.concurrency'] Dotted key to resolve.
   * @returns The resolved worker count.
   */
  getConcurrency(key = 'core.concurrency'): number {
    return resolveConcurrency(this.get(key));
  }

  /**
   * The value for `section.name`, preferring a repository-scoped override (`section.<repo>.name`)
   * when `repo` is given and one is set.
   *
   * @param section Section name.
   * @param repo Repository-scoped override to prefer, if any.
   * @param name Key name.
   * @returns The resolved value, or `undefined` if unset.
   */
  getForRepo(section: string, repo: string | undefined, name: string): string | undefined {
    if (repo !== undefined) {
      const scoped = this.getRaw(`${section}.${repo}.${name}`);
      if (scoped !== undefined) return scoped;
    }
    return this.get(`${section}.${name}`);
  }

  /**
   * Resolves an `install.*` boolean, most specific first: this repository's override for this
   * package manager, then this package manager's override for every repository, then the plain
   * setting that applies to any manager.
   *
   * The package manager lives in the key name (`install.npmFrozen`), not a subsection, so the
   * subsection stays free for the repository override (`[install "my-repo"]`) instead of the two
   * competing for the same slot.
   *
   * Some manager-specific keys (`install.<manager>enabled`) have no plain-key form, so the schema
   * default is looked up against both shapes.
   *
   * @param name Key name, without the `install.` prefix or manager infix.
   * @param manager Package manager to resolve the override for.
   * @param [repo] Repository-scoped override to prefer, if any.
   * @returns The resolved value, or `false` if unset.
   * @throws GitxError If the resolved value is not a valid boolean.
   */
  getInstallBoolean(name: string, manager: string, repo?: string): boolean {
    const managerKey = `install.${manager}${name}`;

    if (repo !== undefined) {
      const scoped = this.getRaw(`install.${repo}.${manager}${name}`);
      if (scoped !== undefined) return parseBoolean(scoped, managerKey);
    }

    const managerValue = this.getRaw(managerKey);
    if (managerValue !== undefined) return parseBoolean(managerValue, managerKey);

    const plainKey = `install.${name}`;
    const plainValue = this.getRaw(plainKey);
    if (plainValue !== undefined) return parseBoolean(plainValue, plainKey);

    const fallback = findKeyDef(plainKey)?.fallback ?? findKeyDef(managerKey)?.fallback;
    return fallback === undefined ? false : parseBoolean(fallback, managerKey);
  }

  /**
   * List values for a key. Falls back to the schema default only when the key is entirely absent,
   * so that setting a single value fully replaces the default.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @returns The matching values, in file order.
   */
  getList(key: string): string[] {
    const values = this.getAll(key);
    if (values.length > 0) return values;
    const fallback = findKeyDef(key)?.fallback;
    return fallback === undefined ? [] : [fallback];
  }

  /**
   * Returns the configured value, parsed as a number.
   *
   * @param key Dotted key (e.g. `core.concurrency`).
   * @returns The parsed value.
   * @throws GitxError If the key is unset, or the value is not a valid number.
   */
  getNumber(key: string): number {
    const value = this.get(key);
    if (value === undefined) {
      throw new GitxError(`missing numeric config: ${key}`, { code: ExitCode.Config });
    }
    return parseNumber(value, key);
  }

  /**
   * Returns the last value for a key, matching git's "last one wins" precedence.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @returns The last value, or `undefined` if unset.
   */
  getRaw(key: string): string | undefined {
    return this.getAll(key).at(-1);
  }

  /**
   * {@link getForRepo}, parsed as a boolean.
   *
   * @param section Section name.
   * @param repo Repository-scoped override to prefer, if any.
   * @param name Key name.
   * @returns The resolved value, or `false` if unset.
   * @throws GitxError If the value is not a valid boolean.
   */
  getForRepoBoolean(section: string, repo: string | undefined, name: string): boolean {
    const value = this.getForRepo(section, repo, name);
    return value === undefined ? false : parseBoolean(value, `${section}.${name}`);
  }

  /**
   * Whether a key has at least one value.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @returns `true` if the key has at least one value; otherwise `false`.
   */
  has(key: string): boolean {
    return this.getAll(key).length > 0;
  }

  /**
   * Returns every configured entry as displayable `key=value` pairs.
   *
   * @returns The entries, in file order.
   */
  list(): ConfigListItem[] {
    return this.#entries.map((entry) => ({
      key: canonicalKey(entry.section, entry.subsection, entry.name),
      value: entry.value,
    }));
  }

  /**
   * Atomically writes the config back to disk.
   *
   * @throws GitxError If the file cannot be written.
   */
  async save(): Promise<void> {
    const text = this.toString();
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.tmp`;

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
      this.#dirty = false;
    } catch (error) {
      throw new GitxError(`unable to write config: ${this.filePath}`, {
        code: ExitCode.Config,
        cause: error,
      });
    }
  }

  /**
   * Replaces every value for a key with a single value.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @param value New value.
   * @throws GitxError If `value` fails schema validation for `key`.
   */
  set(key: string, value: string): void {
    const validated = validateValue(key, value);
    const target = normaliseKey(key);
    const parts = splitKey(key);

    let replaced = false;
    const next: IniEntry[] = [];

    for (const entry of this.#entries) {
      if (entryKey(entry) !== target) {
        next.push(entry);
        continue;
      }
      if (!replaced) {
        next.push({ ...entry, value: validated });
        replaced = true;
      }
      // Drop any further duplicates.
    }

    if (!replaced) {
      next.push({
        section: parts.section,
        subsection: parts.subsection,
        name: parts.name,
        displayName: displayName(key) ?? parts.name,
        value: validated,
      });
    }

    this.#entries = next;
    this.#dirty = true;
  }

  /**
   * Serialises this config back to git-config text.
   *
   * @returns The formatted git-config text.
   */
  toString(): string {
    return formatIni(this.#entries);
  }

  /**
   * Removes values for a key.
   *
   * Without {@link ConfigUnsetOptions.all}, removing a key that holds multiple values is an error,
   * mirroring `git config --unset`.
   *
   * @param key Dotted key (e.g. `install.npm.restoreLockfile`).
   * @param [options] The options to be used.
   * @returns The number of values removed.
   * @throws GitxError If the key holds multiple values and {@link ConfigUnsetOptions.all} is not
   * set.
   */
  unset(key: string, options: ConfigUnsetOptions = {}): number {
    const target = normaliseKey(key);
    const matches = this.#entries.filter((entry) => entryKey(entry) === target);

    if (matches.length === 0) return 0;
    if (matches.length > 1 && options.all !== true) {
      throw new GitxError(`key has multiple values: ${key}`, {
        code: ExitCode.Config,
        hint: `Use \`gitx config unset --all ${key}\` to remove them all.`,
      });
    }

    this.#entries = this.#entries.filter((entry) => entryKey(entry) !== target);
    this.#dirty = true;
    return matches.length;
  }
}

/**
 * Resolves the config file path, honouring the `GITX_CONFIG` override.
 *
 * @param [env=process.env] Environment to read from.
 * @returns The absolute path to the config file.
 */
export const defaultConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env['GITX_CONFIG'];
  if (override && override.length > 0) return path.resolve(expandHome(override, env));
  return path.join(os.homedir(), '.gitxconfig');
};

/**
 * Expands a leading `~` and any `$VAR` references in a path-like string.
 *
 * @param value The path-like string to expand.
 * @param [env=process.env] Environment to read `$VAR` references from.
 * @returns The expanded string.
 */
export const expandHome = (value: string, env: NodeJS.ProcessEnv = process.env): string => {
  let expanded = value;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith(`~${path.sep}`)) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return expanded.replaceAll(/\$(\w+)|\$\{(\w+)\}/g, (match, a: string, b: string) => {
    const name = a ?? b;
    return env[name] ?? match;
  });
};
