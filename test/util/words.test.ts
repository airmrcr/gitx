import { describe, expect, it } from 'vitest';
import { splitWords } from '../../src/util/words.ts';

describe('splitWords', () => {
  it('splits on runs of whitespace', () => {
    expect(splitWords('update   --install\t--tidy')).toEqual(['update', '--install', '--tidy']);
  });

  it('returns nothing for an empty or blank string', () => {
    expect(splitWords('')).toEqual([]);
    expect(splitWords('   \t ')).toEqual([]);
  });

  it('keeps single-quoted runs together', () => {
    expect(splitWords("update 'api-* web-*'")).toEqual(['update', 'api-* web-*']);
  });

  it('keeps double-quoted runs together', () => {
    expect(splitWords('clone "my repo"')).toEqual(['clone', 'my repo']);
  });

  it('treats an empty quoted string as a real argument', () => {
    expect(splitWords("set key ''")).toEqual(['set', 'key', '']);
  });

  it('joins quoted and unquoted halves of one word', () => {
    expect(splitWords('--filter="a b"c')).toEqual(['--filter=a bc']);
  });

  it('takes single quotes literally inside double quotes and vice versa', () => {
    expect(splitWords(`"it's"`)).toEqual(["it's"]);
    expect(splitWords(`'say "hi"'`)).toEqual(['say "hi"']);
  });

  it('honours backslash escapes outside quotes', () => {
    expect(splitWords(String.raw`a\ b c`)).toEqual(['a b', 'c']);
  });

  it('honours backslash escapes for quotes and backslashes inside double quotes', () => {
    expect(splitWords(String.raw`"a\"b"`)).toEqual(['a"b']);
    expect(splitWords(String.raw`"a\\b"`)).toEqual([String.raw`a\b`]);
  });

  it('leaves other backslashes alone inside double quotes, as a shell does', () => {
    expect(splitWords(String.raw`"a\nb"`)).toEqual([String.raw`a\nb`]);
  });

  it('rejects an unbalanced single quote', () => {
    expect(() => splitWords("update 'api")).toThrow(/unbalanced single quote/);
  });

  it('rejects an unbalanced double quote', () => {
    expect(() => splitWords('update "api')).toThrow(/unbalanced double quote/);
  });

  it('rejects a trailing backslash', () => {
    expect(() => splitWords('update \\')).toThrow(/trailing backslash/);
  });
});
