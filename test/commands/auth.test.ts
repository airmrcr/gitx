import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProviderAuth from '../../src/provider/auth.ts';
import type * as Registry from '../../src/provider/registry.ts';

const storeCredential = vi.fn<typeof ProviderAuth.storeCredential>();

// `storeCredential` actually writes to the system credential store; every other export (notably the
// real `findCredential`) stays real, since the whole point here is to exercise its actual env-var
// precedence.
vi.mock('../../src/provider/auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderAuth>();
  return {
    ...actual,
    storeCredential: (host: string, username: string, token: string) =>
      storeCredential(host, username, token),
  };
});

// The candidate provider built to verify a freshly typed token resolves its "login" via the real
// `findCredential`, so this test proves which token the lookup actually picked -- the one just
// typed, or a stale ambient one.
vi.mock('../../src/provider/registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>();
  return {
    ...actual,
    providerInfo: (id: string) => ({
      ...actual.providerInfo(id),
      create: (options: { host?: string }) => ({
        id,
        host: options.host ?? 'github.com',
        currentLogin: async () => {
          const { findCredential } = await import('../../src/provider/auth.ts');
          const credential = await findCredential({
            host: options.host ?? 'github.com',
            envNames: ['GH_TOKEN', 'GITHUB_TOKEN'],
          });
          return credential?.token;
        },
      }),
    }),
  };
});

const { runAuthLogin } = await import('../../src/commands/auth.ts');
const { Context } = await import('../../src/context.ts');
const { Config } = await import('../../src/config/store.ts');

const envKeys = ['GITX_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
let output = '';
let savedEnv: Record<string, string | undefined>;
const stdout = {
  write: (chunk: unknown) => ((output += String(chunk)), true),
} as NodeJS.WriteStream;

const context = () => new Context(Config.parse('[remote]\n\tprovider = github\n'));

const stdinWith = (text: string) => Readable.from([text]) as unknown as NodeJS.ReadStream;

beforeEach(() => {
  output = '';
  storeCredential.mockReset();
  storeCredential.mockResolvedValue(undefined);
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('runAuthLogin', () => {
  it('verifies the freshly typed token, not a stale ambient $GITX_TOKEN', async () => {
    process.env['GITX_TOKEN'] = 'old-ambient-token';
    delete process.env['GH_TOKEN'];
    delete process.env['GITHUB_TOKEN'];

    const code = await runAuthLogin(
      context(),
      { withToken: true },
      stdout,
      stdinWith('fresh-token'),
    );

    expect(code).toBe(0);
    expect(storeCredential).toHaveBeenCalledWith('github.com', 'fresh-token', 'fresh-token');
    expect(output).toContain('fresh-token');
  });

  it('restores $GITX_TOKEN and the provider variable afterwards, leaking nothing', async () => {
    process.env['GITX_TOKEN'] = 'old-ambient-token';
    delete process.env['GH_TOKEN'];

    await runAuthLogin(context(), { withToken: true }, stdout, stdinWith('fresh-token'));

    expect(process.env['GITX_TOKEN']).toBe('old-ambient-token');
    expect(process.env['GH_TOKEN']).toBeUndefined();
  });
});
