import cliTruncate from 'cli-truncate';
import { createLogUpdate } from 'log-update';
import { formatDuration, SPINNER_FRAMES, stripAnsi, symbols, theme } from '../util/theme.ts';
import { elapsed, type TaskRecord, type TaskState } from './task.ts';

const createPlainRenderer = (stream: NodeJS.WriteStream): Renderer => {
  return {
    start() {
      // No live region to set up
    },
    update() {
      // Progress is only reported on completion
    },
    complete(record: TaskRecord) {
      stream.write(`${summaryLine(record)}\n`);
    },
    stop() {
      // Nothing to tear down
    },
  };
};

const stateSymbol = (state: TaskState): string => {
  switch (state) {
    case 'success':
      return theme.success(symbols.success);
    case 'failure':
      return theme.failure(symbols.failure);
    case 'skipped':
      return theme.skip(symbols.skipped);
    default:
      return theme.muted(symbols.pending);
  }
};

const tail = <T>(items: readonly T[], count: number): T[] =>
  count <= 0 ? [] : items.slice(-count);

/**
 * A live renderer of parallel task progress, as returned by {@link createRenderer}.
 */
export interface Renderer {
  /** Notifies the renderer that a task has reached a terminal state. */
  complete: (record: TaskRecord) => void;
  /** Begins rendering for a run of `total` tasks. */
  start: (total: number) => void;
  /** Stops rendering and tears down the live region, if any. */
  stop: () => void;
  /** Notifies the renderer that a task's record has changed. */
  update: (record: TaskRecord) => void;
}

/**
 * Options for {@link createRenderer}.
 */
export interface RendererOptions {
  /** Overrides TTY detection, mainly for tests. */
  interactive?: boolean;
  /** Frame interval in milliseconds. */
  interval?: number;
  /** Maximum in-flight tasks rendered at once, to avoid overflowing the terminal. */
  maxVisible?: number;
  /** Trailing output lines shown beneath each in-flight task. */
  outputLines?: number;
  /**
   * Where the renderer draws.
   *
   * @default process.stdout
   */
  stream?: NodeJS.WriteStream;
}

/**
 * Renders parallel task progress.
 *
 * On a TTY, in-flight tasks occupy a live region at the bottom of the screen showing a spinner and
 * the tail of their output; finished tasks are flushed above it as permanent one-line summaries.
 * Without a TTY (CI, pipes) we simply print a summary line per task as it finishes, keeping logs
 * grep-friendly.
 *
 * @param [options] The options to be used.
 * @returns A {@link Renderer} to drive as tasks start, update and complete.
 */
export const createRenderer = (options: RendererOptions = {}): Renderer => {
  const stream = options.stream ?? process.stdout;
  const interactive = options.interactive ?? Boolean(stream.isTTY);
  const outputLines = Math.max(0, options.outputLines ?? 1);
  const maxVisible = Math.max(1, options.maxVisible ?? 10);
  const interval = options.interval ?? 80;

  if (!interactive) return createPlainRenderer(stream);

  const logUpdate = createLogUpdate(stream, { showCursor: false });
  const running = new Map<string, TaskRecord>();

  let total = 0;
  let finished = 0;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;

  const width = () => stream.columns ?? 80;

  const render = () => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    const spinner = SPINNER_FRAMES[frame]!;
    const lines: string[] = [];

    const visible = [...running.values()].slice(0, maxVisible);

    for (const record of visible) {
      const parts = [
        theme.count(spinner),
        theme.repo(record.title),
        record.status ? theme.muted(record.status) : '',
        theme.muted(formatDuration(elapsed(record))),
      ].filter(Boolean);

      lines.push(cliTruncate(parts.join(' '), width(), { position: 'end' }));

      for (const line of tail(record.lines, outputLines)) {
        lines.push(cliTruncate(`   ${theme.muted(stripAnsi(line))}`, width(), { position: 'end' }));
      }
    }

    const hidden = running.size - visible.length;
    if (hidden > 0) {
      lines.push(theme.muted(`   …and ${hidden} more`));
    }

    if (total > 0) {
      lines.push(
        theme.muted(`${symbols.bullet} ${finished}/${total} complete, ${running.size} running`),
      );
    }

    logUpdate(lines.join('\n'));
  };

  const ensureTimer = () => {
    timer ??= setInterval(render, interval).unref();
  };

  return {
    start(taskTotal: number) {
      total = taskTotal;
      finished = 0;
      ensureTimer();
      render();
    },

    update(record: TaskRecord) {
      if (record.state === 'running') {
        running.set(record.id, record);
      } else {
        running.delete(record.id);
      }
    },

    complete(record: TaskRecord) {
      running.delete(record.id);
      finished += 1;
      // Clear the live region, emit a permanent summary, then redraw.
      logUpdate.clear();
      stream.write(`${summaryLine(record)}\n`);
      render();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      logUpdate.clear();
      logUpdate.done();
    },
  };
};

/**
 * Formats an ISO timestamp as a short "time ago" string.
 *
 * @param iso ISO 8601 timestamp to format.
 * @param [now] Reference time to compute the difference from.
 * @returns The formatted relative time, or `'unknown'` if `iso` cannot be parsed.
 */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return 'unknown';

  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
};

/**
 * Returns a one-line result for a finished task.
 *
 * @param record The task record to summarise.
 * @returns The rendered, themed summary line.
 */
export const summaryLine = (record: TaskRecord): string => {
  const icon = stateSymbol(record.state);
  const detail = record.summary ? ` ${theme.muted(record.summary)}` : '';
  const duration =
    record.startedAt === undefined ? '' : ` ${theme.muted(formatDuration(elapsed(record)))}`;
  return `${icon} ${theme.repo(record.title)}${detail}${duration}`;
};
