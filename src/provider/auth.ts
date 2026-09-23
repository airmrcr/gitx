import { ExitCode, GitxError } from '../util/errors.ts';
import { exec } from '../util/exec.ts';

const fromEnvironment = (
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Credential | undefined => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return { token: value, source: `$${name}` };
    }
  }
  return undefined;
};

const helperHint = (helpers: readonly string[]): string => {
  if (helpers.length === 0) {
    return [
      'No credential helper is configured, so git has nowhere to put it.',
      'Set one up, for example:',
      '  macOS    git config --global credential.helper osxkeychain',
      '  Linux    git config --global credential.helper libsecret',
      '  Windows  git config --global credential.helper manager',
      'Or skip storage altogether and export the token instead.',
    ].join('\n');
  }

  return `\`credential.helper\` is set to ${helpers.join(', ')}, but it did not store the token.`;
};

/**
 * A discovered credential, as found by {@link findCredential}.
 *
 * gitx deliberately stores no credentials of its own. It reads what you have already authorised, in
 * this order:
 *
 *   1. `GITX_TOKEN`, for an explicit per-invocation override.
 *   2. The provider's conventional environment variables, so a token exported for `gh` or `glab`
 *      already works here.
 *   3. `git credential fill`, which is the user's existing credential store -- the macOS Keychain,
 *      libsecret, Windows Credential Manager, or whatever `credential.helper` points at.
 *
 * Step 3 is the interesting one: it means anyone who has ever authenticated git against the host is
 * already authenticated against gitx, with no login step and no new place for a secret to leak
 * from.
 */
export interface Credential {
  /** Where it came from, for `gitx auth status` and error messages. */
  source: string;
  /** The token itself. */
  token: string;
  /** The account the token is stored under, when git knows one. */
  username?: string | undefined;
}

/**
 * Options for {@link findCredential}.
 */
export interface FindCredentialOptions {
  /** Environment variable names to consult, in order of preference. */
  envNames: readonly string[];
  /** The host to look up a credential for. */
  host: string;
  /**
   * Environment to read tokens from.
   *
   * @default process.env
   */
  env?: NodeJS.ProcessEnv;
  /** Aborted to cancel the `git credential fill` lookup. */
  signal?: AbortSignal | undefined;
}

/**
 * Options for {@link requireCredential}.
 */
export interface RequireCredentialOptions extends FindCredentialOptions {
  /** Provider display name, used in the error message. */
  label: string;
  /** Where to go to create a token. */
  tokenUrl: string;
}

/**
 * The credential helpers git will actually use, in order.
 *
 * An empty value resets the list rather than adding a blank entry -- that is how a system-wide
 * helper gets disabled -- so anything configured before one is discarded here too.
 *
 * @returns The effective list of configured credential helpers.
 */
export const configuredHelpers = async (): Promise<string[]> => {
  const result = await exec('git', ['config', '--get-all', 'credential.helper']);
  if (!result.ok) return [];

  // Exactly one trailing newline is git's line terminator, not a final empty value; stripping more
  // would swallow a genuine reset written last.
  let helpers: string[] = [];
  for (const line of result.stdout.replace(/\n$/, '').split('\n')) {
    const helper = line.trim();
    if (helper.length === 0) helpers = [];
    else helpers.push(helper);
  }
  return helpers;
};

/**
 * Removes a stored token, so `gitx auth logout` can undo a login.
 *
 * Reports whether anything was actually removed: `git credential reject` exits 0 for a host it has
 * never heard of, so its status says nothing on its own.
 *
 * @param host The host to remove the stored token for.
 * @param [username] The account to remove the token for, defaulting to whichever one git has
 * stored.
 * @returns Whether a credential was actually removed.
 * @throws GitxError If git fails to remove the token, or the token is still present afterwards.
 */
export const eraseCredential = async (
  host: string,
  username?: string,
): Promise<{ removed: boolean }> => {
  const before = await fromGitCredential(host);
  if (before === undefined) return { removed: false };

  const identity = username ?? before.username;
  const result = await exec('git', ['credential', 'reject'], {
    input: `protocol=https\nhost=${host}\n${identity === undefined ? '' : `username=${identity}\n`}\n`,
  });

  if (!result.ok) {
    throw new GitxError(`unable to remove the stored token for ${host}`, {
      code: ExitCode.Auth,
      detail: result.stderr.trim(),
    });
  }

  const after = await fromGitCredential(host);
  if (after !== undefined) {
    throw new GitxError(`the stored token for ${host} is still there`, {
      code: ExitCode.Auth,
      hint: `\`${(await configuredHelpers()).join(', ') || 'your credential helper'}\` refused to delete it. Remove it by hand.`,
    });
  }

  return { removed: true };
};

/**
 * Finds a token for `host`, or `undefined` when there is nothing to find.
 *
 * @param options The options to be used.
 * @returns The discovered credential, or `undefined` if none was found.
 */
export const findCredential = async (
  options: FindCredentialOptions,
): Promise<Credential | undefined> => {
  const env = options.env ?? process.env;

  const override = fromEnvironment(['GITX_TOKEN'], env);
  if (override) return override;

  const conventional = fromEnvironment(options.envNames, env);
  if (conventional) return conventional;

  return fromGitCredential(options.host, options.signal);
};

/**
 * Asks git for a stored credential.
 *
 * `credential.interactive=never` is forced so a missing credential comes back empty instead of git
 * popping its own prompt in the middle of our output.
 *
 * @param host The host to look up a credential for.
 * @param [signal] Aborted to cancel the lookup.
 * @returns The stored credential, or `undefined` if git has none.
 */
export const fromGitCredential = async (
  host: string,
  signal?: AbortSignal,
): Promise<Credential | undefined> => {
  const result = await exec('git', ['-c', 'credential.interactive=never', 'credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    ...(signal ? { signal } : {}),
  });

  if (!result.ok) return undefined;

  const fields = parseCredentialOutput(result.stdout);
  const password = fields['password'];
  if (password === undefined || password.length === 0) return undefined;

  return {
    token: password,
    source: `git credential (${host})`,
    ...(fields['username'] ? { username: fields['username'] } : {}),
  };
};

/**
 * Parses git's `key=value` credential format.
 *
 * @param output The raw output from a `git credential` subcommand.
 * @returns The parsed fields, keyed by name.
 */
export const parseCredentialOutput = (output: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
};

/**
 * Like {@link findCredential}, but explains how to fix it when there is none.
 *
 * @param options The options to be used.
 * @returns The discovered credential.
 * @throws GitxError If no credential could be found.
 */
export const requireCredential = async (options: RequireCredentialOptions): Promise<Credential> => {
  const found = await findCredential(options);
  if (found) return found;

  const [primary] = options.envNames;

  throw new GitxError(`not authenticated with ${options.label} (${options.host})`, {
    code: ExitCode.Auth,
    hint: [
      `Create a token at ${options.tokenUrl}, then either:`,
      `  export ${primary ?? 'GITX_TOKEN'}=<token>`,
      `  or store it for good: gitx auth login --host ${options.host}`,
    ].join('\n'),
  });
};

/**
 * Persists a token in the user's credential store via git.
 *
 * Writing through git rather than a keyring binding means gitx needs no native dependency and
 * automatically respects whatever helper the user has already chosen, including none at all.
 *
 * @param host The host to store the credential for.
 * @param username The account the token belongs to.
 * @param token The token to store.
 * @throws GitxError If git fails to store the token, or nothing actually stored it.
 */
export const storeCredential = async (
  host: string,
  username: string,
  token: string,
): Promise<void> => {
  const result = await exec('git', ['credential', 'approve'], {
    input: `protocol=https\nhost=${host}\nusername=${username}\npassword=${token}\n\n`,
  });

  if (!result.ok) {
    throw new GitxError(`unable to store credentials for ${host}`, {
      code: ExitCode.Auth,
      detail: result.stderr.trim(),
      hint: helperHint(await configuredHelpers()),
    });
  }

  // `git credential approve` succeeds whether or not a helper was listening: with none configured
  // it discards the token and exits 0. Reading it back is the only way to know it actually went
  // somewhere.
  const stored = await fromGitCredential(host);
  if (stored?.token !== token) {
    throw new GitxError(`nothing stored the token for ${host}`, {
      code: ExitCode.Auth,
      hint: helperHint(await configuredHelpers()),
    });
  }
};
