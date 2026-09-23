import type { Git } from '../git/git.ts';
import type { TaskContext } from '../runner/task.ts';

/**
 * Options for {@link tidyRepo}.
 */
export interface TidyOptions {
  /**
   * Whether to fetch from the remote before tidying.
   *
   * @default true
   */
  fetch?: boolean;
}

/**
 * The outcome of {@link tidyRepo}.
 */
export interface TidyResult {
  /** Branches that were successfully deleted. */
  deleted: string[];
  /** Branches that failed to delete. */
  failed: string[];
}

/**
 * Deletes local branches whose upstream has been deleted.
 *
 * This is the `git tidy` alias, reimplemented natively so it works without any local git
 * configuration.
 *
 * @param git The repository to tidy.
 * @param task The running task, for reporting progress.
 * @param [options] The options to be used.
 * @returns Which branches were deleted, and which failed to delete.
 */
export const tidyRepo = async (
  git: Git,
  task: TaskContext,
  options: TidyOptions = {},
): Promise<TidyResult> => {
  if (options.fetch !== false) {
    task.setStatus('fetching');
    task.echo('git', ['fetch', '--prune']);
    await git.fetch({ prune: true });
  }

  const branches = await git.goneBranches();
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const branch of branches) {
    task.setStatus(`deleting ${branch}`);
    task.echo('git', ['branch', '-D', branch]);

    const result = await git.deleteBranch(branch, { force: true });
    if (result.ok) {
      deleted.push(branch);
      for (const line of result.stdout.split('\n')) {
        if (line.trim().length > 0) task.log(line);
      }
    } else {
      failed.push(branch);
      task.log(result.stderr.trim() || `failed to delete ${branch}`);
    }
  }

  return { deleted, failed };
};
