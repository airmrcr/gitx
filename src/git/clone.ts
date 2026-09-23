import { exec, type ExecResult } from '../util/exec.ts';

/**
 * Options for {@link cloneRepo}.
 */
export interface CloneRepoOptions {
  /** Invoked for every complete line emitted by `git clone`. */
  onLine?: ((line: string) => void) | undefined;
  /** Aborted to cancel the clone. */
  signal?: AbortSignal | undefined;
}

/**
 * Clones a repository with `git` directly.
 *
 * Submodules are initialised as part of the clone rather than afterwards, so an interrupted clone
 * leaves nothing half-configured.
 *
 * @param url The URL to clone from.
 * @param targetDir The directory to clone into.
 * @param [options] The options to be used.
 * @returns The captured result of the `git clone` command.
 */
export const cloneRepo = (
  url: string,
  targetDir: string,
  options: CloneRepoOptions = {},
): Promise<ExecResult> => {
  return exec('git', ['clone', '--recurse-submodules', url, targetDir], {
    // `--progress` is omitted deliberately: git only writes progress when it detects a terminal,
    // and the runner is capturing the output anyway.
    onLine: options.onLine ? (line) => options.onLine?.(line) : undefined,
    signal: options.signal,
  });
};
