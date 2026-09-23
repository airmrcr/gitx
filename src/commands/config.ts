import { access } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { splitKey } from '../config/ini.ts';
import { CONFIG_KEYS, displayKey, findKeyDef } from '../config/schema.ts';
import { Config } from '../config/store.ts';
import { Git } from '../git/git.ts';
import { ExitCode, GitxError } from '../util/errors.ts';
import { theme } from '../util/theme.ts';
import { splitWords } from '../util/words.ts';
import { launchEditor } from './open.ts';

// What `--repo` parsed to: absent entirely, given with no value (use the current repository), or
// given a specific name.
type RepoOption = string | boolean | undefined;

const assertKnownKey = (key: string): void => {
  if (findKeyDef(key)) return;
  throw new GitxError(`unknown configuration key: ${key}`, {
    code: ExitCode.Config,
    hint: 'Run `gitx config list --all --describe` to see every supported key.',
  });
};

const currentRepoName = async (): Promise<string | undefined> => {
  const root = await new Git({ cwd: process.cwd() }).root();
  return root === undefined ? undefined : path.basename(root);
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

// Resolves what `config get` should print.
//
// Without `--repo` this is a plain read of `targetKey` (`key` unchanged). With `--repo`, a repo
// override alone would make an unconfigured repo look unset even though the plain value still
// governs it -- so it falls back to `key` (the plain value) before falling any further to the
// schema default.
const getValues = (
  config: Config,
  key: string,
  targetKey: string,
  flags: { all?: boolean; default?: boolean; repo?: RepoOption },
): string[] => {
  if (flags.all === true) return config.getAll(targetKey);

  const value =
    flags.repo === undefined
      ? flags.default === true
        ? config.get(targetKey)
        : config.getRaw(targetKey)
      : (config.getRaw(targetKey) ??
        config.getRaw(key) ??
        (flags.default === true ? findKeyDef(key)?.fallback : undefined));

  return value === undefined ? [] : [value];
};

const load = async (options: ConfigCommandOptions): Promise<Config> =>
  Config.load(options.configPath());

// Rewrites `key` to target one repository's override, resolving `--repo` with no value to the
// repository containing the current directory.
//
// Returns `key` unchanged when `--repo` was not given at all.
const resolveScopedKey = async (key: string, repoOption: RepoOption): Promise<string> => {
  if (repoOption === undefined) return key;

  let repo: string;
  if (typeof repoOption === 'string') {
    repo = repoOption;
  } else {
    const current = await currentRepoName();
    if (current === undefined) {
      throw new GitxError('no repository given', {
        code: ExitCode.Usage,
        hint: 'Run this from inside the repository you mean, or pass --repo <name>.',
      });
    }
    repo = current;
  }

  const { section, subsection, name } = splitKey(key);
  if (subsection !== undefined) {
    throw new GitxError(`key is already scoped to a repository: ${key}`, {
      code: ExitCode.Usage,
      hint: '--repo scopes a plain key; it cannot be combined with one that already has a subsection.',
    });
  }

  return `${section}.${repo}.${name}`;
};

// Aliases lose to built-in commands, so setting one that clashes is futile.
const warnIfShadowing = (key: string, options: ConfigCommandOptions): void => {
  const [section, name] = key.toLowerCase().split('.');
  if (section !== 'alias' || name === undefined) return;

  if (options.reservedNames?.().has(name) !== true) return;

  process.stderr.write(
    `${theme.warn('!')} '${name}' is already a gitx command, so this alias will never run\n`,
  );
};

/**
 * Options controlling where `gitx config` reads/writes, and what it must not shadow.
 */
export interface ConfigCommandOptions {
  /** Resolves the config file path to use. */
  configPath: () => string;
  /** Command names an alias must not try to shadow. */
  reservedNames?: () => ReadonlySet<string>;
}

/**
 * Options for {@link renderList}.
 */
export interface RenderListOptions {
  /** Include keys that are unset, showing their defaults. */
  all?: boolean;
  /** Include a description of every known key. */
  describe?: boolean;
}

/**
 * `gitx config` mirrors `git config` closely enough that muscle memory carries over: keys are
 * `section.name` (or `section.subsection.name`), values may repeat, and `--all` is required to
 * remove a multi-valued key.
 *
 * @param options The options to be used.
 * @returns The configured `config` {@link Command}, with its subcommands attached.
 */
export const configCommand = (options: ConfigCommandOptions): Command => {
  const command = new Command('config').description(
    'Read and write gitx configuration (~/.gitxconfig)',
  );

  command
    .command('edit')
    .description('Open the configuration file in $EDITOR')
    .action(async () => {
      const editorSetting = process.env['VISUAL'] ?? process.env['EDITOR'];

      if (!editorSetting) {
        throw new GitxError('no editor configured', {
          code: ExitCode.Config,
          hint: 'Set $EDITOR or $VISUAL, or edit ~/.gitxconfig directly.',
        });
      }

      const configPath = options.configPath();

      // Ensure the file exists so the editor does not open a phantom buffer. Only ever written when
      // missing: re-saving an existing file would round-trip it through the parser, silently
      // dropping any comments.
      if (!(await fileExists(configPath))) {
        await new Config([], configPath).save();
      }

      const [editorCommand, ...editorArgs] = splitWords(editorSetting);
      if (editorCommand === undefined) {
        throw new GitxError('no editor configured', {
          code: ExitCode.Config,
          hint: 'Set $EDITOR or $VISUAL, or edit ~/.gitxconfig directly.',
        });
      }

      process.exitCode = await launchEditor(editorCommand, [...editorArgs, configPath]);
    });

  command
    .command('get')
    .description('Print the value of a configuration key')
    .argument('<key>', 'configuration key, e.g. core.baseDir')
    .option('--all', 'print every value for a multi-valued key')
    .option('--default', 'fall back to the built-in default when unset')
    .option('--repo [name]', "read this repository's override (defaults to the current one)")
    .action(async (key: string, flags: { all?: boolean; default?: boolean; repo?: RepoOption }) => {
      const config = await load(options);
      const targetKey = await resolveScopedKey(key, flags.repo);
      if (flags.repo !== undefined) assertKnownKey(targetKey);

      const values = getValues(config, key, targetKey, flags);

      if (values.length === 0) {
        process.exitCode = 1;
        return;
      }

      for (const value of values) {
        process.stdout.write(`${value}\n`);
      }
    });

  command
    .command('list')
    .description('List configuration')
    .option('--all', 'include keys that are unset, showing their defaults')
    .option('--describe', 'include a description of every known key')
    .action(async (flags: { all?: boolean; describe?: boolean }) => {
      const config = await load(options);
      process.stdout.write(renderList(config, flags));
    });

  command
    .command('path')
    .description('Print the path of the configuration file in use')
    .action(() => {
      process.stdout.write(`${options.configPath()}\n`);
    });

  command
    .command('set')
    .description('Set a configuration key')
    .argument('<key>', 'configuration key, e.g. core.baseDir')
    .argument('<value>', 'value to store')
    .option('--add', 'append a value instead of replacing existing ones')
    .option('--repo [name]', "set this repository's override (defaults to the current one)")
    .action(async (key: string, value: string, flags: { add?: boolean; repo?: RepoOption }) => {
      const config = await load(options);
      const targetKey = await resolveScopedKey(key, flags.repo);
      assertKnownKey(targetKey);
      warnIfShadowing(targetKey, options);

      if (flags.add === true) {
        config.add(targetKey, value);
      } else {
        config.set(targetKey, value);
      }

      await config.save();
      process.stdout.write(`${theme.success('✔')} ${targetKey} = ${value}\n`);
    });

  command
    .command('unset')
    .description('Remove a configuration key')
    .argument('<key>', 'configuration key, e.g. core.baseDir')
    .option('--all', 'remove every value for a multi-valued key')
    .option('--repo [name]', "remove this repository's override (defaults to the current one)")
    .action(async (key: string, flags: { all?: boolean; repo?: RepoOption }) => {
      const config = await load(options);
      const targetKey = await resolveScopedKey(key, flags.repo);
      if (flags.repo !== undefined) assertKnownKey(targetKey);

      const removed = config.unset(targetKey, { all: flags.all === true });

      if (removed === 0) {
        process.stderr.write(`${theme.warn('!')} ${targetKey} is not set\n`);
        process.exitCode = 1;
        return;
      }

      await config.save();
      process.stdout.write(`${theme.success('✔')} removed ${targetKey}\n`);
    });

  return command;
};

/**
 * Builds the `config list` output.
 *
 * @param config Config to render.
 * @param [options] The options to be used.
 * @returns The rendered listing text.
 */
export const renderList = (config: Config, options: RenderListOptions = {}): string => {
  const lines: string[] = [];

  if (options.all === true) {
    for (const def of CONFIG_KEYS) {
      // Wildcard keys have no single value to show.
      if (def.key.includes('*')) {
        if (options.describe === true) {
          lines.push(
            `${theme.muted(`${def.display} = <unset>`)}`,
            `    ${theme.muted(def.description)}`,
          );
        }
        continue;
      }

      const values = config.getAll(def.key);
      const effective = values.length > 0 ? values : [def.fallback ?? '<unset>'];

      for (const value of effective) {
        const isDefault = values.length === 0;
        const rendered = `${def.display}=${value}`;
        lines.push(isDefault ? theme.muted(rendered) : rendered);
      }

      if (options.describe === true) lines.push(`    ${theme.muted(def.description)}`);
    }

    return `${lines.join('\n')}\n`;
  }

  for (const item of config.list()) {
    const def = findKeyDef(item.key);
    lines.push(`${displayKey(item.key)}=${item.value}`);
    if (options.describe === true && def) lines.push(`    ${theme.muted(def.description)}`);
  }

  return lines.length === 0 ? `${theme.muted('No configuration set.')}\n` : `${lines.join('\n')}\n`;
};
