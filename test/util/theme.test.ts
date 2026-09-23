import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCommand,
  formatDuration,
  isColorEnabled,
  setColorMode,
  stripAnsi,
  theme,
} from '../../src/util/theme.ts';

afterEach(() => {
  setColorMode('never');
});

describe('setColorMode', () => {
  it('forces colour on', () => {
    setColorMode('always');
    expect(isColorEnabled()).toBe(true);
    expect(theme.repo('api')).not.toBe('api');
  });

  it('forces colour off', () => {
    setColorMode('never');
    expect(isColorEnabled()).toBe(false);
    expect(theme.repo('api')).toBe('api');
  });

  it('honours NO_COLOR in auto mode', () => {
    setColorMode('auto', { NO_COLOR: '1' });
    expect(isColorEnabled()).toBe(false);
  });

  it('honours FORCE_COLOR in auto mode', () => {
    setColorMode('auto', { FORCE_COLOR: '1' });
    expect(isColorEnabled()).toBe(true);
  });

  it('treats FORCE_COLOR=0 as a request for no colour', () => {
    setColorMode('auto', { FORCE_COLOR: '0' });
    expect(isColorEnabled()).toBe(false);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0ms'],
    [999, '999ms'],
    [1000, '1.0s'],
    [1500, '1.5s'],
    [59_900, '59.9s'],
    [60_000, '1m00s'],
    [95_000, '1m35s'],
    [3_600_000, '60m00s'],
  ])('formats %ims as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('never reports a negative duration', () => {
    expect(formatDuration(-5)).toBe('0ms');
  });
});

describe('formatCommand', () => {
  it('echoes a command shell-style', () => {
    expect(formatCommand('git', ['status', '--porcelain'])).toBe('+ git status --porcelain');
  });

  it('handles a bare command', () => {
    expect(formatCommand('git')).toBe('+ git');
  });

  it('quotes arguments containing whitespace', () => {
    expect(formatCommand('git', ['commit', '-m', 'a message'])).toBe('+ git commit -m "a message"');
  });

  it('quotes arguments containing shell metacharacters', () => {
    expect(formatCommand('sh', ['-c', 'a|b'])).toBe('+ sh -c "a|b"');
  });

  it('leaves ordinary flags unquoted', () => {
    expect(formatCommand('npm', ['ci', '--no-audit'])).toBe('+ npm ci --no-audit');
  });
});

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    setColorMode('always');
    expect(stripAnsi(theme.failure('boom'))).toBe('boom');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('strips nested styles', () => {
    setColorMode('always');
    expect(stripAnsi(theme.bold(theme.repo('api')))).toBe('api');
  });
});
