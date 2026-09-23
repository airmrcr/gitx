import { type Command, InvalidArgumentError } from 'commander';

// The options that decide *which* remote repositories a command works with.
//
// They are declared on the program too, so `gitx -o acme list` has always worked. Declaring them
// again on the commands that actually use them is what makes them discoverable: they appear in
// `gitx list --help` and in generated tab completion, where a global option buried in `gitx --help`
// does not.
//
// Commands that never touch a remote -- `config`, `completion`, `tidy` -- are deliberately left
// alone, so their help stays honest about what they read.

/**
 * Controls which of the optional remote options {@link addRemoteOptions} adds.
 */
export interface RemoteOptionChoices {
  /**
   * Whether to add `--owner`.
   *
   * @default true
   */
  owner?: boolean;
}

/**
 * Adds `--concurrency` to a command that actually sweeps repositories in parallel (`runs`, `clone`,
 * `clone-all`, `update`).
 *
 * Declared on the program too, for the same reason as the remote options above: this just makes it
 * discoverable on the commands that use it, rather than only working as an option nobody reading
 * `gitx update --help` would know to look for.
 *
 * @param command Command to add the option to.
 * @returns `command`, for chaining.
 */
export const addConcurrencyOption = (command: Command): Command =>
  command.option(
    '-j, --concurrency <count>',
    'maximum repositories processed in parallel (`auto`, `unlimited` or a number)',
    parseConcurrency,
  );

/**
 * Adds `--host`, `--owner` and `--provider` to a command.
 *
 * @param command Command to add the options to.
 * @param [choices] The choices to be applied.
 * @returns `command`, for chaining.
 */
export const addRemoteOptions = (command: Command, choices: RemoteOptionChoices = {}): Command => {
  command.option('-H, --host <host>', 'provider host, for self-hosted instances');

  if (choices.owner ?? true) {
    command.option('-o, --owner <owner>', 'organisation, group or user that owns the repositories');
  }

  return command.option('-P, --provider <name>', 'github or gitlab');
};

/**
 * Reads an option from the command that is running, then its ancestors.
 *
 * Nearest wins, so `gitx -o acme list -o widgets` uses `widgets`: the option written next to the
 * command is the more specific instruction. Commander's own `optsWithGlobals` resolves the other
 * way round.
 *
 * @typeParam T Expected type of the option's value.
 * @param command Command that is running.
 * @param key Option key to read.
 * @returns The nearest ancestor's value for `key`, or `undefined` if unset anywhere.
 */
export const nearestOption = <T>(command: Command | undefined, key: string): T | undefined => {
  for (let current = command; current; current = current.parent ?? undefined) {
    const value = current.opts()[key] as T | undefined;
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * Validates `--limit`, so a malformed value fails loudly instead of silently becoming `NaN`.
 *
 * @param value Raw `--limit` value.
 * @returns `value`, unchanged.
 * @throws InvalidArgumentError If `value` is not a positive integer.
 */
export const parseLimit = (value: string): string => {
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return value;
};

/**
 * Validates `--concurrency`, accepting a non-negative integer, `auto` or `unlimited`.
 *
 * @param value Raw `--concurrency` value.
 * @returns `value`, unchanged.
 * @throws InvalidArgumentError If `value` is not a recognised concurrency value.
 */
export const parseConcurrency = (value: string): string => {
  if (value === 'auto' || value === 'unlimited') return value;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new InvalidArgumentError('expected a non-negative integer, `auto` or `unlimited`');
  }
  return value;
};
