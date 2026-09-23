import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  formatIni,
  formatValue,
  IniParseError,
  parseIni,
  splitKey,
} from '../../src/config/ini.ts';

describe('parseIni', () => {
  it('parses a plain section', () => {
    expect(parseIni('[core]\n\tbaseDir = /home/me/dev\n')).toEqual([
      {
        section: 'core',
        subsection: undefined,
        name: 'basedir',
        displayName: 'baseDir',
        value: '/home/me/dev',
      },
    ]);
  });

  it('lower-cases section and key names but preserves the value', () => {
    expect(parseIni('[CoRe]\n\tBaseDir = /Home/Me\n')).toEqual([
      {
        section: 'core',
        subsection: undefined,
        name: 'basedir',
        displayName: 'BaseDir',
        value: '/Home/Me',
      },
    ]);
  });

  it('preserves subsection case', () => {
    expect(parseIni('[install "PnPm"]\n\tfrozen = true\n')).toEqual([
      {
        section: 'install',
        subsection: 'PnPm',
        name: 'frozen',
        displayName: 'frozen',
        value: 'true',
      },
    ]);
  });

  it('treats a valueless key as boolean true', () => {
    expect(parseIni('[core]\n\tverbose\n')).toEqual([
      {
        section: 'core',
        subsection: undefined,
        name: 'verbose',
        displayName: 'verbose',
        value: 'true',
      },
    ]);
  });

  it('keeps repeated keys as ordered multi-values', () => {
    const entries = parseIni('[skip]\n\tinstall = a\n\tinstall = b\n\tinstall = c\n');
    expect(entries.map((entry) => entry.value)).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['# full line', '[core]\n# comment\n\tbaseDir = x\n', 'x'],
    ['; full line', '[core]\n; comment\n\tbaseDir = x\n', 'x'],
    ['trailing #', '[core]\n\tbaseDir = x # nope\n', 'x'],
    ['trailing ;', '[core]\n\tbaseDir = x ; nope\n', 'x'],
  ])('strips comments (%s)', (_name, input, expected) => {
    expect(parseIni(input)[0]?.value).toBe(expected);
  });

  it('treats comment characters inside quotes as literal', () => {
    expect(parseIni('[core]\n\tmotd = "hash # and semi ; inside"\n')[0]?.value).toBe(
      'hash # and semi ; inside',
    );
  });

  it('trims unquoted surrounding whitespace but keeps quoted whitespace', () => {
    expect(parseIni('[core]\n\ta =    spaced out   \n')[0]?.value).toBe('spaced out');
    expect(parseIni('[core]\n\ta = "  padded  "\n')[0]?.value).toBe('  padded  ');
  });

  it('decodes escape sequences', () => {
    expect(parseIni(String.raw`[core]` + '\n\ta = "x\\ny\\tz\\\\w\\"q"\n')[0]?.value).toBe(
      'x\ny\tz\\w"q',
    );
  });

  it('joins backslash line continuations', () => {
    expect(parseIni('[core]\n\ta = one\\\ntwo\n')[0]?.value).toBe('onetwo');
  });

  it('allows an empty value', () => {
    expect(parseIni('[core]\n\ta =\n')[0]?.value).toBe('');
  });

  it('ignores blank lines and leading whitespace', () => {
    expect(parseIni('\n\n  [core]  \n\n    baseDir = x\n\n')).toHaveLength(1);
  });

  it.each([
    ['key outside a section', 'baseDir = x\n'],
    ['unterminated subsection', '[install "npm]\n'],
    ['missing closing bracket', '[core\n'],
    ['invalid key name', '[core]\n\t1bad = x\n'],
    ['invalid escape', '[core]\n\ta = "x\\qy"\n'],
    ['unterminated quote', '[core]\n\ta = "oops\n'],
    ['dangling continuation at end of file', '[core]\n\ta = x\\'],
  ])('rejects %s', (_name, input) => {
    expect(() => parseIni(input)).toThrow(IniParseError);
  });

  it('allows a continuation onto an empty final line', () => {
    expect(parseIni('[core]\n\ta = x\\\n')[0]?.value).toBe('x');
  });
});

describe('formatIni', () => {
  it('round-trips through parseIni', () => {
    const entries = parseIni(
      '[core]\n\tbaseDir = /home/me\n[install "npm"]\n\tfrozen = false\n[skip]\n\tinstall = a\n\tinstall = b\n',
    );
    expect(parseIni(formatIni(entries))).toEqual(entries);
  });

  it('groups entries by section', () => {
    expect(
      formatIni([
        { section: 'core', subsection: undefined, name: 'basedir', value: '/x' },
        { section: 'core', subsection: undefined, name: 'layout', value: 'nested' },
        { section: 'install', subsection: 'npm', name: 'frozen', value: 'true' },
      ]),
    ).toBe('[core]\n\tbasedir = /x\n\tlayout = nested\n\n[install "npm"]\n\tfrozen = true\n');
  });

  it('returns an empty string for no entries', () => {
    expect(formatIni([])).toBe('');
  });

  it('preserves the original key casing when writing', () => {
    const entries = parseIni('[core]\n\tBaseDir = /x\n');
    expect(formatIni(entries)).toContain('BaseDir = /x');
  });

  it('falls back to the canonical name when no casing was recorded', () => {
    expect(
      formatIni([{ section: 'core', subsection: undefined, name: 'basedir', value: '/x' }]),
    ).toContain('basedir = /x');
  });

  it('round-trips awkward values', () => {
    for (const value of [
      '',
      '  padded  ',
      'has # hash',
      'has ; semi',
      'has "quote"',
      'back\\slash',
      'multi\nline',
      'tab\there',
    ]) {
      const entries = [{ section: 'core', subsection: undefined, name: 'a', value }];
      expect(parseIni(formatIni(entries))[0]?.value).toBe(value);
    }
  });
});

describe('formatValue', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['  pad ', '"  pad "'],
    ['a#b', '"a#b"'],
    ['a"b', String.raw`"a\"b"`],
  ])('quotes %j when necessary', (input, expected) => {
    expect(formatValue(input)).toBe(expected);
  });
});

describe('splitKey', () => {
  it('splits a two-part key', () => {
    expect(splitKey('Core.BaseDir')).toEqual({ section: 'core', name: 'basedir' });
  });

  it('treats the middle as a case-sensitive subsection', () => {
    expect(splitKey('install.PnPm.frozen')).toEqual({
      section: 'install',
      subsection: 'PnPm',
      name: 'frozen',
    });
  });

  it('allows dots within the subsection', () => {
    expect(splitKey('install.a.b.frozen')).toEqual({
      section: 'install',
      subsection: 'a.b',
      name: 'frozen',
    });
  });

  it.each(['nosection', '.leading', 'trailing.'])('rejects %j', (key) => {
    expect(() => splitKey(key)).toThrow(IniParseError);
  });
});

describe('canonicalKey', () => {
  it('lower-cases section and name only', () => {
    expect(canonicalKey('Install', 'PnPm', 'Frozen')).toBe('install.PnPm.frozen');
    expect(canonicalKey('Core', undefined, 'BaseDir')).toBe('core.basedir');
  });
});
