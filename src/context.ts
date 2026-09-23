import path from 'node:path';
import { findKeyDef, resolveConcurrency } from './config/schema.ts';
import { Config, defaultConfigPath, expandHome } from './config/store.ts';
import { type Layout, Workspace } from './git/repo.ts';
import { createProvider, providerInfo, PROVIDERS } from './provider/registry.ts';
import type { Protocol, Provider } from './provider/types.ts';
import { ExitCode, GitxError } from './util/errors.ts';
import { isInteractive, promptSelect, promptText, type SelectPromptOption } from './util/prompt.ts';
import { type ColorMode, setColorMode } from './util/theme.ts';

const asProtocol = (value: string): Protocol => {
  if (value === 'https' || value === 'ssh') return value;

  throw new GitxError(`remote.protocol must be https or ssh, not \`${value}\``, {
    code: ExitCode.Config,
    hint: 'Run `gitx config set remote.protocol https`.',
  });
};

const displayName = (key: string): string => key.split('.').at(-1) ?? key;

/**
 * CLI-wide options shared by every command, resolved from flags, config, and environment.
 *
 * Instances are passed to {@link Context.create} to build a {@link Context} for a single
 * invocation.
 */
export interface GlobalOptions {
  /** Directory that repositories live beneath. */
  baseDir?: string | undefined;
  /** Whether to colorise output: `auto`, `always` or `never`. */
  color?: ColorMode | undefined;
  /** Maximum repositories processed in parallel (`auto`, `unlimited` or a number). */
  concurrency?: string | undefined;
  /** Path to the configuration file, in place of the default. */
  config?: string | undefined;
  /** Provider host, for self-hosted instances. */
  host?: string | undefined;
  /** Never prompt; fail instead. Useful in scripts and CI. */
  noInput?: boolean | undefined;
  /** Organisation, group, or user that owns the repositories. */
  owner?: string | undefined;
  /** Provider name (e.g. `github` or `gitlab`). */
  provider?: string | undefined;
  /**
   * Aborted on SIGINT, so a sweep can wind down in-flight tasks instead of being killed outright.
   */
  signal?: AbortSignal | undefined;
}

/**
 * Shared state for a single CLI invocation.
 *
 * Values that require user input (base directory, owner) are resolved lazily so that commands which
 * do not need a workspace -- `config`, `tidy`, `pull` -- never trigger a prompt.
 */
export class Context {
  /**
   * Loads configuration and builds a {@link Context} for a single CLI invocation.
   *
   * @param [options] The options to be used.
   * @returns The constructed context, with the color mode applied as a side effect.
   */
  static async create(options: GlobalOptions = {}): Promise<Context> {
    const config = await Config.load(options.config ?? defaultConfigPath());
    const context = new Context(config, options);
    setColorMode(context.colorMode);
    return context;
  }

  /** The loaded configuration file for this invocation. */
  readonly config: Config;
  /** The global options this context was created from. */
  readonly options: GlobalOptions;

  #baseDir: string | undefined;
  #owner: string | undefined;
  #promptsDisabled = false;
  #protocol: Protocol | undefined;
  #provider: Provider | undefined;
  #providerId: string | undefined;
  #workspace: Workspace | undefined;

  /**
   * Creates a new {@link Context} instance with the specified `config` and global `options`.
   *
   * This is normally only used internally and for testing; typically {@link Context.create} should
   * be used to load the configuration and build a context for a single CLI invocation.
   *
   * @param config The loaded configuration file for this invocation.
   * @param [options] The options to be used.
   */
  constructor(config: Config, options: GlobalOptions = {}) {
    this.config = config;
    this.options = options;
  }

  /** The color mode in effect: the `--color` flag, falling back to `core.color`, then `auto`. */
  get colorMode(): ColorMode {
    return (this.options.color ?? this.config.get('core.color') ?? 'auto') as ColorMode;
  }

  /** The maximum number of repositories to process in parallel. */
  get concurrency(): number {
    if (this.options.concurrency !== undefined) {
      return resolveConcurrency(this.options.concurrency);
    }
    return this.config.getConcurrency();
  }

  /** The maximum number of output lines to show per repository. */
  get outputLines(): number {
    return this.config.getNumber('core.outputLines');
  }

  /** How repositories are arranged beneath the base directory. */
  get layout(): Layout {
    return (this.config.get('core.layout') ?? 'nested') as Layout;
  }

  /** Aborted when the user hits Ctrl-C, so a sweep can wind down gracefully. */
  get signal(): AbortSignal | undefined {
    return this.options.signal;
  }

  /**
   * Whether this run may prompt (i.e. prompts aren't disabled), `--no-input` wasn't set and stdio
   * is interactive.
   */
  get canPrompt(): boolean {
    return !this.#promptsDisabled && this.options.noInput !== true && isInteractive();
  }

  /**
   * Resolves the base directory, prompting and persisting it when unset.
   *
   * @returns The absolute path to the base directory, with `~` expanded to the user's home.
   */
  async baseDir(): Promise<string> {
    if (this.#baseDir !== undefined) return this.#baseDir;

    const fromFlag = this.options.baseDir;
    if (fromFlag !== undefined && fromFlag.length > 0) {
      this.#baseDir = path.resolve(expandHome(fromFlag));
      return this.#baseDir;
    }

    const configured = this.config.get('core.baseDir');
    if (configured !== undefined && configured.length > 0) {
      this.#baseDir = path.resolve(expandHome(configured));
      return this.#baseDir;
    }

    const answer = await this.#prompt('core.baseDir');
    this.#baseDir = path.resolve(expandHome(answer));
    // Store what the user typed so `~` stays portable across machines.
    await this.#persist('core.baseDir', answer);
    return this.#baseDir;
  }

  /**
   * Stops this run from ever prompting, as `--no-input` would.
   *
   * Used by machine-readable modes such as `gitx list --porcelain`, where a question would hang a
   * pipeline that has nobody watching it.
   */
  disablePrompts(): void {
    this.#promptsDisabled = true;
  }

  /**
   * Resolves the editor command, prompting and persisting it when unset.
   *
   * There is no neutral default to fall back to -- the right choice depends entirely on what you
   * use -- so an unattended run with nothing configured fails rather than guessing.
   * `$VISUAL`/`$EDITOR` are only ever a suggested starting point, since either may be set to a line
   * editor that has nothing to do with opening a whole repository.
   *
   * @param [repo] The repository to resolve a repo-scoped `core.editor` override for.
   * @param [fromFlag] A value from a command's own `--editor` flag, taking precedence over
   * everything else.
   * @returns The editor command.
   */
  async editor(repo?: string, fromFlag?: string): Promise<string> {
    if (fromFlag !== undefined && fromFlag.length > 0) return fromFlag;

    const configured = this.config.getForRepo('core', repo, 'editor');
    if (configured !== undefined && configured.length > 0) return configured;

    const suggestion = process.env['VISUAL'] ?? process.env['EDITOR'] ?? undefined;
    const answer = await this.#prompt('core.editor', suggestion);
    await this.#persist('core.editor', answer);
    return answer;
  }

  /**
   * The host for the selected provider, prompting and persisting when unset.
   *
   * @returns The host (e.g. `github.com` or `gitlab.com`).
   */
  async host(): Promise<string> {
    const id = await this.providerId();
    const fallback = providerInfo(id).defaultHost;

    const fromFlag = this.options.host;
    if (fromFlag !== undefined && fromFlag.length > 0) return fromFlag;

    const configured = this.config.getRaw(`${id}.host`);
    if (configured !== undefined && configured.length > 0) return configured;

    const answer = await this.#prompt(`${id}.host`, undefined, fallback);
    await this.#persist(`${id}.host`, answer);
    return answer;
  }

  /**
   * Resolves the owner, prompting and persisting it when unset.
   *
   * @returns The owner (e.g. `octocat` or `my-org`).
   */
  async owner(): Promise<string> {
    if (this.#owner !== undefined) return this.#owner;

    const fromFlag = this.options.owner;
    if (fromFlag !== undefined && fromFlag.length > 0) {
      this.#owner = fromFlag;
      return this.#owner;
    }

    const configured = this.config.get('remote.owner');
    if (configured !== undefined && configured.length > 0) {
      this.#owner = configured;
      return this.#owner;
    }

    // Suggest the signed-in account, which is right for personal repositories. A failure here is
    // not fatal: it only costs us the suggestion.
    const provider = await this.provider();
    const suggestion = await provider.currentLogin().catch(() => undefined);

    const answer = await this.#prompt('remote.owner', suggestion);
    this.#owner = answer;
    await this.#persist('remote.owner', answer);
    return answer;
  }

  /**
   * Resolves the clone protocol, prompting and persisting it when unset.
   *
   * Defaults to HTTPS rather than SSH: it works from anywhere without a key on the machine, and
   * `gitx auth login` has usually already taught git the credential it needs. SSH remains one
   * `gitx config set remote.protocol ssh` away for anyone who prefers it.
   *
   * @returns The protocol to use for cloning repositories.
   */
  async protocol(): Promise<Protocol> {
    if (this.#protocol !== undefined) return this.#protocol;

    // `getRaw`, not `get`: the schema fallback would answer the question for us.
    const configured = this.config.getRaw('remote.protocol');
    if (configured !== undefined && configured.length > 0) {
      this.#protocol = asProtocol(configured);
      return this.#protocol;
    }

    // Nobody to ask, so take the documented default rather than failing: a clone URL is something
    // we can always guess, unlike an owner.
    if (!this.canPrompt) {
      this.#protocol = asProtocol(this.config.get('remote.protocol') ?? 'https');
      return this.#protocol;
    }

    const answer = await this.#choose('remote.protocol', [
      { value: 'https', label: 'HTTPS', hint: 'works anywhere; uses your stored token' },
      { value: 'ssh', label: 'SSH', hint: 'needs a key on this machine' },
    ]);

    this.#protocol = asProtocol(answer);
    await this.#persist('remote.protocol', this.#protocol);
    return this.#protocol;
  }

  /**
   * The configured provider, ready to use.
   *
   * @returns The provider.
   */
  async provider(): Promise<Provider> {
    if (this.#provider) return this.#provider;

    // Sequential, never `Promise.all`: each step may prompt, and two prompts racing for stdin
    // submit one another without any input.
    const id = await this.providerId();
    const host = await this.host();

    this.#provider = createProvider(id, host);
    return this.#provider;
  }

  /**
   * Resolves which provider to talk to, prompting and persisting when unset.
   *
   * Resolved before the owner because the owner prompt suggests the signed-in account, and there is
   * no signed-in account until we know the provider.
   *
   * @returns The provider ID (e.g. `github` or `gitlab`).
   */
  async providerId(): Promise<string> {
    if (this.#providerId !== undefined) return this.#providerId;

    const fromFlag = this.options.provider;
    if (fromFlag !== undefined && fromFlag.length > 0) {
      this.#providerId = providerInfo(fromFlag).id;
      return this.#providerId;
    }

    // `getRaw`, not `get`: a schema fallback would silently answer the question, and the point is
    // to ask it once rather than assume any default provider.
    const configured = this.config.getRaw('remote.provider');
    if (configured !== undefined && configured.length > 0) {
      this.#providerId = providerInfo(configured).id;
      return this.#providerId;
    }

    const answer = await this.#choose(
      'remote.provider',
      PROVIDERS.map((provider) => ({
        value: provider.id,
        label: provider.label,
        hint: provider.defaultHost,
      })),
    );

    this.#providerId = answer;
    await this.#persist('remote.provider', answer);
    return answer;
  }

  /**
   * The login used to filter CI runs to your own.
   *
   * @returns The username or ID of the logged-in account, or `undefined` if not logged in.
   */
  async remoteUser(): Promise<string | undefined> {
    const configured = this.config.get('remote.user');
    if (configured !== undefined && configured.length > 0) return configured;

    const provider = await this.provider();
    return provider.currentLogin().catch(() => undefined);
  }

  /**
   * Names/globs that should be skipped for a given operation.
   *
   * @param operation The operation to look up the skip list for.
   * @returns The list of names/globs to skip.
   */
  skipList(operation: 'install' | 'update'): string[] {
    return this.config.getList(`skip.${operation}`);
  }

  /**
   * Builds the workspace, creating its root directory if necessary.
   *
   * @returns The workspace.
   */
  async workspace(): Promise<Workspace> {
    if (this.#workspace) return this.#workspace;

    // Resolved sequentially, never with `Promise.all`: both may prompt, and two concurrent prompts
    // fight over stdin, which submits one without any input.
    const baseDir = await this.baseDir();
    const owner = await this.owner();
    const workspace = new Workspace({ baseDir, owner, layout: this.layout });
    await workspace.ensureRoot();
    this.#workspace = workspace;
    return workspace;
  }

  async #choose(key: string, options: readonly SelectPromptOption[]): Promise<string> {
    const def = findKeyDef(key);

    if (!this.canPrompt) {
      const fallback = def?.fallback;
      if (fallback !== undefined) return fallback;
      throw this.#missing(key, def?.display);
    }

    return promptSelect({
      message: def?.prompt?.message ?? `Which ${displayName(key)} should gitx use?`,
      options,
      ...(def?.fallback === undefined ? {} : { initialValue: def.fallback }),
    });
  }

  #missing(key: string, display: string | undefined): GitxError {
    return new GitxError(`missing required config: ${key}`, {
      code: ExitCode.Config,
      hint: `Run \`gitx config set ${display ?? key} <value>\` or pass the matching flag.`,
    });
  }

  async #persist(key: string, value: string): Promise<void> {
    this.config.set(key, value);
    await this.config.save();
  }

  async #prompt(key: string, suggestion?: string, fallback?: string): Promise<string> {
    const def = findKeyDef(key);
    const message = def?.prompt?.message ?? `Which ${displayName(key)} should gitx use?`;

    // A fallback means the value is optional: we can carry on without asking.
    if (!this.canPrompt) {
      if (fallback !== undefined) return fallback;
      throw this.#missing(key, def?.display);
    }

    return promptText({
      message,
      placeholder: def?.prompt?.placeholder ?? fallback,
      initialValue: suggestion,
      defaultValue: fallback,
    });
  }
}
