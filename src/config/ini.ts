interface HeaderResult {
  rest: string;
  section: string;
  subsection: string | undefined;
}

interface ValueResult extends ValueState {
  // True when the line ended with a backslash continuation.
  continued: boolean;
  value: string;
}

interface ValueState {
  // True once any significant character has been seen. Whitespace is only meaningful between pieces
  // of content, so leading whitespace is dropped until this flips.
  hasContent: boolean;
  // True when parsing resumes inside an unterminated quote.
  inQuotes: boolean;
}

const KEY_NAME_PATTERN = /^[A-Za-z][\dA-Za-z-]*$/;
const SECTION_NAME_PATTERN = /^[\dA-Za-z-]+$/;

const formatSectionHeader = (section: string, subsection: string | undefined): string => {
  if (subsection === undefined) return `[${section}]`;
  const escaped = subsection.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `[${section} "${escaped}"]`;
};

const parseSectionHeader = (text: string, lineNumber: number): HeaderResult => {
  let index = 1; // skip '['
  let section = '';

  while (index < text.length && text[index] !== ']' && !/\s/.test(text[index]!)) {
    section += text[index];
    index += 1;
  }

  if (!SECTION_NAME_PATTERN.test(section)) {
    throw new IniParseError(`invalid section name: [${section}`, lineNumber);
  }

  while (index < text.length && /\s/.test(text[index]!)) index += 1;

  let subsection: string | undefined;

  if (text[index] === '"') {
    index += 1;
    let value = '';
    let closed = false;

    while (index < text.length) {
      const char = text[index]!;
      if (char === '\\') {
        const next = text[index + 1];
        if (next === undefined) {
          throw new IniParseError('unterminated escape in subsection name', lineNumber);
        }
        // git only honours \" and \\ inside subsection names; anything else is literal.
        value += next === '"' || next === '\\' ? next : `\\${next}`;
        index += 2;
        continue;
      }
      if (char === '"') {
        closed = true;
        index += 1;
        break;
      }
      value += char;
      index += 1;
    }

    if (!closed) {
      throw new IniParseError('unterminated subsection name', lineNumber);
    }

    subsection = value;
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  }

  if (text[index] !== ']') {
    throw new IniParseError('missing `]` in section header', lineNumber);
  }

  return { section: section.toLowerCase(), subsection, rest: text.slice(index + 1) };
};

const parseValue = (text: string, lineNumber: number, state: ValueState): ValueResult => {
  let value = '';
  let { inQuotes, hasContent } = state;
  let index = 0;
  // Buffers unquoted whitespace so that trailing whitespace can be discarded.
  let pendingWhitespace = '';

  const flushWhitespace = () => {
    if (hasContent) value += pendingWhitespace;
    pendingWhitespace = '';
  };

  while (index < text.length) {
    const char = text[index]!;

    if (char === '\\') {
      const next = text[index + 1];

      if (next === undefined) {
        return { value, continued: true, inQuotes, hasContent };
      }

      flushWhitespace();
      hasContent = true;

      switch (next) {
        case 'n':
          value += '\n';
          break;
        case 't':
          value += '\t';
          break;
        case 'b':
          value += '\b';
          break;
        case '\\':
          value += '\\';
          break;
        case '"':
          value += '"';
          break;
        default:
          throw new IniParseError(`invalid escape sequence: \\${next}`, lineNumber);
      }

      index += 2;
      continue;
    }

    if (char === '"') {
      flushWhitespace();
      inQuotes = !inQuotes;
      hasContent = true;
      index += 1;
      continue;
    }

    if (!inQuotes && (char === '#' || char === ';')) {
      break;
    }

    if (!inQuotes && /\s/.test(char)) {
      pendingWhitespace += char;
      index += 1;
      continue;
    }

    flushWhitespace();
    hasContent = true;
    value += char;
    index += 1;
  }

  return { value, continued: false, inQuotes, hasContent };
};

/**
 * A single parsed key/value entry from a git-config file.
 */
export interface IniEntry {
  /**
   * Original casing of the key, preserved so that a hand-edited file round-trips
   * and generated files stay readable (`baseDir` rather than `basedir`).
   */
  displayName?: string | undefined;
  /** Key name, lower-cased. Used for all lookups and comparisons. */
  name: string;
  /** Section name, lower-cased. */
  section: string;
  /** Subsection name, case preserved. `undefined` when the section is plain. */
  subsection?: string | undefined;
  /** Raw value. A valueless key yields `'true'`. */
  value: string;
}

/**
 * A single parsed key from a git-config file.
 */
export interface IniKey {
  /** Key name, lower-cased. Used for all lookups and comparisons. */
  name: string;
  /** Section name, lower-cased. */
  section: string;
  /** Subsection name, case preserved. `undefined` when the section is plain. */
  subsection?: string | undefined;
}

/**
 * Thrown when a git-config file or key fails to parse.
 */
export class IniParseError extends Error {
  /** 1-based line number where the error occurred, or `0` when not line-specific. */
  readonly line: number;

  /**
   * Creates a new {@link IniParseError} instance.
   *
   * @param message Description of what went wrong.
   * @param line 1-based line number where the error occurred.
   */
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);

    this.name = 'IniParseError';
    this.line = line;
  }
}

/**
 * Builds the canonical lookup key for an entry (e.g. `install.npm.restorelockfile`).
 *
 * @param section Section name.
 * @param subsection Subsection name, if any.
 * @param name Key name.
 * @returns The dotted, lower-cased lookup key.
 */
export const canonicalKey = (
  section: string,
  subsection: string | undefined,
  name: string,
): string => {
  const parts =
    subsection === undefined
      ? [section.toLowerCase(), name.toLowerCase()]
      : [section.toLowerCase(), subsection, name.toLowerCase()];
  return parts.join('.');
};

/**
 * Builds the canonical lookup key for an existing entry.
 *
 * @param entry The entry to key.
 * @returns The dotted, lower-cased lookup key, as per {@link canonicalKey}.
 */
export const entryKey = (entry: IniEntry): string =>
  canonicalKey(entry.section, entry.subsection, entry.name);

/**
 * Serialises entries back to git-config text, grouping consecutive entries that share a section so
 * the output stays idiomatic.
 *
 * A minimal but faithful implementation of git's configuration file format. A generic INI library
 * was deliberately avoided because git's dialect has several quirks that matter for round-tripping
 * a user's `~/.gitxconfig`:
 *
 * - subsections (`[install "npm"]`) are case-sensitive, sections and keys are not
 * - keys may appear multiple times, forming an ordered multi-value list
 * - values support quoting, escape sequences and backslash line-continuations
 * - `#` and `;` begin comments, but only outside of quotes
 * - a valueless key (`[flags]\n\tverbose`) means boolean true
 *
 * @param entries Entries to serialise, in output order.
 * @returns The formatted git-config text.
 * @see https://git-scm.com/docs/git-config#_configuration_file
 */
export function formatIni(entries: readonly IniEntry[]): string {
  if (entries.length === 0) return '';

  // Group by section while preserving first-seen section order and entry order.
  const groups = new Map<
    string,
    { section: string; subsection: string | undefined; entries: IniEntry[] }
  >();

  for (const entry of entries) {
    const groupKey = `${entry.section}\u0000${entry.subsection ?? ''}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { section: entry.section, subsection: entry.subsection, entries: [] };
      groups.set(groupKey, group);
    }
    group.entries.push(entry);
  }

  const blocks = [...groups.values()].map((group) => {
    const header = formatSectionHeader(group.section, group.subsection);
    const body = group.entries.map(
      (entry) => `\t${entry.displayName ?? entry.name} = ${formatValue(entry.value)}`,
    );
    return [header, ...body].join('\n');
  });

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Quotes and escapes a value so that {@link parseIni} round-trips it exactly.
 *
 * @param value Raw value to format.
 * @returns The value, quoted and escaped if necessary.
 */
export const formatValue = (value: string): string => {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\b', '\\b');

  const needsQuotes =
    value.length === 0 || value !== value.trim() || /["#;\\]/.test(value) || /[\n\t\b]/.test(value);

  return needsQuotes ? `"${escaped}"` : escaped;
};

/**
 * Parses git-config formatted text into an ordered list of entries.
 *
 * A minimal but faithful implementation of git's configuration file format. A generic INI library
 * was deliberately avoided because git's dialect has several quirks that matter for round-tripping
 * a user's `~/.gitxconfig`:
 *
 * - subsections (`[install "npm"]`) are case-sensitive, sections and keys are not
 * - keys may appear multiple times, forming an ordered multi-value list
 * - values support quoting, escape sequences and backslash line-continuations
 * - `#` and `;` begin comments, but only outside of quotes
 * - a valueless key (`[flags]\n\tverbose`) means boolean true
 *
 * @param text Raw file contents.
 * @returns The entries, in file order.
 * @throws IniParseError If `text` is not valid git-config syntax.
 * @see https://git-scm.com/docs/git-config#_configuration_file
 */
export const parseIni = (text: string): IniEntry[] => {
  const entries: IniEntry[] = [];
  const lines = text.split(/\r?\n/);

  let section: string | undefined;
  let subsection: string | undefined;

  // Continuation state, populated when a value line ends with a backslash.
  let pendingName: string | undefined;
  let pendingDisplayName: string | undefined;
  let pendingValue = '';
  let pendingState: ValueState = { inQuotes: false, hasContent: false };

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;

    if (pendingName !== undefined) {
      const result = parseValue(rawLine, lineNumber, pendingState);
      pendingValue += result.value;
      pendingState = { inQuotes: result.inQuotes, hasContent: result.hasContent };

      if (result.continued) continue;

      if (result.inQuotes) {
        throw new IniParseError('unterminated quoted value', lineNumber);
      }

      entries.push({
        section: section!,
        subsection,
        name: pendingName,
        displayName: pendingDisplayName,
        value: pendingValue,
      });
      pendingName = undefined;
      pendingDisplayName = undefined;
      pendingValue = '';
      pendingState = { inQuotes: false, hasContent: false };
      continue;
    }

    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    if (line.startsWith('[')) {
      const header = parseSectionHeader(line, lineNumber);
      section = header.section;
      subsection = header.subsection;

      const trailing = header.rest.trim();
      if (trailing.length > 0 && !trailing.startsWith('#') && !trailing.startsWith(';')) {
        throw new IniParseError(`unexpected content after section header: ${trailing}`, lineNumber);
      }
      continue;
    }

    if (section === undefined) {
      throw new IniParseError(`key outside of any section: ${line}`, lineNumber);
    }

    const separator = line.indexOf('=');
    const rawName = (separator === -1 ? line : line.slice(0, separator)).trim();

    if (!KEY_NAME_PATTERN.test(rawName)) {
      throw new IniParseError(`invalid key name: ${rawName}`, lineNumber);
    }

    const name = rawName.toLowerCase();
    const displayName = rawName;

    // A bare key is boolean true, matching `git config --bool`.
    if (separator === -1) {
      entries.push({ section, subsection, name, displayName, value: 'true' });
      continue;
    }

    const result = parseValue(line.slice(separator + 1), lineNumber, {
      inQuotes: false,
      hasContent: false,
    });

    if (result.continued) {
      pendingName = name;
      pendingDisplayName = displayName;
      pendingValue = result.value;
      pendingState = { inQuotes: result.inQuotes, hasContent: result.hasContent };
      continue;
    }

    if (result.inQuotes) {
      throw new IniParseError('unterminated quoted value', lineNumber);
    }

    entries.push({ section, subsection, name, displayName, value: result.value });
  }

  if (pendingName !== undefined) {
    throw new IniParseError('unexpected end of file during line continuation', lines.length);
  }

  return entries;
};

/**
 * Splits a user-supplied dotted key into its parts. Everything between the first and last dot is
 * the (case-sensitive) subsection, matching `git config`.
 *
 * @param key Dotted key, e.g. `install.npm.restoreLockfile`.
 * @returns The parsed `section`, optional `subsection`, and `name`.
 * @throws IniParseError If `key` has no section, or is otherwise malformed.
 */
export const splitKey = (key: string): IniKey => {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');

  if (first === -1) {
    throw new IniParseError(`key must contain a section: ${key}`, 0);
  }

  const section = key.slice(0, first).toLowerCase();
  const name = key.slice(last + 1).toLowerCase();

  if (section.length === 0 || name.length === 0) {
    throw new IniParseError(`malformed key: ${key}`, 0);
  }

  if (first === last) {
    return { section, name };
  }

  return { section, subsection: key.slice(first + 1, last), name };
};
