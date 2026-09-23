/**
 * A single unit of work run by {@link runTasks}.
 */
export interface Task {
  /** Stable identifier, typically the repository name. */
  id: string;
  /**
   * Runs the task, reporting progress via `context` and resolving with its outcome.
   *
   * @param context The current context for reporting progress.
   * @returns The result of running the task.
   */
  run: (context: TaskContext) => Promise<TaskOutcome>;
  /** Display name. */
  title: string;
}

/**
 * Facilities given to a running {@link Task} for reporting its progress.
 */
export interface TaskContext {
  /** Echoes a command, shell-style, into the task output. */
  echo: (command: string, args?: readonly string[]) => void;
  /** Records a line of output. Only the most recent lines are displayed. */
  log: (line: string) => void;
  /** Updates the short status label shown while the task runs. */
  setStatus: (text: string) => void;
  /** Aborted when the run is cancelled (e.g. Ctrl-C). */
  signal: AbortSignal;
}

/**
 * The result of running a {@link Task}.
 */
export interface TaskOutcome {
  /** Arbitrary payload for the command to aggregate once everything finishes. */
  data?: unknown;
  /** Populated for failures so the caller can print detail afterwards. */
  error?: Error | undefined;
  /** The terminal state the task finished in. */
  state: TerminalState;
  /** Short label rendered next to the task name (e.g. `up to date`). */
  summary?: string | undefined;
}

/**
 * The live, mutable state of a {@link Task} as it runs, as created by {@link createRecord}.
 */
export interface TaskRecord {
  /** Arbitrary payload for the command to aggregate once everything finishes. */
  data: unknown;
  /** When the task reached a terminal state, as an epoch timestamp in milliseconds. */
  endedAt: number | undefined;
  /** Populated for failures so the caller can print detail afterwards. */
  error: Error | undefined;
  /** Stable identifier, typically the repository name. */
  id: string;
  /** Every line the task emitted, in order. */
  lines: string[];
  /** When the task started running, as an epoch timestamp in milliseconds. */
  startedAt: number | undefined;
  /** The task's current lifecycle state. */
  state: TaskState;
  /** Short status label while running. */
  status: string | undefined;
  /** Short label rendered next to the task name (e.g. `up to date`). */
  summary: string | undefined;
  /** Display name. */
  title: string;
}

/**
 * The lifecycle states a task can be in.
 */
export type TaskState = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

/**
 * The states a task can finish in.
 */
export type TerminalState = Extract<TaskState, 'success' | 'failure' | 'skipped'>;

/** Convenience helpers so task bodies read declaratively. */
export const outcome = {
  /**
   * Builds a failed {@link TaskOutcome}.
   *
   * @param [summary] Short label rendered next to the task name.
   * @param [error] The error that caused the failure.
   * @param [data] Arbitrary payload for the command to aggregate once everything finishes.
   * @returns A `failure` outcome.
   */
  failure: (summary?: string, error?: Error, data?: unknown): TaskOutcome => ({
    state: 'failure',
    summary,
    error,
    data,
  }),
  /**
   * Builds a skipped {@link TaskOutcome}.
   *
   * @param [summary] Short label rendered next to the task name.
   * @param [data] Arbitrary payload for the command to aggregate once everything finishes.
   * @returns A `skipped` outcome.
   */
  skipped: (summary?: string, data?: unknown): TaskOutcome => ({ state: 'skipped', summary, data }),
  /**
   * Builds a successful {@link TaskOutcome}.
   *
   * @param [summary] Short label rendered next to the task name.
   * @param [data] Arbitrary payload for the command to aggregate once everything finishes.
   * @returns A `success` outcome.
   */
  success: (summary?: string, data?: unknown): TaskOutcome => ({ state: 'success', summary, data }),
};

/**
 * Builds the initial, pending record for a task.
 *
 * @param task The task to build a record for.
 * @returns A new {@link TaskRecord} in the `pending` state.
 */
export const createRecord = (task: Task): TaskRecord => ({
  id: task.id,
  title: task.title,
  state: 'pending',
  summary: undefined,
  status: undefined,
  lines: [],
  error: undefined,
  data: undefined,
  startedAt: undefined,
  endedAt: undefined,
});

/**
 * The duration a task has run for, so far or in total.
 *
 * @param record The record to measure.
 * @returns The elapsed milliseconds, or `0` if the task has not started.
 */
export const elapsed = (record: TaskRecord): number => {
  if (record.startedAt === undefined) return 0;
  return (record.endedAt ?? Date.now()) - record.startedAt;
};
