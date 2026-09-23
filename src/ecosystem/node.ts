import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasExecutable } from '../util/exec.ts';
import type {
  DetectedProject,
  Ecosystem,
  InstallCommand,
  InstallOptions,
  InstallPlan,
  VoltaMode,
} from './types.ts';

interface PackageJson {
  packageManager?: string;
  volta?: Record<string, string>;
}

const LOCK_FILES: Record<NodePackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
};

const applyVolta = (
  command: InstallCommand,
  mode: VoltaMode,
  hasVolta: boolean,
): InstallCommand => {
  // Volta works by putting shims on PATH, so `auto` simply runs the tool directly and lets any shim
  // do its job. We never require Volta to be installed.
  if (mode === 'never') {
    return { ...command, env: { ...process.env, VOLTA_BYPASS: '1' } };
  }
  if (mode === 'always' && hasVolta) {
    return { command: 'volta', args: ['run', command.command, ...command.args], env: command.env };
  }
  return command;
};

const buildArgs = (
  manager: NodePackageManager,
  berry: boolean,
): { frozen: string[]; plain: string[] } => {
  switch (manager) {
    case 'npm':
      return {
        frozen: ['ci', '--no-audit', '--no-fund'],
        plain: ['install', '--no-audit', '--no-fund'],
      };
    case 'pnpm':
      return { frozen: ['install', '--frozen-lockfile'], plain: ['install'] };
    case 'yarn':
      return {
        frozen: berry ? ['install', '--immutable'] : ['install', '--frozen-lockfile'],
        plain: ['install'],
      };
  }
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const fromLockFile = async (dir: string): Promise<NodePackageManager | undefined> => {
  // pnpm first, then yarn, then npm: a repo migrating between managers often leaves a stale
  // package-lock.json behind.
  for (const manager of ['pnpm', 'yarn', 'npm'] as const) {
    if (await exists(path.join(dir, LOCK_FILES[manager]))) return manager;
  }
  return undefined;
};

const fromPackageManagerField = (pkg: PackageJson | undefined): NodePackageManager | undefined => {
  const field = pkg?.packageManager;
  if (typeof field !== 'string') return undefined;
  const name = field.split('@')[0]?.trim().toLowerCase();
  return name !== undefined && isNodePackageManager(name) ? name : undefined;
};

const fromVoltaField = (pkg: PackageJson | undefined): NodePackageManager | undefined => {
  const volta = pkg?.volta;
  if (typeof volta !== 'object' || volta === null) return undefined;
  // Checked in priority order so a repo pinning both npm and pnpm behaves predictably.
  return NODE_PACKAGE_MANAGERS.find((manager) => typeof volta[manager] === 'string');
};

const isNodePackageManager = (value: string): value is NodePackageManager =>
  (NODE_PACKAGE_MANAGERS as readonly string[]).includes(value);

const isYarnBerry = async (dir: string, pkg: PackageJson | undefined): Promise<boolean> => {
  // Yarn Berry (v2+) uses `--immutable` where Yarn Classic uses `--frozen-lockfile`.
  if (await exists(path.join(dir, '.yarnrc.yml'))) return true;

  const field = pkg?.packageManager;
  if (typeof field === 'string' && field.startsWith('yarn@')) {
    const major = Number.parseInt(field.slice('yarn@'.length), 10);
    if (!Number.isNaN(major)) return major >= 2;
  }

  return false;
};

const readPackageJson = async (dir: string): Promise<PackageJson | undefined> => {
  try {
    const text = await readFile(path.join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : {};
  } catch {
    // A malformed package.json still means "this is a Node project"; fall back to lock-file based
    // detection rather than failing the whole run.
    return undefined;
  }
};

/**
 * One of the {@link NODE_PACKAGE_MANAGERS}.
 */
export type NodePackageManager = (typeof NODE_PACKAGE_MANAGERS)[number];

/**
 * Package managers supported by {@link nodeEcosystem}, in lock-file detection priority order.
 */
export const NODE_PACKAGE_MANAGERS = Object.freeze(['npm', 'pnpm', 'yarn'] as const);

/** Detects Node.js projects and how their dependencies should be installed. */
export const nodeEcosystem: Ecosystem = {
  id: 'node',

  async detect(dir: string): Promise<DetectedProject | undefined> {
    if (!(await exists(path.join(dir, 'package.json')))) return undefined;

    const pkg = await readPackageJson(dir);

    const manager =
      fromPackageManagerField(pkg) ?? fromVoltaField(pkg) ?? (await fromLockFile(dir)) ?? 'npm';

    const lockFile = LOCK_FILES[manager];
    const hasLockFile = await exists(path.join(dir, lockFile));
    const berry = manager === 'yarn' && (await isYarnBerry(dir, pkg));

    return {
      ecosystem: 'node',
      manager,
      lockFile,
      hasLockFile,
      available: hasExecutable(manager),
      plan(options: InstallOptions): InstallPlan {
        const hasVolta = hasExecutable('volta');
        const { frozen, plain } = buildArgs(manager, berry);

        // A frozen install is only meaningful when there is a lock file to freeze.
        const useFrozen = options.frozen && hasLockFile;
        const chosen = useFrozen ? frozen : plain;

        const primary = applyVolta(
          { command: manager, args: [...chosen, ...options.extraArgs] },
          options.volta,
          hasVolta,
        );

        if (!useFrozen) return primary;

        return {
          ...primary,
          fallback: applyVolta(
            { command: manager, args: [...plain, ...options.extraArgs] },
            options.volta,
            hasVolta,
          ),
        };
      },
    };
  },
};
