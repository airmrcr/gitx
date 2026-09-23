# Contributing to gitx

Thanks for taking an interest. `gitx` is a small, focused tool, and the bar for contributions is deliberately practical:
does it work, is it tested, and does it still behave sensibly when somebody has ninety repositories and one of them is
on fire?

## Contents

- [Getting set up](#getting-set-up)
- [Scripts](#scripts)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Code style](#code-style)
- [Adding an ecosystem](#adding-an-ecosystem)
- [Adding a provider](#adding-a-provider)
- [Adding a configuration key](#adding-a-configuration-key)
- [Adding a command](#adding-a-command)
- [Commits and pull requests](#commits-and-pull-requests)

## Getting set up

You'll need **Node 24 or newer**, **pnpm** and **git**. A few tests shell out to the real `git` binary, and the
dependency-install tests run a real `npm ci`, so you also need network access for a full run.

```bash
$ git clone https://github.com/airmrcr/gitx.git
$ cd gitx
$ pnpm install
$ pnpm verify
```

To try your changes out for real:

```bash
$ pnpm build
$ node bin/gitx.js --help
```

Or link it globally, so `gitx` on your PATH is your working copy:

```bash
$ pnpm add -g .
```

`pnpm dev` runs the TypeScript compiler in watch mode if you'd rather not rebuild by hand.

## Scripts

| Script               | What it does                                               |
| -------------------- | ---------------------------------------------------------- |
| `pnpm build`         | Compile `src` to `dist`                                    |
| `pnpm clean`         | Delete `dist`                                              |
| `pnpm dev`           | Compile in watch mode                                      |
| `pnpm test`          | Run the test suite once                                    |
| `pnpm test:watch`    | Run the tests in watch mode                                |
| `pnpm test:coverage` | Run the tests with a V8 coverage report                    |
| `pnpm lint`          | oxlint, fixing what it can                                 |
| `pnpm lint:check`    | oxlint, failing instead of rewriting                       |
| `pnpm format`        | oxfmt, rewriting files                                     |
| `pnpm format:check`  | oxfmt, failing instead of rewriting                        |
| `pnpm type:check`    | `tsc --noEmit` over `src` _and_ `test`                     |
| `pnpm verify`        | lint:check → format:check → type:check → test, in CI order |

`pnpm verify` is the one that matters. Run it before opening a pull request.

## Project layout

The source is layered, and dependencies only ever point downwards. `import/no-cycle` is an error, so the linter will
tell you if you get this wrong.

```
src/
  util/         errors, exec, globs, colours, prompts — depends on nothing
  config/       the git-style INI parser, the key schema, the Config store
  git/          the git wrapper and workspace/repository discovery
  provider/     forge adaptors (GitHub, GitLab), the REST client and tokens
  ecosystem/    package manager detection and install planning
  ops/          reusable per-repository operations (install, tidy)
  runner/       the parallel task pool, live renderer and shared sweep
  commands/     one file per command, wiring the above to commander
  cli.ts        builds the commander program
  main.ts       executes it and maps errors to exit codes
  index.ts      the public library entry point
```

Two things worth knowing before you go digging:

- **`src/config/ini.ts`** implements git's own INI dialect — subsections are case-sensitive while sections and keys are
  not, repeated keys form ordered multi-values, and values support quoting, escapes and backslash line continuations.
  It is the subtlest file in the project and the most thoroughly tested. Change it carefully.
- **`src/main.ts` is separate from `src/cli.ts`** on purpose. `index.ts` re-exports `createProgram`, so a self-executing
  `cli.ts` would run the CLI as a side effect of importing the library.

## Testing

Tests live in `test/`, mirroring the `src/` layout, and run under [vitest](https://vitest.dev).

The guiding principle is that **the interesting bugs live at the boundaries**, so the suite prefers real things over
mocks:

- `test/git/` and `test/ops/tidy.test.ts` build actual git repositories from local bare remotes, push to them, delete
  branches behind the clone's back, and assert on what git really does.
- `test/ops/install.test.ts` runs a real `npm ci` against a real lock file. Mocking a package manager mostly tests your
  mock.
- `test/util/exec.test.ts` spawns real `node` subprocesses to check exit codes, stream splitting and stdin handling.

Mocking is reserved for things that genuinely cannot be exercised, such as the interactive prompts in
`test/context.test.ts`.

Some practical notes:

- Give git fixtures an explicit environment (`GIT_CONFIG_GLOBAL=/dev/null`, author and committer identity) so they don't
  inherit — or depend on — the contributor's own git configuration.
- Tests that hit the network or run a package manager need a generous timeout; the existing ones use `120_000`.
- When you fix a bug, add the test _first_ and watch it fail. Several bugs in this codebase were found exactly that way,
  and a regression test that has never failed proves very little.

## Code style

Formatting is not a matter of opinion here: run `pnpm format` and move on.

Beyond that:

- **TypeScript is configured strictly**, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Declare
  optional properties as `prop?: T | undefined`, and build object literals conditionally rather than passing an explicit
  `undefined` to a third-party API.
- **Import with `.ts` extensions.** The build rewrites them, so `import { Git } from '../git/git.ts'` is correct in
  source.
- **Comment the _why_, not the _what_.** A comment explaining that `Promise.all` would make two prompts fight over stdin
  earns its keep. A comment saying "loop over the repositories" does not.
- **Failures should be `GitxError`** with an appropriate `ExitCode` and, where possible, a `hint`. Throwing a bare
  `Error` produces a stack trace and exit code 1, which is not a user experience.
- **Skipping beats failing.** A sweep across a hundred repositories should not stop because one is dirty, on a feature
  branch, or needs a package manager that isn't installed. Reserve failure for things that are actually wrong.
- **Never shell out to a git alias.** `gitx` must behave identically on a machine with an empty `~/.gitconfig`.
- **Don't add command aliases.** Commands have one name each. Short forms are the user's to define through `alias.*`,
  and a built-in one would take that name away from them.

## Adding an ecosystem

Node is the only ecosystem implemented today, but nothing else assumes that. To add Go, Rust or anything else:

1. Create `src/ecosystem/<name>.ts` exporting an `Ecosystem` — a `detect(dir)` that returns `undefined` for projects
   that aren't yours, and a `plan(options)` that describes the install command.
2. Report `available` using `hasExecutable(...)` so repositories are _skipped_, not failed, when the tool isn't
   installed.
3. Return `lockFile` if there is one, and honour `options.frozen`, `options.extraArgs` and `options.volta`.
4. Register it in `src/ecosystem/registry.ts`.
5. Add `test/ecosystem/<name>.test.ts` covering detection precedence and the generated commands.

Everything else — `skip.install`, `install.<manager>Args`, lock file restoration, the parallel runner, the live
display — then works for free.

## Adding a provider

GitHub and GitLab are implemented; Gitea, Bitbucket and friends are not. No command knows which forge it is talking to,
so adding one is self-contained:

1. Create `src/provider/<name>.ts` exporting a class that implements `Provider` from `src/provider/types.ts`: `id`,
   `label`, `host`, `runNoun`, `currentLogin()`, `listRepos()` and `listRuns()`.
2. Build requests with `ApiClient` from `src/provider/http.ts`. It handles auth headers, JSON decoding, error mapping
   and pagination, and takes a `fetchImpl` so it can be tested without a network.
3. Get the token with `requireCredential(...)`, passing the environment variable names that forge's own CLI already
   uses. Never read or write a token through `Config`.
4. Return clone URLs exactly as the API reports them. Building them from a template breaks on custom ports, subgroups
   and self-hosted instances.
5. Export a default host, and accept an override, so self-managed instances work.
6. Register it in `src/provider/registry.ts`, and add a `<name>.host` key to `src/config/schema.ts`.
7. Add `test/provider/<name>.test.ts`, injecting `fetchImpl`. Cover which endpoint gets chosen for a user versus an
   organisation, and how run statuses map onto `RunState`.

Prefer a deny-list for "this run has finished" over an allow-list for "still running": forges add new in-flight states,
and a run that vanishes from the report is worse than one that lingers.

## Adding a configuration key

`src/config/schema.ts` is the single source of truth. Add an entry to `CONFIG_KEYS` with its type, default, description
and display casing, and it is automatically validated on write, listed by `gitx config list --all --describe`, and
available through `Config`.

A key's subsection is reserved for a repository override (`[core "my-repo"]`), never for anything else, so a
package-manager override folds the manager into the key name instead: `install.<manager><Name>` (`install.yarnFrozen`,
not `install "yarn"`). If you add one, read it with `getInstallBoolean`, and please don't disturb its fallback
chain — a bug there once disabled every dependency install silently.

Set `repoScopable: true` on a key that a single repository should be able to override (see `core.editor`,
`update.tidy`). `findKeyDef` then accepts `section.<repo>.name` for it automatically, and `--repo` on
`gitx config get/set/unset` works with no further changes. Don't set it on something that isn't meaningfully
per-repository (an owner, a host, a display preference) — an unlisted key is rejected the same way an unknown one is,
and that's deliberate.

Document the new key in the README's configuration tables.

## Adding a command

1. Create `src/commands/<name>.ts` exporting a factory that returns a commander `Command`.
2. Register it in `src/cli.ts`.
3. For anything that operates on many repositories, build a `Task[]` and hand it to `sweep()` — that gets you
   parallelism, the live display, failure reporting and the summary line without writing any of it.
4. Document it in the README.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. Keep the
subject in the imperative mood and use the body to explain _why_, especially for a fix — a description of the broken
behaviour is worth more later than a description of the patch.

Before opening a pull request:

- [ ] `pnpm verify` passes
- [ ] New behaviour has tests, and bug fixes have a test that fails without the fix
- [ ] User-facing changes are reflected in the README
- [ ] No new dependencies unless there's a good reason — the runtime dependency list is deliberately short

Bug reports are just as welcome as patches. Include your OS, Node version, `gitx --version`, and what you expected to
happen.

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE.md).
