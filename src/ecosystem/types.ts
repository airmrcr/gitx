/**
 * A project an {@link Ecosystem} recognises, able to build its own install plan.
 */
export interface DetectedProject {
  /** False when the manager's binary could not be found on PATH. */
  available: boolean;
  /** Ecosystem identifier (e.g. `node`). */
  ecosystem: string;
  /** Whether the lock file is actually present. */
  hasLockFile: boolean;
  /** Lock file name relative to the project root, when one is used. */
  lockFile?: string | undefined;
  /** Tool identifier (e.g. `npm`, `pnpm`, `yarn`). */
  manager: string;
  /**
   * Builds the command used to install dependencies.
   *
   * @param options The options to be used.
   * @returns The dependency installation plan.
   */
  plan: (options: InstallOptions) => InstallPlan;
}

/**
 * An ecosystem abstraction.
 *
 * `gitx` currently only knows how to install Node.js dependencies, but the surface here is
 * deliberately language-agnostic so that Go modules, Cargo crates and friends can be added without
 * touching any command code.
 */
export interface Ecosystem {
  /**
   * Returns a project descriptor, or `undefined` when this ecosystem does not apply.
   *
   * @param dir The directory to detect the project in.
   * @returns A descriptor for the detected project, if any.
   */
  detect: (dir: string) => Promise<DetectedProject | undefined>;
  /** Ecosystem identifier (e.g. `node`). */
  id: string;
}

/**
 * A command that installs a project's dependencies.
 */
export interface InstallCommand {
  /** Arguments to pass to `command`. */
  args: string[];
  /** The executable to run. */
  command: string;
  /** Environment variables for the install process. */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Options for installing a project's dependencies.
 */
export interface InstallOptions {
  /** Extra arguments appended verbatim to the install command. */
  extraArgs: readonly string[];
  /** Prefer a reproducible install (`npm ci`, `pnpm --frozen-lockfile`, ...). */
  frozen: boolean;
  /** How to interact with Volta, if it is installed. */
  volta: VoltaMode;
}

/**
 * An {@link InstallCommand}, with an optional fallback for a failed frozen install.
 */
export interface InstallPlan extends InstallCommand {
  /**
   * A non-frozen retry, used when a frozen install fails because the lock file has drifted from the
   * manifest.
   */
  fallback?: InstallCommand | undefined;
}

/**
 * How to interact with Volta, if it is installed.
 */
export type VoltaMode = 'auto' | 'always' | 'never';
