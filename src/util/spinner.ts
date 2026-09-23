import { createLogUpdate } from 'log-update';
import { SPINNER_FRAMES, theme } from './theme.ts';

/**
 * A running spinner, as returned by {@link createSpinner}.
 */
export interface Spinner {
  /** Changes the message shown beside the spinner. */
  message: (text: string) => void;
  /** Stops the spinner and erases it, leaving nothing behind. */
  stop: () => void;
}

/**
 * Options controlling where and how a {@link Spinner} is drawn.
 */
export interface SpinnerOptions {
  /** Overrides TTY detection, mainly for tests. */
  interactive?: boolean;
  /** Frame interval in milliseconds. */
  interval?: number;
  /**
   * Where the spinner is drawn. Defaults to stderr so stdout stays pipeable.
   *
   * @default process.stderr
   */
  stream?: NodeJS.WriteStream;
}

/**
 * Draws an indeterminate spinner while something slow happens.
 *
 * It writes to stderr and erases itself when stopped, so a command can spin without touching its
 * real output. Off a TTY it does nothing at all rather than spraying frames into a log file.
 *
 * @param text The initial message shown beside the spinner.
 * @param [options] The options to be used.
 * @returns A {@link Spinner} controlling the running spinner, or a no-op one if not interactive.
 */
export const createSpinner = (text: string, options: SpinnerOptions = {}): Spinner => {
  const stream = options.stream ?? process.stderr;
  const interactive = options.interactive ?? Boolean(stream.isTTY);

  if (!interactive) {
    return { message: () => {}, stop: () => {} };
  }

  const logUpdate = createLogUpdate(stream, { showCursor: false });
  let label = text;
  let frame = 0;

  const render = () => {
    const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!;
    frame += 1;
    logUpdate(`${theme.count(spinner)} ${theme.muted(label)}`);
  };

  render();
  const timer = setInterval(render, options.interval ?? 80);
  // The spinner must never be the reason the process stays alive.
  timer.unref?.();

  let stopped = false;
  return {
    message(next: string) {
      label = next;
      if (!stopped) render();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      logUpdate.clear();
      logUpdate.done();
    },
  };
};

/**
 * Runs `action` with a spinner, stopping it however the action ends.
 *
 * @param text The initial message shown beside the spinner.
 * @param action The action to run, given the {@link Spinner} to update as it progresses.
 * @param [options] The options to be used.
 * @returns The result of `action`.
 */
export const withSpinner = async <T>(
  text: string,
  action: (spinner: Spinner) => Promise<T>,
  options: SpinnerOptions = {},
): Promise<T> => {
  const spinner = createSpinner(text, options);
  try {
    return await action(spinner);
  } finally {
    spinner.stop();
  }
};
