import { Command, InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli.ts';
import {
  addConcurrencyOption,
  addRemoteOptions,
  nearestOption,
  parseConcurrency,
  parseLimit,
} from '../../src/commands/options.ts';

const flagsOf = (command: Command) =>
  command.options.map((option) => option.long ?? option.short ?? '');

const noop = () => {};

const subcommand = (name: string) => {
  const found = createProgram().commands.find(
    (command) => command.name() === name || command.aliases().includes(name),
  );
  if (!found) throw new Error(`no such command: ${name}`);
  return found;
};

// A three-deep command tree where every level accepts `--owner`.
const tree = () => {
  const program = new Command('gitx').exitOverride().option('-o, --owner <owner>');
  const child = new Command('list').option('-o, --owner <owner>').action(noop);
  const grandchild = new Command('inner').option('-o, --owner <owner>').action(noop);
  child.addCommand(grandchild);
  program.addCommand(child);
  return { program, child, grandchild };
};

describe('addRemoteOptions', () => {
  it('adds all three by default', () => {
    const flags = flagsOf(addRemoteOptions(new Command('demo')));

    expect(flags).toEqual(['--host', '--owner', '--provider']);
  });

  it('can leave out the owner', () => {
    const flags = flagsOf(addRemoteOptions(new Command('demo'), { owner: false }));

    expect(flags).toEqual(['--host', '--provider']);
  });

  it('returns the command so it can be chained', () => {
    const command = new Command('demo');

    expect(addRemoteOptions(command)).toBe(command);
  });

  it('keeps the short flags stable, because people type them', () => {
    const shorts = addRemoteOptions(new Command('demo')).options.map((option) => option.short);

    expect(shorts).toEqual(['-H', '-o', '-P']);
  });
});

describe('parseConcurrency', () => {
  it('accepts auto and unlimited unchanged', () => {
    expect(parseConcurrency('auto')).toBe('auto');
    expect(parseConcurrency('unlimited')).toBe('unlimited');
  });

  it('accepts a non-negative integer unchanged', () => {
    expect(parseConcurrency('0')).toBe('0');
    expect(parseConcurrency('4')).toBe('4');
  });

  it.each(['-1', 'nope', ''])('rejects %s', (value) => {
    expect(() => parseConcurrency(value)).toThrow(InvalidArgumentError);
  });
});

describe('parseLimit', () => {
  it('accepts a positive integer unchanged', () => {
    expect(parseLimit('1')).toBe('1');
    expect(parseLimit('1000')).toBe('1000');
  });

  it.each(['0', '-1', 'nope', '', '4.5', '4x'])('rejects %s', (value) => {
    expect(() => parseLimit(value)).toThrow(InvalidArgumentError);
  });
});

describe('addConcurrencyOption', () => {
  it('adds -j, --concurrency', () => {
    const flags = flagsOf(addConcurrencyOption(new Command('demo')));

    expect(flags).toEqual(['--concurrency']);
    expect(addConcurrencyOption(new Command('demo')).options[0]?.short).toBe('-j');
  });

  it('returns the command so it can be chained', () => {
    const command = new Command('demo');

    expect(addConcurrencyOption(command)).toBe(command);
  });

  it('validates the value the same way the global option does', () => {
    const command = addConcurrencyOption(new Command('demo').exitOverride())
      .configureOutput({ writeErr: () => {} })
      .action(() => {});

    expect(() => command.parse(['--concurrency', 'nope'], { from: 'user' })).toThrow(
      /non-negative integer/,
    );
  });
});

describe('nearestOption', () => {
  it('reads the option off the command itself', () => {
    const { program, child } = tree();
    program.parse(['list', '-o', 'acme'], { from: 'user' });

    expect(nearestOption(child, 'owner')).toBe('acme');
  });

  it('falls back to an ancestor', () => {
    const { program, child } = tree();
    program.parse(['-o', 'acme', 'list'], { from: 'user' });

    expect(nearestOption(child, 'owner')).toBe('acme');
  });

  // The option written next to the command is the more specific instruction, which is the opposite
  // of commander's own `optsWithGlobals`.
  it('prefers the nearest when both are given', () => {
    const { program, child } = tree();
    program.parse(['-o', 'outer', 'list', '-o', 'inner'], { from: 'user' });

    expect(nearestOption(child, 'owner')).toBe('inner');
  });

  it('walks past a command that was not given the option', () => {
    const { program, grandchild } = tree();
    program.parse(['-o', 'acme', 'list', 'inner'], { from: 'user' });

    expect(nearestOption(grandchild, 'owner')).toBe('acme');
  });

  it('returns undefined when nobody was given it', () => {
    const { program, child } = tree();
    program.parse(['list'], { from: 'user' });

    expect(nearestOption(child, 'owner')).toBeUndefined();
  });

  it('returns undefined for no command at all', () => {
    expect(nearestOption(undefined, 'owner')).toBeUndefined();
  });
});

describe('the commands that accept a remote override', () => {
  it.each(['runs', 'clone', 'clone-all', 'list', 'update'])(
    '%s takes an owner, provider and host',
    (name) => {
      const flags = flagsOf(subcommand(name));

      expect(flags).toEqual(expect.arrayContaining(['--owner', '--provider', '--host']));
    },
  );

  // Signing in is per-host; there is no owner involved.
  it('auth takes a provider and host but not an owner', () => {
    const flags = flagsOf(subcommand('auth'));

    expect(flags).toEqual(expect.arrayContaining(['--provider', '--host']));
    expect(flags).not.toContain('--owner');
  });

  it.each(['config', 'completion', 'default', 'pull', 'tidy'])(
    '%s stays free of them, because it never talks to a remote',
    (name) => {
      const flags = flagsOf(subcommand(name));

      expect(flags).not.toContain('--owner');
      expect(flags).not.toContain('--provider');
    },
  );

  it('still offers them globally', () => {
    const flags = flagsOf(createProgram());

    expect(flags).toEqual(expect.arrayContaining(['--owner', '--provider', '--host']));
  });
});

describe('the commands that sweep repositories in parallel', () => {
  it.each(['runs', 'clone', 'clone-all', 'update'])('%s takes --concurrency', (name) => {
    expect(flagsOf(subcommand(name))).toContain('--concurrency');
  });

  // `list` reads the workspace but never runs a parallel sweep over it, so `--concurrency` would
  // silently do nothing there.
  it.each(['list', 'auth', 'open', 'pwd', 'config', 'completion', 'default', 'pull', 'tidy'])(
    '%s stays free of it',
    (name) => {
      expect(flagsOf(subcommand(name))).not.toContain('--concurrency');
    },
  );

  it('still offers it globally', () => {
    expect(flagsOf(createProgram())).toContain('--concurrency');
  });
});
