import { isCancel, select, text } from '@clack/prompts';
import { AbortError } from './errors.ts';

/**
 * A single choice offered by {@link promptSelect}.
 */
export interface SelectPromptOption {
  /** Extra text shown alongside the label. */
  hint?: string | undefined;
  /** The label shown to the user. */
  label: string;
  /** The value returned when this option is chosen. */
  value: string;
}

/**
 * Options for {@link promptSelect}.
 */
export interface SelectPromptOptions {
  /** The option value highlighted by default. */
  initialValue?: string | undefined;
  /** The question shown to the user. */
  message: string;
  /** The choices offered to the user. */
  options: readonly SelectPromptOption[];
}

/**
 * Options for {@link promptText}.
 */
export interface TextPromptOptions {
  /**
   * Accepted when the user submits an empty line.
   *
   * Preferred over `initialValue` for values that already have a sensible answer: the suggestion is
   * shown but the field starts empty, so pressing Enter takes the default while typing does not
   * mean editing around text that was put there.
   */
  defaultValue?: string | undefined;
  /** Pre-filled into the field, as if the user had typed it. */
  initialValue?: string | undefined;
  /** The question shown to the user. */
  message: string;
  /** Grey example text shown when the field is empty. */
  placeholder?: string | undefined;
  /** Validates the trimmed input, returning an error message or `undefined` when it is valid. */
  validate?: ((value: string) => string | undefined) | undefined;
}

/**
 * Checks whether it's reasonable to ask the user a question.
 *
 * Deliberately gated on stderr rather than stdout: that is where prompts are drawn, so
 * `gitx list --porcelain | xargs …` can still ask for a missing setting without the question ending
 * up in the piped output.
 *
 * @param [input=process.stdin] The stream checked for an interactive terminal.
 * @param [output=process.stderr] The stream prompts are drawn to, also checked for an interactive
 * terminal.
 * @returns `true` if both `input` and `output` are TTYs and we are not running in CI; otherwise
 * `false`.
 */
export const isInteractive = (
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): boolean => Boolean(input.isTTY && output.isTTY) && process.env['CI'] !== 'true';

/**
 * Asks the user to pick one of a fixed set of values.
 *
 * @param options The options to be used.
 * @returns The value of the chosen option.
 * @throws AbortError If the user cancels the prompt.
 */
export const promptSelect = async (options: SelectPromptOptions): Promise<string> => {
  const answer = await select({
    message: options.message,
    output: process.stderr,
    options: options.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint === undefined ? {} : { hint: option.hint }),
    })),
    ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
  });

  if (isCancel(answer)) throw new AbortError();
  return String(answer);
};

/**
 * Asks for a line of text.
 *
 * @param options The options to be used.
 * @returns The trimmed answer, or {@link TextPromptOptions.defaultValue} (or `''`) if the user
 * submitted an empty line.
 * @throws AbortError If the user cancels the prompt.
 */
export const promptText = async (options: TextPromptOptions): Promise<string> => {
  // Built conditionally because `exactOptionalPropertyTypes` forbids passing explicit `undefined`
  // for clack's optional properties.
  const answer = await text({
    message: options.message,
    // Prompts are interaction, not output. Keeping them off stdout means a command's real output
    // stays machine-readable even when we have to ask a question first.
    output: process.stderr,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
    validate(value) {
      const trimmed = (value ?? '').trim();
      if (trimmed.length === 0) {
        return options.defaultValue === undefined ? 'A value is required.' : undefined;
      }
      return options.validate?.(trimmed);
    },
  });

  if (isCancel(answer)) throw new AbortError();

  const trimmed = String(answer ?? '').trim();
  return trimmed.length === 0 ? (options.defaultValue ?? '') : trimmed;
};
