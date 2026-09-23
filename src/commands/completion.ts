import { Command } from 'commander';
import { CONFIG_KEYS } from '../config/schema.ts';
import { ExitCode, GitxError } from '../util/errors.ts';

type ArgKind = 'repos' | 'missing' | 'config-keys' | 'shells' | 'none';

interface CommandSpec {
  aliases: string[];
  args: ArgKind;
  description: string;
  name: string;
  options: string[];
  subcommands: CommandSpec[];
  // Flags that consume the next word, so it must not be completed as an argument.
  valueFlags: string[];
}

const ARG_KINDS: Record<string, ArgKind> = {
  clone: 'missing',
  'clone-all': 'missing',
  completion: 'shells',
  list: 'repos',
  open: 'repos',
  pwd: 'repos',
  runs: 'repos',
  update: 'repos',
};

const ARG_KINDS_FOR_CONFIG: ReadonlySet<string> = new Set(['get', 'set', 'unset']);

const CONFIG_KEY_NAMES = CONFIG_KEYS.filter((def) => !def.key.includes('*')).map(
  (def) => def.display,
);

const argSource = (kind: ArgKind): string => {
  switch (kind) {
    case 'repos':
      return 'words="$(_gitx_repos)"';
    case 'missing':
      return 'words="$(_gitx_missing)"';
    case 'config-keys':
      return `words=${quote(CONFIG_KEY_NAMES.join(' '))}`;
    case 'shells':
      return `words=${quote(SHELLS.join(' '))}`;
    case 'none':
      return 'words=""';
  }
};

const bashScript = (
  commands: readonly CommandSpec[],
  allGlobals: readonly string[],
  globals: readonly string[],
  globalValueFlags: readonly string[],
  self: string,
): string => {
  const names = commands.flatMap((command) => [command.name, ...command.aliases]);

  const optionCases = commands
    .map((command) => {
      const match = [command.name, ...command.aliases].join('|');
      return `    ${match}) opts=${quote(merge(command.options, globals).join(' '))} ;;`;
    })
    .join('\n');

  // Value-taking flags are per command: `-a` means `--after` for `update` but `--all` for `list`,
  // and only one of them swallows the next word.
  const valueCases = commands
    .filter((command) => command.valueFlags.length > 0)
    .map((command) => {
      const match = [command.name, ...command.aliases].join('|');
      return `    ${match}) valued="$valued${command.valueFlags.join('|')}|" ;;`;
    })
    .join('\n');

  const argCases = commands
    .filter((command) => command.args !== 'none' || command.subcommands.length > 0)
    .map((command) => {
      const match = [command.name, ...command.aliases].join('|');
      const sub =
        command.subcommands.length > 0
          ? `words=${quote(command.subcommands.flatMap((s) => [s.name, ...s.aliases]).join(' '))}`
          : argSource(command.args);
      return `    ${match}) ${sub} ;;`;
    })
    .join('\n');

  const configSubcommands =
    commands.find((command) => command.name === 'config')?.subcommands ?? [];
  const configKeyCases = configSubcommands
    .filter((sub) => ARG_KINDS_FOR_CONFIG.has(sub.name))
    .map((sub) => sub.name)
    .join('|');

  return `# gitx completion for bash
# Install: gitx completion bash > ~/.local/share/bash-completion/completions/gitx

_gitx_aliases() {
  ${self} config list 2>/dev/null | awk -F= '/^alias[.]/ { sub(/^alias[.]/, "", $1); print $1 }'
}

_gitx_repos() {
  ${self} list --porcelain 2>/dev/null
}

_gitx_missing() {
  ${self} list --missing --porcelain 2>/dev/null
}

_gitx() {
  local cur prev command subcommand i opts words valued
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  command=""
  subcommand=""
  valued="|${globalValueFlags.join('|')}|"

  for (( i=1; i < COMP_CWORD; i++ )); do
    # The word right after a value-taking global flag is that flag's value,
    # e.g. the \`acme\` in \`gitx --owner acme update\` -- not the command.
    if [[ "$valued" == *"|\${COMP_WORDS[i-1]}|"* ]]; then
      continue
    fi
    case "\${COMP_WORDS[i]}" in
      -*) continue ;;
    esac
    if [[ -z "$command" ]]; then
      command="\${COMP_WORDS[i]}"
    elif [[ -z "$subcommand" ]]; then
      subcommand="\${COMP_WORDS[i]}"
    fi
  done

  case "$command" in
${valueCases}
  esac

  # The word after a value-taking flag is that flag's value, not an argument.
  if [[ "$valued" == *"|$prev|"* ]]; then
    COMPREPLY=()
    return 0
  fi

  if [[ -z "$command" ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W ${quote(allGlobals.join(' '))} -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "${names.join(' ')} $(_gitx_aliases)" -- "$cur") )
    fi
    return 0
  fi

  if [[ "$cur" == -* ]]; then
    opts=${quote(allGlobals.join(' '))}
    case "$command" in
${optionCases}
    esac
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return 0
  fi

  if [[ "$command" == "config" && -n "$subcommand" ]]; then
    case "$subcommand" in
      ${configKeyCases}) COMPREPLY=( $(compgen -W ${quote(CONFIG_KEY_NAMES.join(' '))} -- "$cur") ) ;;
      *) COMPREPLY=() ;;
    esac
    return 0
  fi

  words=""
  case "$command" in
${argCases}
  esac

  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
  return 0
}

complete -F _gitx gitx
`;
};

// Root flags worth suggesting for *every* command, as opposed to merging in regardless of whether a
// given command does anything with them.
//
// A root option that's also declared directly on some commands -- owner, provider, host,
// concurrency -- is meant for just those (see `addRemoteOptions`/`addConcurrencyOption`), so it's
// excluded here rather than suggested for every command too: `gitx open --concurrency` parses,
// since commander accepts a root option anywhere, but open never reads it.
const commandGlobals = (program: Command, commands: readonly CommandSpec[]): string[] => {
  const scoped = new Set(commands.flatMap((command) => command.options));
  return optionFlags(program).filter((flag) => !scoped.has(flag));
};

const describe = (parent: Command): CommandSpec[] =>
  parent
    .createHelp()
    // `visibleCommands` is how commander's own help filters hidden commands.
    .visibleCommands(parent)
    .filter((command) => command.name() !== 'help')
    .map((command) => ({
      name: command.name(),
      aliases: command.aliases(),
      description: command.description(),
      options: optionFlags(command),
      valueFlags: valueFlags(command),
      args: ARG_KINDS[command.name()] ?? 'none',
      subcommands: describe(command),
    }));

const fishArgSource = (kind: ArgKind): string | undefined => {
  switch (kind) {
    case 'repos':
      return '(__gitx_repos)';
    case 'missing':
      return '(__gitx_missing)';
    case 'shells':
      return SHELLS.join(' ');
    case 'config-keys':
      return CONFIG_KEY_NAMES.join(' ');
    case 'none':
      return undefined;
  }
};

const fishFlag = (flag: string, takesValue: boolean): string => {
  const base = flag.startsWith('--') ? `-l ${flag.slice(2)}` : `-s ${flag.slice(1)}`;
  // `-r` stops fish offering the next word as a positional argument.
  return takesValue ? `${base} -r` : base;
};

const fishScript = (
  commands: readonly CommandSpec[],
  globals: readonly string[],
  globalValueFlags: readonly string[],
  self: string,
): string => {
  const lines: string[] = [
    '# gitx completion for fish',
    '# Install: gitx completion fish > ~/.config/fish/completions/gitx.fish',
    '',
    'function __gitx_aliases',
    `  ${self} config list 2>/dev/null | awk -F= '/^alias[.]/ { sub(/^alias[.]/, "", $1); print $1 }'`,
    'end',
    '',
    'function __gitx_repos',
    `  ${self} list --porcelain 2>/dev/null`,
    'end',
    '',
    'function __gitx_missing',
    `  ${self} list --missing --porcelain 2>/dev/null`,
    'end',
    '',
    '# Subcommands are only offered before one has been chosen.',
    "complete -c gitx -n __fish_use_subcommand -a '(__gitx_aliases)' -d 'alias'",
  ];

  for (const command of commands) {
    for (const name of [command.name, ...command.aliases]) {
      lines.push(
        `complete -c gitx -n __fish_use_subcommand -a ${quote(name)} -d ${quote(
          command.description,
        )}`,
      );
    }
  }

  lines.push('', '# Global options.');
  for (const flag of globals) {
    lines.push(`complete -c gitx ${fishFlag(flag, globalValueFlags.includes(flag))}`);
  }

  lines.push('', '# Per-command options.');
  for (const command of commands) {
    const condition = `__fish_seen_subcommand_from ${[command.name, ...command.aliases].join(' ')}`;
    for (const flag of command.options) {
      lines.push(
        `complete -c gitx -n ${quote(condition)} ${fishFlag(
          flag,
          command.valueFlags.includes(flag) || globalValueFlags.includes(flag),
        )}`,
      );
    }

    const source = fishArgSource(command.args);
    if (source) {
      lines.push(`complete -c gitx -n ${quote(condition)} -f -a ${quote(source)}`);
    }

    for (const sub of command.subcommands) {
      lines.push(
        `complete -c gitx -n ${quote(condition)} -a ${quote(sub.name)} -d ${quote(
          sub.description,
        )}`,
      );
      if (ARG_KINDS_FOR_CONFIG.has(sub.name)) {
        lines.push(
          `complete -c gitx -n ${quote(
            `${condition}; and __fish_seen_subcommand_from ${sub.name}`,
          )} -f -a ${quote(CONFIG_KEY_NAMES.join(' '))}`,
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
};

const isShell = (value: string): value is Shell => (SHELLS as readonly string[]).includes(value);

// Combines flag lists, dropping duplicates and keeping a stable order.
const merge = (...lists: readonly (readonly string[])[]): string[] =>
  [...new Set(lists.flat())].toSorted();

// Every long and short flag a command accepts, including negations.
const optionFlags = (command: Command): string[] => {
  const flags = new Set<string>();
  for (const option of command.options) {
    if (option.short) flags.add(option.short);
    if (option.long) flags.add(option.long);
  }
  flags.add('-h');
  flags.add('--help');
  return [...flags].toSorted();
};

// Single-quotes a value for embedding in a generated shell script.
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

// Flags of `command` that take a value, so the following word is not an argument.
const valueFlags = (command: Command): string[] => {
  const flags = new Set<string>();
  for (const option of command.options) {
    if (!option.required && !option.optional) continue;
    if (option.short) flags.add(option.short);
    if (option.long) flags.add(option.long);
  }
  return [...flags].toSorted();
};

const zshArgBody = (kind: ArgKind): string => {
  switch (kind) {
    case 'repos':
      return '          _gitx_repos';
    case 'missing':
      return '          _gitx_missing';
    case 'config-keys':
      return `          _values 'key' ${CONFIG_KEY_NAMES.map((key) => quote(key)).join(' ')}`;
    case 'shells':
      return `          _values 'shell' ${SHELLS.map((shell) => quote(shell)).join(' ')}`;
    case 'none':
      return '          _default';
  }
};

const zshScript = (
  commands: readonly CommandSpec[],
  globals: readonly string[],
  self: string,
): string => {
  const describeList = commands
    .flatMap((command) => [command.name, ...command.aliases].map((name) => ({ name, command })))
    .map(({ name, command }) => quote(`${name}:${command.description.replaceAll(':', ' -')}`))
    .join('\n    ');

  const argCases = commands
    .map((command) => {
      const match = [command.name, ...command.aliases].join('|');
      const options = merge(command.options, globals);

      if (command.subcommands.length > 0) {
        const subs = command.subcommands
          .flatMap((sub) => [sub.name, ...sub.aliases].map((name) => ({ name, sub })))
          .map(({ name, sub }) => quote(`${name}:${sub.description.replaceAll(':', ' -')}`))
          .join('\n            ');
        return `      ${match})
        if (( CURRENT == 2 )); then
          local -a subcommands
          subcommands=(
            ${subs}
          )
          _describe 'subcommand' subcommands
        else
          case "\${words[2]}" in
            get|set|unset) _values 'key' ${CONFIG_KEY_NAMES.map((key) => quote(key)).join(' ')} ;;
            *) _values 'option' ${options.map((flag) => quote(flag)).join(' ')} ;;
          esac
        fi
        ;;`;
      }

      return `      ${match})
        if [[ "\${words[CURRENT]}" == -* ]]; then
          _values 'option' ${options.map((flag) => quote(flag)).join(' ')}
        else
${zshArgBody(command.args)}
        fi
        ;;`;
    })
    .join('\n');

  return `#compdef gitx gitx.js
# gitx completion for zsh
# Install: gitx completion zsh > "\${fpath[1]}/_gitx"

_gitx_aliases() {
  local -a aliases
  aliases=( \${(f)"$(${self} config list 2>/dev/null | awk -F= '/^alias[.]/ { sub(/^alias[.]/, "", $1); print $1 }')"} )
  _describe 'alias' aliases
}

_gitx_repos() {
  local -a repos
  repos=( \${(f)"$(${self} list --porcelain 2>/dev/null)"} )
  _describe 'repository' repos
}

_gitx_missing() {
  local -a repos
  repos=( \${(f)"$(${self} list --missing --porcelain 2>/dev/null)"} )
  _describe 'repository' repos
}

_gitx() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '1: :->command' \\
    '*:: :->argument'

  case "$state" in
    command)
      local -a commands
      commands=(
    ${describeList}
      )
      _describe 'command' commands
      _gitx_aliases
      ;;
    argument)
      case "$words[1]" in
${argCases}
        *) _default ;;
      esac
      ;;
  esac
}

# Autoloaded by compinit (the file's content becomes _gitx's body, so this
# runs already inside a real completion call): perform the completion.
# Eval'd or sourced directly instead: just register the function above with
# the completion system for zsh to call later, when it is actually needed.
#
# Registered for gitx.js too: a plain \`alias gitx=~/path/to/bin/gitx.js\`
# (common when running from a source checkout instead of an npm install) is
# expanded by zsh's completion system before it looks anything up, so it
# dispatches on the target's basename, not the alias name.
if [[ "$funcstack[1]" == "_gitx" ]]; then
  _gitx "$@"
else
  compdef _gitx gitx gitx.js
fi
`;
};

/**
 * A shell {@link generateCompletion} can produce a completion script for.
 */
export type Shell = (typeof SHELLS)[number];

/**
 * Shells supported by `gitx completion`.
 */
export const SHELLS = Object.freeze(['bash', 'zsh', 'fish'] as const);

/**
 * Builds the `completion` command.
 *
 * @param getProgram Lazily resolves the live commander program to generate completions from.
 * @returns The configured `completion` {@link Command}.
 */
export const completionCommand = (getProgram: () => Command): Command =>
  new Command('completion')
    .description('Print a shell completion script')
    .argument('<shell>', `the shell to generate for (${SHELLS.join(', ')})`)
    .addHelpText(
      'after',
      `
Install it once, so a new shell can complete for you:

  bash   $ gitx completion bash > ~/.local/share/bash-completion/completions/gitx
  zsh    $ gitx completion zsh > "\${fpath[1]}/_gitx"
  fish   $ gitx completion fish > ~/.config/fish/completions/gitx.fish

Or regenerate it every time a shell starts, so an upgrade can never leave it
stale (zsh needs this run after \`compinit\`):

  bash   $ echo 'source <(gitx completion bash)' >> ~/.bashrc
  zsh    $ echo 'eval "$(gitx completion zsh)"' >> ~/.zshrc
  fish   $ echo 'gitx completion fish | source' >> ~/.config/fish/config.fish

Repository names are completed by calling \`gitx list --porcelain\`, so they stay
correct as your workspace changes. Completing an argument to \`clone\` asks your
provider what exists, so it needs a token and may pause briefly.
`,
    )
    .action((shell: string) => {
      // The exact file that got us running, rather than the bare word `gitx`: a shell alias to it
      // (`alias gitx=~/checkout/bin/gitx.js`, common for a source checkout) is not reliably
      // resolved from deep inside a shell's completion machinery, so the generated script would
      // otherwise shell back into a command that doesn't exist.
      process.stdout.write(generateCompletion(getProgram(), shell, process.argv[1]));
    });

/**
 * Builds a completion script for `shell` from the live commander program.
 *
 * @param program The live commander program to introspect.
 * @param shell Shell to generate a completion script for.
 * @param [self='gitx'] Command invoked to run gitx, embedded in the generated script.
 * @returns The generated completion script.
 * @throws GitxError If `shell` is not one of {@link SHELLS}.
 */
export const generateCompletion = (program: Command, shell: string, self = 'gitx'): string => {
  if (!isShell(shell)) {
    throw new GitxError(`unsupported shell: ${shell}`, {
      code: ExitCode.Usage,
      hint: `Supported shells are ${SHELLS.join(', ')}.`,
    });
  }

  const commands = describe(program);
  const allGlobals = optionFlags(program);
  const globals = commandGlobals(program, commands);
  const globalValueFlags = valueFlags(program);
  const quotedSelf = quote(self);

  switch (shell) {
    case 'bash':
      return bashScript(commands, allGlobals, globals, globalValueFlags, quotedSelf);
    case 'zsh':
      return zshScript(commands, globals, quotedSelf);
    case 'fish':
      return fishScript(commands, globals, globalValueFlags, quotedSelf);
  }
};
