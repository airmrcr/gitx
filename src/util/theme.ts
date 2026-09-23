import picocolors from 'picocolors';

let enabled = picocolors.isColorSupported;

// Built with colour forced on: `enabled` decides whether the styles are applied, so picocolors must
// never second-guess us by detecting a non-TTY stdout.
const pc = picocolors.createColors(true);

const detect = (env: NodeJS.ProcessEnv): boolean => {
  if (env['NO_COLOR']) return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0' && force !== 'false';
  return picocolors.isColorSupported;
};

const style =
  (fn: (text: string) => string) =>
  (text: string): string =>
    enabled ? fn(text) : text;

/**
 * How output should be colourised: `auto` detects support, `always`/`never` force it.
 */
export type ColorMode = 'auto' | 'always' | 'never';

/** Frames for the in-flight task spinner. */
export const SPINNER_FRAMES = Object.freeze([
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const);

/** Status icons used alongside {@link theme} colours. */
export const symbols = Object.freeze({
  /** A list item marker. */
  bullet: '›',
  /** A failed item. */
  failure: '✖',
  /** An item not yet started. */
  pending: '○',
  /** An item currently in progress. */
  running: '◐',
  /** A skipped item. */
  skipped: '⊘',
  /** A successfully completed item. */
  success: '✔',
});

/** Semantic colours, so command code never reaches for raw ANSI. */
export const theme = Object.freeze({
  /** Emphasised text. */
  bold: style(pc.bold),
  /** Branch names. */
  branch: style(pc.magenta),
  /** Echoed shell commands. */
  command: style(pc.dim),
  /** Counts and numbers. */
  count: style(pc.cyan),
  /** Failed outcomes. */
  failure: style(pc.red),
  /** Section headings. */
  heading: style((text) => pc.bold(pc.white(text))),
  /** Links. */
  link: style(pc.underline),
  /** De-emphasised, secondary text. */
  muted: style(pc.gray),
  /** Repository names. */
  repo: style(pc.blue),
  /** Skipped items. */
  skip: style(pc.yellow),
  /** Successful outcomes. */
  success: style(pc.green),
  /** Warnings. */
  warn: style(pc.yellow),
});

/**
 * Renders a command the way a shell would echo it, for transparency.
 *
 * @param command The command to render.
 * @param [args] Arguments to render alongside the command.
 * @returns The rendered, themed command line, with any arguments needing it quoted.
 */
export const formatCommand = (command: string, args: readonly string[] = []): string => {
  const rendered = [command, ...args]
    .map((part) => (/[\s"'$&|<>()]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
  return theme.command(`+ ${rendered}`);
};

/**
 * Formats a duration for display, choosing a unit based on its magnitude.
 *
 * @param milliseconds The duration to format.
 * @returns The formatted duration, e.g. `"500ms"`, `"1.2s"` or `"2m03s"`.
 */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
};

/**
 * Checks whether styles are currently applied, as set by {@link setColorMode}.
 *
 * @returns `true` if output is currently colourised; otherwise `false`.
 */
export const isColorEnabled = (): boolean => enabled;

/**
 * Applies the `core.color` setting, honouring `NO_COLOR`/`FORCE_COLOR` in auto mode.
 *
 * @param mode The color mode to apply.
 * @param [env=process.env] Environment to read `NO_COLOR`/`FORCE_COLOR` from in `auto` mode.
 */
export const setColorMode = (mode: ColorMode, env: NodeJS.ProcessEnv = process.env): void => {
  switch (mode) {
    case 'always':
      enabled = true;
      break;
    case 'never':
      enabled = false;
      break;
    case 'auto':
      enabled = detect(env);
      break;
  }
};

/**
 * Removes ANSI escape codes from text.
 *
 * @param text The text to strip.
 * @returns `text` with any ANSI escape codes removed.
 */
export const stripAnsi = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[\d;]*m/g, '');
};
