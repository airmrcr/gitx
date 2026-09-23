import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/store.ts';
import { detectProject } from '../ecosystem/registry.ts';
import type { InstallCommand, VoltaMode } from '../ecosystem/types.ts';
import { Git } from '../git/git.ts';
import type { TaskContext } from '../runner/task.ts';
import { exec, type ExecResult } from '../util/exec.ts';

const restoreLockFile = async (dir: string, lockFile: string, task: TaskContext): Promise<void> => {
  const git = new Git({ cwd: dir });
  task.echo('git', ['checkout', '--', lockFile]);

  const result = await git.run(['checkout', '--', lockFile]);
  if (result.ok) return;

  if (/did not match any file\(s\) known to git/i.test(result.stderr)) {
    task.echo('rm', ['-f', lockFile]);
    await rm(path.join(dir, lockFile), { force: true });
    return;
  }

  for (const line of result.stderr.split('\n')) {
    if (line.trim().length > 0) task.log(line);
  }
};

const runInstall = (
  command: InstallCommand,
  dir: string,
  task: TaskContext,
): Promise<ExecResult> => {
  task.echo(command.command, command.args);
  return exec(command.command, command.args, {
    cwd: dir,
    env: command.env,
    signal: task.signal,
    onLine: (line) => task.log(line),
  });
};

/**
 * Options for {@link installDependencies}.
 */
export interface InstallDependenciesOptions {
  /** Force a clean/frozen install regardless of configuration. */
  clean?: boolean;
  /** The loaded configuration. */
  config: Config;
  /** The repository's working directory. */
  dir: string;
  /** The running task, for reporting progress. */
  task: TaskContext;
}

/**
 * The result of installing a repository's dependencies.
 */
export interface InstallOutcome {
  /** The package manager that was used, when one was found. */
  manager?: string;
  /** Short human-readable explanation (e.g. `no package manager`). */
  reason?: string;
  /** The state the install finished in. */
  state: InstallState;
}

/**
 * The outcome states an install can finish in.
 */
export type InstallState = 'installed' | 'skipped' | 'failed';

/**
 * Installs a repository's dependencies.
 *
 * Repositories without a recognised project, or whose package manager is not installed, are skipped
 * rather than failed -- a machine missing `yarn` should not break a sweep across a hundred
 * repositories.
 *
 * @param options The options to be used.
 * @returns The outcome of the install.
 */
export const installDependencies = async (
  options: InstallDependenciesOptions,
): Promise<InstallOutcome> => {
  const { config, dir, task } = options;
  const repo = path.basename(dir);

  const project = await detectProject(dir);
  if (!project) return { state: 'skipped', reason: 'no recognised project' };

  const { manager } = project;

  if (!config.getInstallBoolean('enabled', manager, repo)) {
    return { state: 'skipped', reason: `${manager} disabled`, manager };
  }

  if (!project.available) {
    return { state: 'skipped', reason: `${manager} not installed`, manager };
  }

  const frozen = options.clean === true || config.getInstallBoolean('frozen', manager, repo);
  const plan = project.plan({
    frozen,
    volta: (config.get('install.volta') ?? 'auto') as VoltaMode,
    extraArgs: config.getList(`install.${manager}args`),
  });

  task.setStatus(`installing (${manager})`);

  let result = await runInstall(plan, dir, task);

  // A frozen install fails hard when the lock file has drifted from the manifest. Retrying unfrozen
  // keeps a sweep moving.
  if (!result.ok && plan.fallback && config.getBoolean('install.frozenFallback')) {
    task.log('frozen install failed, retrying with a regular install');
    result = await runInstall(plan.fallback, dir, task);
  }

  if (!result.ok) {
    return {
      state: 'failed',
      reason: `${manager} install exited with ${result.exitCode}`,
      manager,
    };
  }

  if (project.lockFile && config.getInstallBoolean('restorelockfile', manager, repo)) {
    await restoreLockFile(dir, project.lockFile, task);
  }

  return { state: 'installed', manager };
};
