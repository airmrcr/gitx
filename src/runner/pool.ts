import { toError } from '../util/errors.ts';
import { createRecord, type Task, type TaskContext, type TaskRecord } from './task.ts';

const normaliseConcurrency = (value: number | undefined, taskCount: number): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Math.max(1, taskCount);
  }
  return Math.max(1, Math.floor(value));
};

/**
 * Options for {@link runTasks}.
 */
export interface RunTasksOptions {
  /** Maximum tasks in flight. Use `Infinity` for unlimited. */
  concurrency?: number;
  /** Maximum output lines retained per task, to bound memory on huge runs. */
  maxLines?: number;
  /** Called once a task reaches a terminal state. */
  onComplete?: (record: TaskRecord) => void;
  /** Called just before a task starts. */
  onStart?: (record: TaskRecord) => void;
  /** Called whenever a record changes, for live rendering. */
  onUpdate?: (record: TaskRecord) => void;
  /**
   * Aborted to skip any tasks not yet started, and passed through to each task's
   * {@link TaskContext}.
   */
  signal?: AbortSignal | undefined;
}

/**
 * The outcome of running a set of tasks via {@link runTasks}.
 */
export interface RunTasksResult {
  /** Records for tasks that failed. */
  failed: TaskRecord[];
  /** Every task's record, in the original task order. */
  records: TaskRecord[];
  /** Records for tasks that were skipped. */
  skipped: TaskRecord[];
  /** Records for tasks that succeeded. */
  succeeded: TaskRecord[];
}

/**
 * Runs tasks with bounded concurrency, never rejecting: a task that throws is recorded as a failure
 * so one bad repository cannot abort the whole sweep.
 *
 * @param tasks The tasks to run.
 * @param [options] The options to be used.
 * @returns The records for every task, grouped by outcome.
 */
export const runTasks = async (
  tasks: readonly Task[],
  options: RunTasksOptions = {},
): Promise<RunTasksResult> => {
  const limit = normaliseConcurrency(options.concurrency, tasks.length);
  const maxLines = options.maxLines ?? 500;
  const records = tasks.map((task) => createRecord(task));

  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;

      const task = tasks[index]!;
      const record = records[index]!;

      if (options.signal?.aborted) {
        record.state = 'skipped';
        record.summary = 'cancelled';
        options.onComplete?.(record);
        continue;
      }

      record.state = 'running';
      record.startedAt = Date.now();
      options.onStart?.(record);
      options.onUpdate?.(record);

      const context: TaskContext = {
        log(line) {
          // Keep the tail; the head of a noisy install is rarely the interesting part.
          record.lines.push(line);
          if (record.lines.length > maxLines) record.lines.shift();
          options.onUpdate?.(record);
        },
        echo(command, args = []) {
          context.log(`+ ${[command, ...args].join(' ')}`);
        },
        setStatus(text) {
          record.status = text;
          options.onUpdate?.(record);
        },
        signal: options.signal ?? new AbortController().signal,
      };

      try {
        const result = await task.run(context);
        record.state = result.state;
        record.summary = result.summary;
        record.error = result.error;
        record.data = result.data;
      } catch (error) {
        record.state = 'failure';
        record.error = toError(error);
        record.summary ??= record.error.message;
      } finally {
        record.endedAt = Date.now();
        record.status = undefined;
        options.onUpdate?.(record);
        options.onComplete?.(record);
      }
    }
  };

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    records,
    succeeded: records.filter((record) => record.state === 'success'),
    failed: records.filter((record) => record.state === 'failure'),
    skipped: records.filter((record) => record.state === 'skipped'),
  };
};
