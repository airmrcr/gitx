import { ExitCode, GitxError } from './errors.ts';

/**
 * Splits a string into words the way a POSIX shell would, honouring single quotes, double quotes,
 * and backslash escapes.
 *
 * This is deliberately small: it exists so `alias.up = update --install 'api-*'` behaves the way
 * anyone who has written a git alias expects, without handing the value to a shell.
 *
 * @param input The string to split.
 * @returns The individual words, with quotes and escapes resolved.
 * @throws GitxError If there is a trailing backslash or an unbalanced quote.
 */
export const splitWords = (input: string): string[] => {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }

    if (quote === '"') {
      // Only these are special inside double quotes, as in a real shell.
      if (char === '\\' && (input[index + 1] === '"' || input[index + 1] === '\\')) {
        index += 1;
        current += input[index];
      } else if (char === '"') {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '\\') {
      if (index + 1 >= input.length) {
        throw new GitxError('trailing backslash in alias', { code: ExitCode.Config });
      }
      index += 1;
      current += input[index];
      started = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) {
    throw new GitxError(`unbalanced ${quote === "'" ? 'single' : 'double'} quote in alias`, {
      code: ExitCode.Config,
      hint: 'Check the alias value in your configuration.',
    });
  }

  if (started) words.push(current);
  return words;
};
