// Public API surface.
//
// `gitx` is primarily a CLI, but the building blocks are exported so they can be scripted against
// or extended (for example, registering a new ecosystem).

export { Config, type ConfigListItem, defaultConfigPath, expandHome } from './config/store.ts';
export {
  CONFIG_KEYS,
  type ConfigKeyDef,
  type ConfigType,
  findKeyDef,
  PACKAGE_MANAGERS,
  type PackageManagerId,
  resolveConcurrency,
} from './config/schema.ts';
export { canonicalKey, formatIni, type IniEntry, parseIni, splitKey } from './config/ini.ts';

export { Context, type GlobalOptions } from './context.ts';

export { Git } from './git/git.ts';
export {
  filterRepos,
  isDirty,
  isGitWorkTree,
  type Layout,
  type Repo,
  statusPath,
  Workspace,
} from './git/repo.ts';

export { detectProject, ecosystems } from './ecosystem/registry.ts';
export { nodeEcosystem } from './ecosystem/node.ts';
export type {
  DetectedProject,
  Ecosystem,
  InstallOptions,
  InstallPlan,
  VoltaMode,
} from './ecosystem/types.ts';

export { installDependencies } from './ops/install.ts';
export { tidyRepo } from './ops/tidy.ts';

export { runTasks } from './runner/pool.ts';
export { createRenderer } from './runner/renderer.ts';
export { sweep } from './runner/sweep.ts';
export {
  outcome,
  type Task,
  type TaskContext,
  type TaskOutcome,
  type TaskRecord,
  type TaskState,
} from './runner/task.ts';

export { ExitCode, GitxError } from './util/errors.ts';
export { matchesAny, matchesGlob } from './util/match.ts';

export { createProgram, main } from './cli.ts';
