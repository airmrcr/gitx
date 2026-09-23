import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli.ts';
import { generateCompletion, SHELLS } from '../../src/commands/completion.ts';
import { CONFIG_KEYS } from '../../src/config/schema.ts';
import { isGitxError } from '../../src/util/errors.ts';

const run = promisify(execFile);

const program = createProgram();
const commandNames = program.commands.flatMap((command) =>
  command.name() === 'help' ? [] : [command.name(), ...command.aliases()],
);

// Returns the error a synchronous call threw, so assertions stay unconditional.
const captureError = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
};

const complete = async (words: readonly string[]) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-comp-'));
  const file = path.join(dir, 'gitx.bash');
  await writeFile(file, generateCompletion(program, 'bash'));

  const harness = [
    `source ${JSON.stringify(file)}`,
    // Stand in for the real binary so no network or workspace is needed.
    'gitx() { if [[ "$2" == "--missing" ]]; then printf "remote-a\\n"; else printf "local-a\\n"; fi; }',
    `COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(' ')})`,
    `COMP_CWORD=${words.length - 1}`,
    '_gitx',
    'printf "%s\\n" "${COMPREPLY[@]}"',
  ].join('\n');

  try {
    const { stdout } = await run('bash', ['-c', harness]);
    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

// `eval`s the zsh script the way `eval "$(gitx completion zsh)"` in `.zshrc` would, with `compinit`
// already run first. Skips if zsh is unavailable.
//
// A broken script does not make the shell exit non-zero here: zsh's completion system reports the
// failure by printing to stderr, not by failing the command that triggered it. The exit code alone
// would miss exactly the bug this guards against, so stderr has to be inspected too.
const evalCheck = async (script: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-comp-'));
  const file = path.join(dir, '_gitx');
  await writeFile(file, script);

  const args = [
    '--no-rcs',
    '-c',
    `autoload -Uz compinit; compinit -u -d ${JSON.stringify(path.join(dir, 'zcompdump'))}; eval "$(cat ${JSON.stringify(file)})"`,
  ];

  try {
    const { stderr } = await run('zsh', args);
    return stderr.includes('can only be called from completion function') ? 'error' : 'ok';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'error';
  }
};

// Runs `shell -n script` if that shell exists, otherwise skips the check.
const syntaxCheck = async (shell: string, script: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gitx-comp-'));
  const file = path.join(dir, 'script');
  await writeFile(file, script);

  try {
    await run(shell, ['-n', file]);
    return 'ok';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
};

describe('generateCompletion', () => {
  it('rejects an unknown shell with a usage error', () => {
    const error = captureError(() => generateCompletion(program, 'powershell'));

    expect(isGitxError(error)).toBe(true);
    expect((error as Error).message).toMatch(/unsupported shell/);
    expect(isGitxError(error) ? error.hint : '').toContain('bash');
  });

  for (const shell of SHELLS) {
    describe(`${shell}`, () => {
      const script = generateCompletion(program, shell);

      it('mentions every command and alias', () => {
        for (const name of commandNames) {
          expect(script, `${shell} script is missing '${name}'`).toContain(name);
        }
      });

      it('completes configuration keys', () => {
        const key = CONFIG_KEYS.find((def) => def.display === 'core.baseDir');
        expect(script).toContain(key?.display);
      });

      it('shells back into gitx for repository names', () => {
        // `--porcelain` matters: without it the markers would be completed too. Quoted, not the
        // bare word `gitx`: see the `self` tests below.
        expect(script).toContain("'gitx' list --porcelain");
        expect(script).toContain("'gitx' list --missing --porcelain");
      });

      it('never emits an unescaped single quote inside a quoted word', () => {
        // Descriptions contain apostrophes; they must be escaped when embedded.
        expect(script).not.toMatch(/'[^'\n]*remote's/);
      });
    });
  }

  it('produces a valid bash script', async () => {
    const result = await syntaxCheck('bash', generateCompletion(program, 'bash'));
    expect(result === 'ok' || result === 'absent').toBe(true);
  });

  it('produces a valid zsh script', async () => {
    const result = await syntaxCheck('zsh', generateCompletion(program, 'zsh'));
    expect(result === 'ok' || result === 'absent').toBe(true);
  });

  it('starts the zsh script with the compdef tag', () => {
    expect(generateCompletion(program, 'zsh').startsWith('#compdef gitx')).toBe(true);
  });

  // zsh's completion system resolves a plain alias to its expansion before looking anything up, and
  // dispatches on the expansion's basename -- so `alias gitx=~/path/to/bin/gitx.js` (common when
  // running from a source checkout rather than an npm install) needs completion registered under
  // `gitx.js` too, or it silently falls back to default file completion.
  it('registers under gitx.js as well, for a plain alias to bin/gitx.js', () => {
    const script = generateCompletion(program, 'zsh');
    expect(script.startsWith('#compdef gitx gitx.js')).toBe(true);
    expect(script).toContain('compdef _gitx gitx gitx.js');
  });

  // `eval "$(gitx completion zsh)"` in `.zshrc` runs the whole script as plain top-level
  // statements, not as `_gitx`'s autoloaded body, so unconditionally calling `_gitx` at the end
  // would invoke `_arguments` outside a completion widget and fail with "can only be called from
  // completion function".
  it('registers rather than calls itself when not autoloaded as a completion widget', () => {
    const script = generateCompletion(program, 'zsh');
    expect(script).toMatch(/funcstack\[1\]/);
    expect(script).toContain('compdef _gitx gitx');
  });

  it('runs without error when evaluated directly, as .zshrc would', async () => {
    const result = await evalCheck(generateCompletion(program, 'zsh'));
    expect(result === 'ok' || result === 'absent').toBe(true);
  });

  // `_values` treats a `name:message` spec as "this value itself takes a further argument",
  // auto-appending `=` after completing it -- so `gitx op<TAB>` was completing to `gitx open=`
  // instead of `gitx open`. Plain name/description pairs need `_describe`, the way `_gitx_aliases`,
  // `_gitx_repos` and `_gitx_missing` already use it.
  it('uses _describe, not _values, for command names with descriptions', () => {
    const script = generateCompletion(program, 'zsh');
    expect(script).toContain("_describe 'command' commands");
    expect(script).not.toMatch(/_values 'command'/);
  });

  it('uses _describe, not _values, for subcommand names with descriptions', () => {
    const script = generateCompletion(program, 'zsh');
    expect(script).toContain("_describe 'subcommand' subcommands");
    expect(script).not.toMatch(/_values 'subcommand'/);
  });

  // `_arguments`'s `*::` rewrites `$words`/`$CURRENT` to be relative to the subcommand itself, so
  // completing the subcommand's own name (`gitx config <TAB>`) is CURRENT==2, not 3 -- off by one
  // meant it always fell through to the options branch and never offered a subcommand.
  it('checks the rebased word position, not the original one, for subcommand completion', () => {
    const script = generateCompletion(program, 'zsh');
    expect(script).toContain('CURRENT == 2');
    expect(script).not.toContain('CURRENT == 3');
  });

  it('still offers plain option and config-key lists via _values', () => {
    const script = generateCompletion(program, 'zsh');
    expect(script).toContain("_values 'option'");
    expect(script).toContain("_values 'key'");
  });

  it('registers the bash completion function', () => {
    expect(generateCompletion(program, 'bash')).toContain('complete -F _gitx gitx');
  });

  it('knows which options take a value', () => {
    const script = generateCompletion(program, 'bash');
    // `update -a` is `--after` and takes a value; `list -a` is `--all` and does not.
    expect(script).toMatch(/update\) valued="\$valued[^"]*--after\|/);
    expect(script).toMatch(/update\) valued="\$valued[^"]*\|-a\|/);
    expect(script).not.toMatch(/list\) valued="\$valued[^"]*\|-a\|/);
  });

  // A plain `alias gitx=~/checkout/bin/gitx.js` is not reliably resolved from deep inside a shell's
  // own completion machinery (zsh in particular), so the script shells back into whatever it was
  // actually run as, quoted -- not the bare word `gitx`, which may not be a real command at all.
  describe('shelling back into itself', () => {
    const self = '/opt/gitx/bin/gitx.js';

    it.each(SHELLS)('uses the given path for %s, not the bare word gitx', (shell) => {
      const script = generateCompletion(program, shell, self);
      expect(script).toContain(`'${self}' list --porcelain`);
      expect(script).toContain(`'${self}' list --missing --porcelain`);
      expect(script).toContain(`'${self}' config list`);
      expect(script).not.toContain('gitx list --porcelain');
      expect(script).not.toContain('gitx list --missing --porcelain');
      expect(script).not.toContain('gitx config list');
    });

    it('quotes a path containing a space', () => {
      const script = generateCompletion(program, 'bash', '/path with space/gitx.js');
      expect(script).toContain("'/path with space/gitx.js' list --porcelain");
    });

    it('defaults to the bare word gitx, quoted, when nothing is given', () => {
      expect(generateCompletion(program, 'bash')).toContain("'gitx' list --porcelain");
    });
  });
});

describe('bash completion behaviour', () => {
  it('completes command names', async () => {
    const reply = await complete(['gitx', 'co']);
    if (reply.length === 0) return;
    expect(reply.toSorted()).toEqual(['completion', 'config']);
  });

  it('completes cloned repositories for update', async () => {
    const reply = await complete(['gitx', 'update', '']);
    if (reply.length === 0) return;
    expect(reply).toEqual(['local-a']);
  });

  it('completes uncloned repositories for clone', async () => {
    const reply = await complete(['gitx', 'clone', '']);
    if (reply.length === 0) return;
    expect(reply).toEqual(['remote-a']);
  });

  it('offers no argument after a flag that takes a value', async () => {
    expect(await complete(['gitx', 'update', '--after', ''])).toEqual([]);
  });

  it('still completes repositories after a boolean flag', async () => {
    const reply = await complete(['gitx', 'list', '-a', '']);
    if (reply.length === 0) return;
    expect(reply).toEqual(['local-a']);
  });

  // `--concurrency` only ever does anything for a command that sweeps repositories in parallel;
  // suggesting it for `open` would be misleading, since commander would still accept it there
  // without it doing anything.
  it('does not offer --concurrency for a command that never sweeps', async () => {
    const reply = await complete(['gitx', 'open', '--']);
    if (reply.length === 0) return;
    expect(reply).not.toContain('--concurrency');
    expect(reply).toContain('--owner');
  });

  it('still offers --concurrency for a command that does', async () => {
    const reply = await complete(['gitx', 'update', '--']);
    if (reply.length === 0) return;
    expect(reply).toContain('--concurrency');
  });

  it('completes configuration keys for config set', async () => {
    const reply = await complete(['gitx', 'config', 'set', 'core.b']);
    if (reply.length === 0) return;
    expect(reply).toEqual(['core.baseDir']);
  });

  it('completes shells for completion', async () => {
    const reply = await complete(['gitx', 'completion', '']);
    if (reply.length === 0) return;
    expect(reply.toSorted()).toEqual([...SHELLS].toSorted());
  });

  // A value-taking global flag before the command (`-o`, `-H`, `-P`, `-j`, `--config`, `--color`)
  // must not have its value mistaken for the command itself, the way an unrelated `-*` flag with no
  // value is skipped. Asserted unconditionally, unlike the other cases here: a regression makes
  // this silently return nothing, which the usual "skip if bash is absent" escape would otherwise
  // mistake for a passing, bash-less environment.
  it('still finds the command after a global flag that took a value', async () => {
    expect(await complete(['gitx', '--owner', 'acme', 'update', ''])).toEqual(['local-a']);
  });

  it('still finds the command after a short global flag that took a value', async () => {
    expect(await complete(['gitx', '-j', '4', 'update', ''])).toEqual(['local-a']);
  });
});
