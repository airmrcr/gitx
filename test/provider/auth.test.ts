import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec =
  vi.fn<(command: string, args: string[], options?: { input?: string }) => Promise<unknown>>();

vi.mock('../../src/util/exec.ts', () => ({
  exec: (command: string, args: string[], options?: { input?: string }) =>
    exec(command, args, options),
}));

const {
  configuredHelpers,
  eraseCredential,
  findCredential,
  parseCredentialOutput,
  requireCredential,
  storeCredential,
} = await import('../../src/provider/auth.ts');
const { ExitCode } = await import('../../src/util/errors.ts');

interface Store {
  approve?: typeof OK;
  fill: (string | undefined)[];
  helpers?: string[];
  reject?: typeof OK;
}

const NO_CREDENTIAL = { ok: false, stdout: '', stderr: '', code: 1 };
const OK = { ok: true, stdout: '', stderr: '', code: 0 };
const lookup = { host: 'github.com', envNames: ['GH_TOKEN', 'GITHUB_TOKEN'] };

const configured = (stdout: string) => {
  exec.mockResolvedValue({ ok: true, stdout, stderr: '', code: 0 });
};

const credentialOutput = (password: string) => ({
  ok: true,
  stdout: `protocol=https\nhost=github.com\nusername=acme\npassword=${password}\n`,
  stderr: '',
  code: 0,
});

const inputFor = (subcommand: string): string | undefined => {
  const call = exec.mock.calls.find(([, args]) => args.includes(subcommand));
  return (call?.[2] as { input?: string } | undefined)?.input;
};

const router = (store: Store) => {
  const fills = [...store.fill];
  exec.mockImplementation(async (_command, args) => {
    if (args.includes('fill')) {
      const next = fills.length > 1 ? fills.shift() : fills[0];
      return next === undefined ? NO_CREDENTIAL : credentialOutput(next);
    }
    if (args.includes('approve')) return store.approve ?? OK;
    if (args.includes('reject')) return store.reject ?? OK;
    if (args.includes('config')) {
      return { ...OK, stdout: (store.helpers ?? ['osxkeychain']).join('\n') };
    }
    return NO_CREDENTIAL;
  });
};

beforeEach(() => {
  exec.mockReset();
  exec.mockResolvedValue(NO_CREDENTIAL);
});

describe('parseCredentialOutput', () => {
  it('reads git key=value output', () => {
    expect(parseCredentialOutput('protocol=https\nhost=github.com\npassword=abc\n')).toEqual({
      protocol: 'https',
      host: 'github.com',
      password: 'abc',
    });
  });

  it('keeps `=` inside a value', () => {
    expect(parseCredentialOutput('password=a=b=c')['password']).toBe('a=b=c');
  });

  it('ignores blank and malformed lines', () => {
    expect(parseCredentialOutput('\nnonsense\n=leading\nhost=x\n')).toEqual({ host: 'x' });
  });
});

describe('findCredential', () => {
  it('prefers GITX_TOKEN over everything else', async () => {
    const found = await findCredential({
      ...lookup,
      env: { GITX_TOKEN: 'override', GH_TOKEN: 'ignored' },
    });

    expect(found).toEqual({ token: 'override', source: '$GITX_TOKEN' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts a token exported for other forge tooling', async () => {
    const found = await findCredential({ ...lookup, env: { GH_TOKEN: 'from-gh' } });

    expect(found).toEqual({ token: 'from-gh', source: '$GH_TOKEN' });
  });

  it('honours the order of the environment names', async () => {
    const found = await findCredential({
      ...lookup,
      env: { GITHUB_TOKEN: 'second', GH_TOKEN: 'first' },
    });

    expect(found?.token).toBe('first');
  });

  it('skips empty and whitespace-only variables', async () => {
    exec.mockResolvedValue(credentialOutput('stored'));

    const found = await findCredential({ ...lookup, env: { GH_TOKEN: '  ', GITHUB_TOKEN: '' } });

    expect(found?.source).toContain('git credential');
  });

  it('falls back to the git credential store', async () => {
    exec.mockResolvedValue(credentialOutput('stored'));

    const found = await findCredential({ ...lookup, env: {} });

    expect(found).toMatchObject({ token: 'stored', source: 'git credential (github.com)' });
  });

  // Logging out needs the account name, and git already knows it.
  it('reports the username git has on file', async () => {
    exec.mockResolvedValue(credentialOutput('stored'));

    const found = await findCredential({ ...lookup, env: {} });

    expect(found?.username).toBe('acme');
  });

  // Without this git would raise its own prompt in the middle of our output.
  it('never lets git prompt', async () => {
    exec.mockResolvedValue(credentialOutput('stored'));

    await findCredential({ ...lookup, env: {} });

    expect(exec).toHaveBeenCalledWith(
      'git',
      ['-c', 'credential.interactive=never', 'credential', 'fill'],
      expect.objectContaining({ input: 'protocol=https\nhost=github.com\n\n' }),
    );
  });

  it('returns undefined when git has nothing stored', async () => {
    await expect(findCredential({ ...lookup, env: {} })).resolves.toBeUndefined();
  });

  it('returns undefined when git answers without a password', async () => {
    exec.mockResolvedValue({ ok: true, stdout: 'host=github.com\n', stderr: '', code: 0 });

    await expect(findCredential({ ...lookup, env: {} })).resolves.toBeUndefined();
  });
});

describe('requireCredential', () => {
  it('returns the credential when there is one', async () => {
    const found = await requireCredential({
      ...lookup,
      env: { GH_TOKEN: 'abc' },
      label: 'GitHub',
      tokenUrl: 'https://github.com/settings/tokens',
    });

    expect(found.token).toBe('abc');
  });

  it('explains how to authenticate when there is none', async () => {
    await expect(
      requireCredential({
        ...lookup,
        env: {},
        label: 'GitHub',
        tokenUrl: 'https://github.com/settings/tokens',
      }),
    ).rejects.toMatchObject({
      message: 'not authenticated with GitHub (github.com)',
      code: ExitCode.Auth,
      hint: expect.stringContaining('export GH_TOKEN='),
    });
  });
});

describe('configuredHelpers', () => {
  // git terminates each value with a newline; the last one is punctuation, not an empty value, and
  // reading it as one would report no helper at all.
  it('ignores the trailing newline', async () => {
    configured('osxkeychain\n');

    await expect(configuredHelpers()).resolves.toEqual(['osxkeychain']);
  });

  it('keeps helpers in order', async () => {
    configured('osxkeychain\ncache\n');

    await expect(configuredHelpers()).resolves.toEqual(['osxkeychain', 'cache']);
  });

  // An empty value is how you disable a helper configured system-wide, so everything before it is
  // gone rather than merely joined by a blank.
  it('treats an empty value as a reset', async () => {
    configured('osxkeychain\n\n');

    await expect(configuredHelpers()).resolves.toEqual([]);
  });

  it('keeps helpers configured after a reset', async () => {
    configured('osxkeychain\n\nlibsecret\n');

    await expect(configuredHelpers()).resolves.toEqual(['libsecret']);
  });

  it('reports none when the key is unset', async () => {
    exec.mockResolvedValue(NO_CREDENTIAL);

    await expect(configuredHelpers()).resolves.toEqual([]);
  });
});

describe('storeCredential', () => {
  it('writes through git so the user keeps their own helper', async () => {
    router({ fill: ['abc'] });

    await storeCredential('github.com', 'acme', 'abc');

    expect(inputFor('approve')).toBe(
      'protocol=https\nhost=github.com\nusername=acme\npassword=abc\n\n',
    );
  });

  it('reports a helper that refuses the write', async () => {
    router({ fill: ['abc'], approve: { ok: false, stdout: '', stderr: 'no helper', code: 1 } });

    await expect(storeCredential('github.com', 'acme', 'abc')).rejects.toMatchObject({
      code: ExitCode.Auth,
      detail: 'no helper',
    });
  });

  // `git credential approve` exits 0 with no helper configured, having thrown the token away.
  // Reporting success there sends people away believing they are logged in.
  it('fails when nothing actually stored the token', async () => {
    router({ fill: [undefined], helpers: [] });

    await expect(storeCredential('github.com', 'acme', 'abc')).rejects.toMatchObject({
      message: 'nothing stored the token for github.com',
      code: ExitCode.Auth,
      hint: expect.stringContaining('No credential helper is configured'),
    });
  });

  it('names the helper that let the token through', async () => {
    router({ fill: [undefined], helpers: ['store'] });

    await expect(storeCredential('github.com', 'acme', 'abc')).rejects.toMatchObject({
      hint: expect.stringContaining('store'),
    });
  });

  it('fails when a different token comes back', async () => {
    router({ fill: ['something-else'] });

    await expect(storeCredential('github.com', 'acme', 'abc')).rejects.toMatchObject({
      code: ExitCode.Auth,
    });
  });
});

describe('eraseCredential', () => {
  it('rejects the stored credential for the host', async () => {
    router({ fill: ['stored', undefined] });

    await expect(eraseCredential('github.com', 'acme')).resolves.toEqual({ removed: true });
    expect(inputFor('reject')).toBe('protocol=https\nhost=github.com\nusername=acme\n\n');
  });

  // The account is already in the stored credential, so logging out does not need the network to
  // find out who you are.
  it('takes the username from the stored credential', async () => {
    router({ fill: ['stored', undefined] });

    await eraseCredential('github.com');

    expect(inputFor('reject')).toContain('username=acme');
  });

  // Logging out of a host you were never logged in to is not an error, but it must not claim to
  // have removed anything either.
  it('reports that there was nothing to erase', async () => {
    router({ fill: [undefined] });

    await expect(eraseCredential('github.com')).resolves.toEqual({ removed: false });
    expect(inputFor('reject')).toBeUndefined();
  });

  it('reports a helper that refuses to delete', async () => {
    router({ fill: ['stored'], reject: { ok: false, stdout: '', stderr: 'locked', code: 1 } });

    await expect(eraseCredential('github.com')).rejects.toMatchObject({
      code: ExitCode.Auth,
      detail: 'locked',
    });
  });

  // Some helpers exit 0 and keep the entry anyway.
  it('fails when the credential survives the delete', async () => {
    router({ fill: ['stored'] });

    await expect(eraseCredential('github.com')).rejects.toMatchObject({
      message: 'the stored token for github.com is still there',
      code: ExitCode.Auth,
    });
  });
});
