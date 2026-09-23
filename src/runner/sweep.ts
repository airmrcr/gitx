import type { Context } from '../context.ts';
import { theme } from '../util/theme.ts';
import { runTasks, type RunTasksResult } from './pool.ts';
import { createRenderer } from './renderer.ts';
import type { Task, TaskRecord } from './task.ts';

/**
 * A set of labelled counts shown in the closing summary (e.g. `{ cloned: 3, skipped: 1 }`).
 */
export interface SummaryCounts {
  [label: string]: number;
}

/**
 * Options for {@link sweep}.
 */
export interface SweepOptions {
  /** The shared context the tasks run against. */
  context: Context;
  /** Printed when there is nothing to do. */
  emptyMessage?: string;
  /** Aborted to cancel any tasks not yet started. */
  signal?: AbortSignal | undefined;
  /**
   * Where output is written.
   *
   * @default process.stdout
   */
  stream?: NodeJS.WriteStream;
  /** The per-repository tasks to run. */
  tasks: readonly Task[];
}

/**
 * Renders the closing `Done!` banner with a count breakdown.
 *
 * @param counts The labelled counts to display; zero values are omitted.
 * @param [stream=process.stdout] Where to write the summary.
 */
export const printSummary = (
  counts: SummaryCounts,
  stream: NodeJS.WriteStream = process.stdout,
): void => {
  const parts = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([label, value]) => `${label}: ${theme.count(String(value))}`);

  stream.write(`\n${theme.bold('Done!')}\n`);
  stream.write(
    `${parts.length > 0 ? parts.join(theme.muted(' | ')) : theme.muted('nothing to do')}\n`,
  );
};

/**
 * Prints the captured output of every failed task, after the live region is gone.
 *
 * @param failed The failed task records to report.
 * @param stream Where to write the report.
 */
export const reportFailures = (failed: readonly TaskRecord[], stream: NodeJS.WriteStream): void => {
  if (failed.length === 0) return;

  stream.write(`\n${theme.failure(`${failed.length} failed:`)}\n`);

  for (const record of failed) {
    stream.write(`\n${theme.failure('✖')} ${theme.repo(record.title)}\n`);
    if (record.summary) stream.write(`  ${theme.muted(record.summary)}\n`);

    for (const line of record.lines.slice(-20)) {
      stream.write(`  ${theme.muted(line)}\n`);
    }

    if (record.error && !record.lines.some((line) => line.includes(record.error!.message))) {
      stream.write(`  ${theme.muted(record.error.message)}\n`);
    }
  }
};

/**
 * Runs a set of per-repository tasks in parallel with live rendering, then reports any failures in
 * full.
 *
 * @param options The options to be used.
 * @returns The records for every task, grouped by outcome.
 */
export const sweep = async (options: SweepOptions): Promise<RunTasksResult> => {
  const stream = options.stream ?? process.stdout;

  if (options.tasks.length === 0) {
    if (options.emptyMessage) stream.write(`${theme.muted(options.emptyMessage)}\n`);
    return { records: [], succeeded: [], failed: [], skipped: [] };
  }

  const renderer = createRenderer({
    stream,
    outputLines: options.context.outputLines,
  });

  renderer.start(options.tasks.length);

  let result: RunTasksResult;
  try {
    result = await runTasks(options.tasks, {
      concurrency: options.context.concurrency,
      signal: options.signal,
      onUpdate: (record) => renderer.update(record),
      onComplete: (record) => renderer.complete(record),
    });
  } finally {
    renderer.stop();
  }

  reportFailures(result.failed, stream);
  return result;
};
