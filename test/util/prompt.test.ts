import type * as clackModule from '@clack/prompts';
import { describe, expect, it, vi } from 'vitest';

const text = vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(async () => 'answer');

vi.mock('@clack/prompts', () => ({
  text: (options: Record<string, unknown>) => text(options),
  isCancel: (value: unknown) => value === CANCEL,
}));

const CANCEL = Symbol('cancel');

const { isInteractive, promptText } = await import('../../src/util/prompt.ts');
const { AbortError } = await import('../../src/util/errors.ts');

function stream(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

function readStream(isTTY: boolean): NodeJS.ReadStream {
  return { isTTY } as NodeJS.ReadStream;
}

describe('isInteractive', () => {
  it('needs both an input and an output terminal', () => {
    expect(isInteractive(readStream(true), stream(true))).toBe(true);
    expect(isInteractive(readStream(false), stream(true))).toBe(false);
    expect(isInteractive(readStream(true), stream(false))).toBe(false);
  });

  it('defaults to judging stderr, not stdout', () => {
    // A porcelain pipeline redirects stdout but keeps stderr on the terminal, and that case must
    // still count as interactive.
    expect(isInteractive(readStream(true))).toBe(Boolean(process.stderr.isTTY));
  });

  it('never prompts in CI', () => {
    vi.stubEnv('CI', 'true');
    expect(isInteractive(readStream(true), stream(true))).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('promptText', () => {
  it('draws on stderr so stdout stays machine-readable', async () => {
    text.mockResolvedValue('acme');

    await promptText({ message: 'Owner?' });

    expect(text.mock.calls[0]?.[0]?.['output']).toBe(process.stderr);
  });

  it('trims the answer', async () => {
    text.mockResolvedValue('  acme \n');

    await expect(promptText({ message: 'Owner?' })).resolves.toBe('acme');
  });

  it('omits optional properties it was not given', async () => {
    text.mockResolvedValue('acme');

    await promptText({ message: 'Owner?' });

    const options = text.mock.calls[0]?.[0] ?? {};
    expect('placeholder' in options).toBe(false);
    expect('initialValue' in options).toBe(false);
  });

  it('passes a placeholder and initial value through when given', async () => {
    text.mockResolvedValue('acme');

    await promptText({ message: 'Owner?', placeholder: 'my-org', initialValue: 'seed' });

    const options = text.mock.calls[0]?.[0] ?? {};
    expect(options['placeholder']).toBe('my-org');
    expect(options['initialValue']).toBe('seed');
  });

  it('rejects an empty answer', async () => {
    text.mockResolvedValue('acme');
    await promptText({ message: 'Owner?' });

    const validate = text.mock.calls[0]?.[0]?.['validate'] as (value: string) => string | undefined;
    expect(validate('   ')).toBe('A value is required.');
    expect(validate('acme')).toBeUndefined();
  });

  it('applies the caller validator after its own', async () => {
    text.mockResolvedValue('acme');
    await promptText({
      message: 'Owner?',
      validate: (value) => (value === 'no' ? 'nope' : undefined),
    });

    const validate = text.mock.calls[0]?.[0]?.['validate'] as (value: string) => string | undefined;
    expect(validate('no')).toBe('nope');
  });

  it('turns a cancellation into an AbortError', async () => {
    text.mockResolvedValue(CANCEL);

    await expect(promptText({ message: 'Owner?' })).rejects.toBeInstanceOf(AbortError);
  });
});

describe('the real prompt module', () => {
  it('is wired to clack', async () => {
    // Guards against the mock above drifting from the genuine export shape.
    const clack = await vi.importActual<typeof clackModule>('@clack/prompts');
    expect(typeof clack.text).toBe('function');
    expect(typeof clack.isCancel).toBe('function');
  });
});
