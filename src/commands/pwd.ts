import { Command } from 'commander';
import type { Context } from '../context.ts';
import { ExitCode } from '../util/errors.ts';

/**
 * Builds the `pwd` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `pwd` {@link Command}.
 */
export const pwdCommand = (getContext: () => Promise<Context>): Command =>
  new Command('pwd')
    .description("Print a cloned repository's working directory")
    .argument('<repo>', 'name of a repository already cloned into your workspace')
    .option('-o, --owner <owner>', 'organisation, group or user that owns the repositories')
    .addHelpText(
      'after',
      `
A child process cannot change your shell's working directory for you, so this
is what a \`cd\` wrapper function shells out to:

  $ cd "$(gitx pwd my-repo)"
`,
    )
    .action(async (repo: string) => {
      process.exitCode = await runPwd(await getContext(), repo);
    });

/**
 * Runs `gitx pwd`, printing a cloned repository's working directory.
 *
 * @param context Resolved {@link Context}.
 * @param repo Name of a repository already cloned into the workspace.
 * @param [stdout=process.stdout] Stream to write the directory to.
 * @returns The process exit code.
 * @throws GitxError If the repository has not been cloned.
 */
export const runPwd = async (
  context: Context,
  repo: string,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<number> => {
  const workspace = await context.workspace();
  const dir = await workspace.requireDir(repo);

  stdout.write(`${dir}\n`);
  return ExitCode.Ok;
};
