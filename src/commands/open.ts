import { spawn } from 'node:child_process';
import { Command } from 'commander';
import type { Context } from '../context.ts';
import { ExitCode, GitxError } from '../util/errors.ts';
import { hasExecutable } from '../util/exec.ts';
import { formatCommand } from '../util/theme.ts';
import { splitWords } from '../util/words.ts';

/**
 * Options for `gitx open`.
 */
export interface OpenOptions {
  /** Editor command to use for this run, without remembering it as `core.editor`. */
  editor?: string;
}

/**
 * Runs the editor with the terminal handed to it, resolving with its exit code.
 *
 * @param command Editor executable to run.
 * @param args Arguments to pass, including the repository path.
 * @returns The editor's exit code (or `128` if it was terminated by a signal).
 * @throws GitxError If the editor command cannot be run.
 */
export const launchEditor = (command: string, args: readonly string[]): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });

    child.on('error', (error) => {
      reject(
        new GitxError(`unable to run editor: ${command}`, {
          code: ExitCode.MissingCommand,
          cause: error,
        }),
      );
    });

    // A signalled child reports no exit code; mirror the shell's 128+n.
    child.on('close', (code, signal) => {
      resolve(signal ? 128 : (code ?? 0));
    });
  });

/**
 * Builds the `open` command.
 *
 * @param getContext Lazily resolves the current {@link Context}.
 * @returns The configured `open` {@link Command}.
 */
export const openCommand = (getContext: () => Promise<Context>): Command =>
  new Command('open')
    .description('Open a cloned repository in your editor')
    .argument('<repo>', 'name of a repository already cloned into your workspace')
    .option('-e, --editor <command>', 'editor command to use for this run, without remembering it')
    .option('-o, --owner <owner>', 'organisation, group or user that owns the repositories')
    .addHelpText(
      'after',
      `
The command that opens your editor is asked for once and remembered as
\`core.editor\`:

  $ gitx config set core.editor 'code -n'

See \`gitx pwd\` to resolve a repository's path without opening it.
`,
    )
    .action(async (repo: string, options: OpenOptions) => {
      process.exitCode = await runOpen(await getContext(), repo, options);
    });

/**
 * Runs `gitx open`, launching the configured editor on a cloned repository.
 *
 * @param context Resolved {@link Context}.
 * @param repo Name of a repository already cloned into the workspace.
 * @param options The options to be used.
 * @param [stdout=process.stdout] Stream to write the launched command to.
 * @returns The editor process's exit code.
 * @throws GitxError If the repository has not been cloned, `core.editor` is empty, or the editor
 * command is not found.
 */
export const runOpen = async (
  context: Context,
  repo: string,
  options: OpenOptions,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<number> => {
  const workspace = await context.workspace();
  const dir = await workspace.requireDir(repo);

  const [command, ...args] = splitWords(await context.editor(repo, options.editor));
  if (command === undefined) {
    throw new GitxError('core.editor is empty', {
      code: ExitCode.Config,
      hint: 'Run `gitx config set core.editor <command>`.',
    });
  }

  if (!hasExecutable(command)) {
    throw new GitxError(`editor command not found: ${command}`, {
      code: ExitCode.MissingCommand,
      hint: 'Install it, or run `gitx config set core.editor <command>` to use something else.',
    });
  }

  const editorArgs = [...args, dir];
  stdout.write(`${formatCommand(command, editorArgs)}\n`);
  return launchEditor(command, editorArgs);
};
