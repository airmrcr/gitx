import { Command } from 'commander';
import type { Context } from '../context.ts';
import { eraseCredential, findCredential, storeCredential } from '../provider/auth.ts';
import { providerInfo } from '../provider/registry.ts';
import { ExitCode, GitxError } from '../util/errors.ts';
import { promptText } from '../util/prompt.ts';
import { theme } from '../util/theme.ts';

const envNamesFor = (id: string): readonly string[] =>
  id === 'gitlab' ? ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN'] : ['GH_TOKEN', 'GITHUB_TOKEN'];

const promptToken = async (context: Context, id: string, host: string): Promise<string> => {
  if (!context.canPrompt) {
    throw new GitxError('cannot prompt for a token', {
      code: ExitCode.Auth,
      hint: 'Pipe the token in instead: `gitx auth login --with-token < token.txt`.',
    });
  }

  const url =
    id === 'gitlab'
      ? `https://${host}/-/user_settings/personal_access_tokens`
      : `https://${host}/settings/tokens`;

  process.stderr.write(`${theme.muted(`Create a token at ${theme.link(url)}`)}\n`);
  process.stderr.write(
    `${theme.muted(id === 'gitlab' ? 'Scope needed: read_api' : 'Scopes needed: repo, read:org')}\n`,
  );

  return promptText({ message: 'Paste your access token' });
};

const readAll = async (stream: NodeJS.ReadStream): Promise<string> => {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
};

const verify = async (
  provider: { currentLogin: () => Promise<string | undefined> },
  token: string,
  id: string,
): Promise<string> => {
  // `$GITX_TOKEN` is checked before the provider-specific variable (see `findCredential`), so it
  // must be overridden too -- otherwise an ambient `$GITX_TOKEN` left over from another login wins
  // the lookup, and the token actually being verified and stored is never the one actually checked.
  const variables = ['GITX_TOKEN', id === 'gitlab' ? 'GITLAB_TOKEN' : 'GH_TOKEN'];
  const previous = new Map(variables.map((name) => [name, process.env[name]]));
  for (const name of variables) process.env[name] = token;

  try {
    const login = await provider.currentLogin();
    if (login === undefined) {
      throw new GitxError('that token was rejected', {
        code: ExitCode.Auth,
        hint: 'Check it has not expired and carries the scopes listed above.',
      });
    }
    return login;
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

/**
 * Options for `gitx auth login`.
 */
export interface AuthLoginOptions {
  /** Read the token from stdin instead of prompting. */
  withToken?: boolean;
}

/**
 * Builds the `auth` command for credential management.
 *
 * gitx keeps no credential store of its own. Tokens are read from, and written to, whatever `git`
 * already uses -- the macOS Keychain, libsecret, Windows Credential Manager -- so there is one
 * place for a secret to live rather than two, and no native dependency to make that true.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `auth` {@link Command}.
 */
export const authCommand = (getContext: () => Promise<Context>): Command => {
  const auth = new Command('auth').description('Manage credentials for your provider');

  auth
    .command('login')
    .description('Store an access token in your system credential store')
    .option('--with-token', 'read the token from stdin instead of prompting')
    .action(async (options: { withToken?: boolean }) => {
      process.exitCode = await runAuthLogin(await getContext(), options);
    });

  auth
    .command('logout')
    .description('Remove the stored token for your provider host')
    .action(async () => {
      process.exitCode = await runAuthLogout(await getContext());
    });

  auth
    .command('status')
    .description('Show whether gitx can authenticate, and where the token came from')
    .action(async () => {
      process.exitCode = await runAuthStatus(await getContext());
    });

  auth.addHelpText(
    'after',
    `
gitx reads a token from, in order:

  1. $GITX_TOKEN
  2. $GH_TOKEN / $GITHUB_TOKEN, or $GITLAB_TOKEN
  3. your git credential helper, which is where \`gh\` and \`glab\` already put
     theirs -- so if git can push to the host, gitx can talk to its API

\`gitx auth login\` writes to that same credential helper, so a token stored
here also works for \`git push\`.
`,
  );

  return auth;
};

/**
 * Runs `gitx auth login`, verifying and storing a token in the system credential store.
 *
 * @param context Resolved {@link Context}.
 * @param [options] The options to be used.
 * @param [stdout=process.stdout] Stream to write confirmation output to.
 * @param [stdin=process.stdin] Stream to read the token from when
 * {@link AuthLoginOptions.withToken} is set.
 * @returns The process exit code.
 * @throws GitxError If no token is given, or the given token is rejected.
 */
export const runAuthLogin = async (
  context: Context,
  options: AuthLoginOptions = {},
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<number> => {
  const provider = await context.provider();
  const info = providerInfo(provider.id);

  const token =
    options.withToken === true
      ? (await readAll(stdin)).trim()
      : await promptToken(context, provider.id, provider.host);

  if (token.length === 0) {
    throw new GitxError('no token given', { code: ExitCode.Auth });
  }

  // Verified before storing: a typo that only surfaces on the next command is a miserable way to
  // find out the token is wrong.
  const candidate = info.create({ host: provider.host });
  const login = await verify(candidate, token, provider.id);

  await storeCredential(provider.host, login, token);

  stdout.write(
    `${theme.success('✔')} stored a token for ${theme.repo(login)} on ${theme.muted(provider.host)}\n`,
  );
  return ExitCode.Ok;
};

/**
 * Runs `gitx auth logout`, removing the stored token for the current provider host.
 *
 * @param context Resolved {@link Context}.
 * @param [stdout=process.stdout] Stream to write confirmation output to.
 * @returns The process exit code.
 */
export const runAuthLogout = async (
  context: Context,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<number> => {
  // Deliberately no `currentLogin()` call: the username is in the stored credential itself, and
  // needing the network to log out is precisely wrong when the reason you are logging out is an
  // expired token.
  const provider = await context.provider();
  const { removed } = await eraseCredential(provider.host);

  if (!removed) {
    stdout.write(`${theme.muted(`No token was stored for ${provider.host}.`)}\n`);
    return ExitCode.Ok;
  }

  stdout.write(`${theme.success('✔')} removed the stored token for ${provider.host}\n`);
  stdout.write(
    `${theme.muted(`That credential was shared with git, so HTTPS pushes to ${provider.host} will ask for it again.`)}\n`,
  );
  stdout.write(
    `${theme.muted('The token still exists on the server; revoke it there if you meant to.')}\n`,
  );

  // An exported token would keep gitx authenticated regardless, which looks like the logout
  // silently failed.
  const overriding = ['GITX_TOKEN', ...envNamesFor(provider.id)].find(
    (name) => (process.env[name] ?? '').trim().length > 0,
  );
  if (overriding !== undefined) {
    stdout.write(
      `${theme.warn('!')} $${overriding} is still set, so gitx remains authenticated.\n`,
    );
  }

  return ExitCode.Ok;
};

/**
 * Runs `gitx auth status`, reporting whether a token is available and valid.
 *
 * @param context Resolved {@link Context}.
 * @param [stdout=process.stdout] Stream to write status output to.
 * @returns The process exit code.
 */
export const runAuthStatus = async (
  context: Context,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<number> => {
  const provider = await context.provider();
  const info = providerInfo(provider.id);

  const credential = await findCredential({
    host: provider.host,
    envNames: envNamesFor(provider.id),
  });

  stdout.write(`${theme.heading(info.label)} ${theme.muted(provider.host)}\n`);

  if (!credential) {
    stdout.write(`  ${theme.failure('✖')} no token found\n`);
    stdout.write(`  ${theme.muted(`Run \`gitx auth login\` to store one.`)}\n`);
    return ExitCode.Auth;
  }

  stdout.write(`  ${theme.success('✔')} token found ${theme.muted(`(${credential.source})`)}\n`);

  const login = await provider.currentLogin().catch(() => undefined);
  if (login === undefined) {
    stdout.write(`  ${theme.failure('✖')} the token was rejected\n`);
    return ExitCode.Auth;
  }

  stdout.write(`  ${theme.success('✔')} authenticated as ${theme.repo(login)}\n`);
  return ExitCode.Ok;
};
