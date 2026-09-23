import { describe, expect, it, vi } from 'vitest';
import { createSpinner, withSpinner } from '../../src/util/spinner.ts';
import { setColorMode, stripAnsi } from '../../src/util/theme.ts';

setColorMode('never');

const fakeTty = (isTTY: boolean) => {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    columns: 80,
    rows: 24,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return {
    stream,
    get text() {
      return stripAnsi(chunks.join(''));
    },
  };
};

describe('createSpinner', () => {
  it('writes nothing when the stream is not a TTY', () => {
    const target = fakeTty(false);
    const spinner = createSpinner('working', { stream: target.stream });
    spinner.message('still working');
    spinner.stop();

    expect(target.text).toBe('');
  });

  it('draws the message immediately on a TTY', () => {
    const target = fakeTty(true);
    const spinner = createSpinner('working', { stream: target.stream });
    spinner.stop();

    expect(target.text).toContain('working');
  });

  it('advances frames on a timer', () => {
    vi.useFakeTimers();
    try {
      const target = fakeTty(true);
      const spinner = createSpinner('working', { stream: target.stream, interval: 10 });
      vi.advanceTimersByTime(35);
      spinner.stop();

      const frames = new Set(
        target.text
          .split('working')
          .slice(0, -1)
          .map((part) => part.trim())
          .filter(Boolean),
      );
      expect(frames.size).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an updated message', () => {
    const target = fakeTty(true);
    const spinner = createSpinner('first', { stream: target.stream });
    spinner.message('second');
    spinner.stop();

    expect(target.text).toContain('second');
  });

  it('is safe to stop twice', () => {
    const target = fakeTty(true);
    const spinner = createSpinner('working', { stream: target.stream });
    spinner.stop();

    expect(() => spinner.stop()).not.toThrow();
  });

  it('stops drawing once stopped', () => {
    vi.useFakeTimers();
    try {
      const target = fakeTty(true);
      const spinner = createSpinner('working', { stream: target.stream, interval: 10 });
      spinner.stop();
      const before = target.text.length;
      vi.advanceTimersByTime(100);

      expect(target.text.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withSpinner', () => {
  it('returns the action result', async () => {
    const target = fakeTty(true);
    const value = await withSpinner('working', async () => 42, { stream: target.stream });

    expect(value).toBe(42);
  });

  it('stops the spinner when the action throws', async () => {
    const target = fakeTty(true);

    await expect(
      withSpinner(
        'working',
        async () => {
          throw new Error('boom');
        },
        { stream: target.stream },
      ),
    ).rejects.toThrow('boom');

    // The live region is erased, so nothing is left on screen.
    expect(target.text.trimEnd().endsWith('working')).toBe(false);
  });

  it('hands the spinner to the action so it can relabel', async () => {
    const target = fakeTty(true);
    await withSpinner(
      'first',
      async (spinner) => {
        spinner.message('second');
      },
      { stream: target.stream },
    );

    expect(target.text).toContain('second');
  });
});
