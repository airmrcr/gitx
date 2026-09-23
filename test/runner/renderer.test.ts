import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relativeTime, summaryLine } from '../../src/runner/renderer.ts';
import type { TaskRecord } from '../../src/runner/task.ts';
import { setColorMode, symbols } from '../../src/util/theme.ts';

const record = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  data: undefined,
  endedAt: undefined,
  error: undefined,
  id: 'api',
  lines: [],
  title: 'api',
  startedAt: undefined,
  state: 'success',
  status: undefined,
  summary: undefined,
  ...overrides,
});

beforeEach(() => {
  setColorMode('never');
});

afterEach(() => {
  setColorMode('never');
});

describe('summaryLine', () => {
  it('marks a successful task', () => {
    expect(summaryLine(record())).toBe(`${symbols.success} api`);
  });

  it('marks a failed task', () => {
    expect(summaryLine(record({ state: 'failure' }))).toBe(`${symbols.failure} api`);
  });

  it('marks a skipped task', () => {
    expect(summaryLine(record({ state: 'skipped' }))).toBe(`${symbols.skipped} api`);
  });

  it('appends the summary', () => {
    expect(summaryLine(record({ summary: 'up to date' }))).toBe(
      `${symbols.success} api up to date`,
    );
  });

  it('appends the elapsed time once the task has started', () => {
    const now = Date.now();
    expect(summaryLine(record({ startedAt: now - 1500, endedAt: now }))).toBe(
      `${symbols.success} api 1.5s`,
    );
  });

  it('omits the duration for a task that never ran', () => {
    expect(summaryLine(record({ state: 'skipped', summary: 'dirty' }))).toBe(
      `${symbols.skipped} api dirty`,
    );
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2024-05-01T12:00:00Z');

  it.each([
    ['2024-05-01T12:00:00Z', '0s ago'],
    ['2024-05-01T11:59:30Z', '30s ago'],
    ['2024-05-01T11:58:00Z', '2m ago'],
    ['2024-05-01T09:00:00Z', '3h ago'],
    ['2024-04-28T12:00:00Z', '3d ago'],
  ])('renders %s as %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });

  it('clamps future timestamps to zero', () => {
    expect(relativeTime('2024-05-01T12:05:00Z', now)).toBe('0s ago');
  });

  it('returns "unknown" for an unparseable timestamp', () => {
    expect(relativeTime('not a date', now)).toBe('unknown');
  });

  it('returns "unknown" for an empty string', () => {
    expect(relativeTime('', now)).toBe('unknown');
  });
});
