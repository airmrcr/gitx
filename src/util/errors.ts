/**
 * The type of the `ExitCode` object, which is a union of all its values. This allows for type-safe
 * usage of exit codes throughout gitx.
 */
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Options for constructing a `GitxError`.
 */
export interface GitxErrorOptions {
  /** The underlying cause of the error, if any. */
  cause?: unknown;
  /**
   * The exit code associated with the error.
   *
   * @default ExitCode.Usage
   */
  code?: ExitCode;
  /** Extra lines rendered beneath the message (e.g. captured stderr). */
  detail?: string;
  /** Actionable next step shown to the user. */
  hint?: string;
}

/**
 * Process exit codes used across the CLI. Loosely mirrors the conventions of the shell functions
 * `gitx` replaces, so muscle memory (and any scripts) survive.
 */
export const ExitCode = Object.freeze({
  /** Success. */
  Ok: 0,
  /** Generic usage or unhandled error. */
  Usage: 1,
  /** A required external command is missing from `PATH`. */
  MissingCommand: 2,
  /** A filesystem operation failed (e.g. creating the base directory). */
  Filesystem: 3,
  /** The configuration is invalid or a required value is missing. */
  Config: 4,
  /** No usable credential for the configured provider host. */
  Auth: 5,
  /** The user cancelled an interactive prompt or the run was interrupted. */
  Aborted: 130,
  /** One or more repositories failed to clone. */
  Clone: 16,
  /** Reserved for submodule-related failures. */
  Submodule: 17,
  /** One or more repositories failed to pull or update. */
  Pull: 18,
  /** The requested repository or resource could not be found. */
  NotFound: 19,
  /** One or more repositories failed to install dependencies. */
  Install: 32,
} as const);

/**
 * An error that carries a process exit code and optional user-facing hint.
 */
export class GitxError extends Error {
  /** The exit code associated with this error. */
  readonly code: ExitCode;
  /** Extra lines rendered beneath the message (e.g. captured stderr). */
  readonly detail: string | undefined;
  /** Actionable next step shown to the user. */
  readonly hint: string | undefined;

  /**
   * Creates a new {@link GitxError} instance with the specified `message` and `options`.
   *
   * @param message The error message.
   * @param [options] The options to be used.
   */
  constructor(message: string, options: GitxErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = 'GitxError';
    this.code = options.code ?? ExitCode.Usage;
    this.detail = options.detail;
    this.hint = options.hint;
  }
}

/**
 * Raised when the user cancels an interactive prompt.
 */
export class AbortError extends GitxError {
  /**
   * Creates a new {@link AbortError} instance with the specified `message`.
   *
   * @param [message] The error message.
   */
  constructor(message = 'Aborted.') {
    super(message, { code: ExitCode.Aborted });

    this.name = 'AbortError';
  }
}

/**
 * Checks whether a value is a {@link GitxError}.
 *
 * @param value The value to check.
 * @returns `true` if `value` is a {@link GitxError}; otherwise `false`.
 */
export const isGitxError = (value: unknown): value is GitxError => value instanceof GitxError;

/**
 * Coerces an unknown thrown value into an {@link Error}.
 *
 * @param value The value to coerce, typically caught from a `try`/`catch`.
 * @returns `value` unchanged if it is already an {@link Error}, otherwise a new {@link Error}
 * wrapping its string representation.
 */
export const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
