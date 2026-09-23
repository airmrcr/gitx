import { main, reportError } from './cli.ts';
import { ExitCode } from './util/errors.ts';

// Executable entry point. Kept separate from `cli.ts` so that importing the library never runs the
// CLI as a side effect.

const controller = new AbortController();

const handleFatal = (error: unknown): void => {
  // Every command action and task is caught well before here; reaching this means a bug let
  // something slip past that net. Report it the same way as any other error instead of crashing
  // with a raw stack trace and the cursor left hidden.
  restoreCursor();
  process.exitCode = reportError(error);
};

const restoreCursor = (): void => {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.isTTY) stream.write('\u001B[?25h');
  }
};

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  // Writing to a closed pipe (`gitx update | head`) is not an error worth a stack trace.
  if (error.code === 'EPIPE') process.exit(ExitCode.Ok);
});

process.on('uncaughtException', handleFatal);
process.on('unhandledRejection', handleFatal);

process.on('SIGINT', () => {
  // A second Ctrl-C means "stop waiting": the first already asked whatever is in flight to wind
  // down; give up on that and leave immediately instead of risking a hang.
  if (controller.signal.aborted) {
    restoreCursor();
    process.exit(ExitCode.Aborted);
  } else {
    controller.abort();
  }
});

const code = await main(process.argv, controller.signal);
// The live sweep renderer hides the cursor on stdout; the single-action spinner (`withSpinner`)
// hides it on stderr instead, so an abort mid-render must restore whichever of the two actually
// reached a terminal -- writing to a redirected, non-TTY stream would just inject raw escape bytes
// into a file.
if (controller.signal.aborted) restoreCursor();
process.exitCode = controller.signal.aborted ? ExitCode.Aborted : code;
