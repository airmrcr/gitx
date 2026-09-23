# gitx

[![Build Status](https://img.shields.io/github/actions/workflow/status/airmrcr/gitx/ci.yml?event=push&style=for-the-badge)](https://github.com/airmrcr/gitx/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/npm/dw/%40airmrcr%2Fgitx?style=for-the-badge)](https://github.com/airmrcr/gitx)
[![Release](https://img.shields.io/npm/v/%40airmrcr%2Fgitx?style=for-the-badge)](https://github.com/airmrcr/gitx)
[![License](https://img.shields.io/github/license/airmrcr/gitx?style=for-the-badge)](https://github.com/airmrcr/gitx/blob/main/LICENSE.md)

`gitx` is a command-line tool for people who don't have _a_ repository — they have ninety of them, scattered across an
org, each one slightly behind, two of them on a branch you don't remember creating, and one of them mysteriously dirty
because of an `.idea/` folder.

It clones them, updates them, prunes their dead branches, installs their dependencies, and tells you which CI runs are
still chewing away in the background. All at the same time, with a live progress display.

```bash
$ gitx update --install --tidy
⊘ billing dirty working tree 102ms
⊘ legacy-soap on feature/never-merging 118ms
✔ api-gateway up to date 486ms
✔ auth-service updated 1.8s
✖ reporting fetch failed 2.1s
◐ design-system installing (pnpm)
◐ notifications fetching

Done!
Updated: 2 | Skipped: 2 | Failed: 1 | Installed: 1
```

---

## Contents

- [Install](#install)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Talking to your forge](#talking-to-your-forge)
- [Aliases](#aliases)
- [Configuration](#configuration)
- [Extending it](#extending-it)
- [Contributing](#contributing)
- [Licence](#licence)

---

## Install

`gitx` needs **Node 24 or newer** and **git**. That's it — no forge CLI.

The commands that talk to GitHub or GitLab (`runs`, `clone-all`, `list --all`/`--missing`) need an API token.
If you have ever authenticated git against the host, you already have one and there is nothing to do.
See [Talking to your forge](#talking-to-your-forge).

```bash
$ npm install -g @airmrcr/gitx
```

Or, if you'd rather not commit:

```bash
$ npx @airmrcr/gitx update
```

From source:

```bash
$ git clone https://github.com/airmrcr/gitx.git
$ cd gitx
$ pnpm install
$ pnpm build
$ pnpm add -g .
```

---

## Getting started

There is no setup step. Just run something:

```bash
$ gitx update
```

The first time, `gitx` asks which forge you use, on which host, where your repositories live and which owner they belong
to, then remembers all of it in `~/.gitxconfig`. The directory is created for you if it doesn't already exist. Cloning
asks one more question the first time: HTTPS or SSH remotes.

Prefer to do it up front? Or running in CI, where nobody is around to answer questions?

```bash
$ gitx config set core.baseDir ~/dev
$ gitx config set remote.provider github
$ gitx config set remote.owner acme
```

Prompts are drawn on stderr, never stdout, so a question can never end up inside output you're piping somewhere.
Pass `--no-input` and `gitx` will never prompt; it fails with a helpful message instead. Every prompted value can also
be supplied per-invocation with `--base-dir`, `--owner`, `--provider` and `--host`.

```bash
$ gitx -o acme list                  # acme
$ gitx list -o widgets               # widgets
$ gitx -o acme list -o widgets       # widgets — the one next to the command
```

Which means a one-off peek at somebody else's estate never disturbs your config:

```bash
$ gitx list --all -o gitlab-org -P gitlab
$ gitx runs -o acme
```

Now grab everything:

```bash
$ gitx clone-all --install
```

And, while you're here, turn on tab completion:

```bash
$ source <(gitx completion bash)   # see `gitx completion --help` to make it permanent
```

---

## Commands

Every multi-repo command accepts name globs, runs in parallel, and prints a summary at the end.

### `gitx clone`

Clone one or more repositories into your workspace.

```bash
$ gitx clone api-gateway
$ gitx clone api-gateway auth-service --install
$ gitx clone someone-else/their-repo    # override the configured owner
```

The first clone asks whether you want HTTPS or SSH remotes and remembers the answer as `remote.protocol`.
HTTPS is the default when nobody is around to ask, since it works without a key on the machine and `gitx auth login` has
already given git the credential for it.

### `gitx clone-all`

Clone _everything_ the configured owner has. Already-cloned repositories are skipped, so it doubles as "did anything new
appear?".

```bash
$ gitx clone-all
$ gitx clone-all 'platform-*' --install
$ gitx clone-all --visibility private --archived
```

### `gitx completion`

Tab completion for `bash`, `zsh` and `fish`. The script is generated from the live command tree, so it's only as current
as the last time you generated it:

```bash
$ gitx completion bash > ~/.local/share/bash-completion/completions/gitx
$ gitx completion zsh > "${fpath[1]}/_gitx"
$ gitx completion fish > ~/.config/fish/completions/gitx.fish
```

Or regenerate it every time a shell starts, so an upgrade can never leave it stale — a little slower to start a shell,
but it can never drift either:

```bash
$ echo 'source <(gitx completion bash)' >> ~/.bashrc
$ echo 'eval "$(gitx completion zsh)"' >> ~/.zshrc     # after compinit
$ echo 'gitx completion fish | source' >> ~/.config/fish/config.fish
```

### `gitx config`

Configuration lives in `~/.gitxconfig`.

```bash
$ gitx config set core.baseDir ~/dev
$ gitx config get core.baseDir
$ gitx config set --add skip.install 'legacy-*'
$ gitx config list                   # what you've set
$ gitx config list --all --describe  # every key, its default and what it does
$ gitx config unset skip.install --all
$ gitx config path
$ gitx config edit
```

Keys are validated on write, so a typo is caught immediately rather than silently ignored six weeks later:

```bash
$ gitx config set core.concurency 4
gitx: unknown configuration key: core.concurency
Run `gitx config list --all --describe` to see every supported key.
```

**Some settings can be overridden for one repository.**
Pass `--repo <name>`, or just `--repo` to mean whichever repository your current directory is in:

```bash
$ gitx config set core.editor idea --repo legacy-monolith   # this repo only
$ gitx config set update.tidy false --repo                  # from inside that repo
$ gitx config get core.editor --repo legacy-monolith
```

This writes a subsection, so `~/.gitxconfig` ends up with:

```ini
[core "legacy-monolith"]
	editor = idea
```

Not every key supports this — only ones where a per-repository override actually means something:
`core.editor`, `update.tidy`, `update.submodules`, and the per-package-manager `install.*` settings (below).
`gitx config set remote.owner acme --repo x` is rejected the same way an unknown key is, since an owner isn't a
per-repository concept. A `get` without a matching override falls back to the plain value, so `--repo` only shows you
something different where a repository actually has its own answer.

### `gitx default`

Check out the remote's default branch — whatever it's actually called. Reads `origin/HEAD`, repairs it if it's stale,
and falls back to `main`, `master`, `develop` or `trunk`.

```bash
$ gitx default
```

### `gitx list`

What have you actually got?

```bash
$ gitx list                             # what's cloned
$ gitx list 'api-*'                     # what's cloned and matches
$ gitx list --all                       # cloned ✔ and not-yet-cloned ○, together
$ gitx list --missing                   # only what you haven't cloned
$ gitx list --missing --porcelain | xargs gitx clone
```

The default is purely local: no network, no token, no waiting. `--all` and `--missing` ask your forge what exists, so
they need a token and accept the same `--visibility`, `--archived` and `--limit` options as `clone-all`.

### `gitx open`

Open a cloned repository in your editor, from anywhere, by name.

```bash
$ gitx open api-gateway
$ gitx open api-gateway --editor 'code -n'   # just this once
```

The first run asks which command opens a repository and remembers it as `core.editor`. The repository's path is appended
as the command's final argument; anything else you write, such as `-n` or `--wait`, is passed through in between.
`--editor` overrides it for a single run without changing what's remembered.

### `gitx pull`

Pull the current branch. Unknown flags are handed straight to `git pull`, so muscle memory still works:

```bash
$ gitx pull
$ gitx pull --rebase
$ gitx pull --tidy              # pull, then prune dead branches
$ gitx pull --install           # pull, then install dependencies
$ gitx pull --clean             # ...installing cleanly (implies --install)
$ gitx pull --depth 1 origin main
```

`--install` uses the same package-manager detection and `install.*` settings as `gitx update`, and respects
`skip.install`. Unlike `gitx update`, it installs whether or not the pull actually brought anything down — you asked for
it by name, in the one repository you're standing in. Which is also why there's no `--force`: there'd be nothing left
for it to force.

### `gitx pwd`

Resolve a cloned repository's path, by name, from anywhere:

```bash
$ gitx pwd api-gateway
$ cd "$(gitx pwd api-gateway)"
```

A child process can't change your shell's working directory for you, so this is what a `cd` wrapper function shells out
to. Add one to your shell's startup file and you have `gitx`-aware jumping between repositories:

```bash
gcd() { cd "$(gitx pwd "$1")"; }
```

### `gitx runs`

Which of your CI runs are still in flight? Workflow runs on GitHub, pipelines on GitLab — same command, same output.

```bash
$ gitx runs            # your runs, everywhere
$ gitx runs --all      # everyone's runs
$ gitx runs 'api-*'    # narrow it down
```

Repositories with nothing running say so and stay out of your way; the rest are listed with their workflow, status, age
and branch.

The project each directory belongs to is read from its `origin` remote rather than assumed from its name, so renamed,
forked and subgrouped repositories still resolve correctly.

### `gitx tidy`

Fetch with `--prune`, then delete every local branch whose upstream has been deleted. The one you merged the PR for.
And the eleven before it.

```bash
$ gitx tidy
$ gitx tidy --no-fetch
```

### `gitx update`

Fetch and fast-forward every cloned repository.

```bash
$ gitx update                       # everything
$ gitx update 'api-*' auth-service  # only what matches
$ gitx update -j 4                  # four at a time
$ gitx update --install --tidy      # the full spring clean
$ gitx update --after m             # resume an interrupted sweep alphabetically
$ gitx update --dirty               # update even repositories with local changes
```

A repository is **skipped** — never failed — when it's on a non-default branch, has a dirty working tree (unless
`--dirty` is passed), or matches `skip.update`. That's the point: a sweep across ninety repositories shouldn't stop
because you left one mid-refactor.

---

## Talking to your forge

`gitx` speaks to GitHub and GitLab directly over their REST APIs. There is no `gh` or `glab` to install.

### Choosing a provider

The first command that needs the network asks which forge you use and on which host, then remembers both:

```bash
$ gitx config set remote.provider gitlab
$ gitx config set gitlab.host gitlab.acme.com
```

The host is per-provider, so GitHub Enterprise Server and gitlab.com can happily coexist in one config. Provider, host
and owner can each be overridden for a single command, without touching `~/.gitxconfig`:

```bash
$ gitx list --all --provider gitlab --owner gitlab-org
$ gitx clone-all -H github.acme.com -o platform
```

`clone`, `clone-all`, `list`, `runs` and `update` all take `-o/--owner`, `-P/--provider` and `-H/--host`; `gitx auth` takes the latter two, since signing in is per-host rather than per-owner.

### Where the token comes from

In order, first hit wins:

1. `$GITX_TOKEN`, for a one-off override.
2. `$GH_TOKEN` / `$GITHUB_TOKEN`, or `$GITLAB_TOKEN` / `$GITLAB_ACCESS_TOKEN` — the same variables the official CLIs
   use, so a token you've already exported just works.
3. Your git credential helper: the macOS Keychain, libsecret, Windows Credential Manager, whatever `credential.helper`
   points at.

That third one is the good bit. If you have ever authenticated git against the host over HTTPS, `gitx` is already
authenticated too. Nothing to set up, and no second copy of your token lying around.

### `gitx auth`

```bash
$ gitx auth status                 # can I authenticate, and with what?
$ gitx auth login                  # store a token
$ gitx auth login --with-token     # ...from stdin, for scripts
$ gitx auth logout                 # forget it again
```

`gitx auth login` verifies the token against the API before storing anything — a paste error fails there and then,
rather than on your next command — and writes it through `git credential approve`. It lands in whatever
`credential.helper` names, under the account the provider says the token belongs to.
`gitx` never writes a secret to `~/.gitxconfig`.

Because it's the same store `git push` uses, `gitx auth logout` also logs plain git out of HTTPS pushes to that
host — it says so when it happens. It doesn't revoke anything: the token still exists on the server until you delete it
there.

Tokens need enough scope to read repositories and CI: `repo` + `workflow` on GitHub, `read_api` on GitLab.

### Adding another forge

Gitea? Bitbucket? Implement the `Provider` interface in `src/provider/` and add an entry to the registry.
No command knows the difference — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Aliases

Aliases work exactly like git's, because that's the muscle memory you already have.

```bash
$ gitx config set alias.ll 'list --all'
$ gitx ll                        # → gitx list --all
$ gitx ll 'api-*'                # → gitx list --all 'api-*'
```

Anything you type after the alias is appended, so an alias can set up the boring flags and leave the interesting
arguments to you. Aliases can point at other aliases — with loop detection — and quoting inside the value is honoured,
so `alias.api = "list 'api-* web-*'"` passes one argument, not two.

### Shell aliases

Start the value with `!` and the rest is handed to `/bin/sh`, which is where the fun is:

```bash
$ gitx config set alias.fresh '!gitx update --install && gitx runs'
$ gitx config set alias.grep '!f() { gitx list --porcelain | xargs -I{} sh -c "cd ~/dev/{} && grep -Hn \"$1\" -r ."; }; f'
```

As in git, arguments are appended as `"$@"`, so the `!f() { …; }; f` function idiom is the reliable way to get at them:

```bash
$ gitx config set alias.hello '!f() { echo "hi $1"; }; f'
$ gitx hello world
hi world
```

`$GITX_PREFIX` holds the directory you ran from, stdin/stdout/stderr are inherited (so pagers and prompts work), and the
script's exit code becomes gitx's.

---

## Configuration

### `core`

| Key                | Default      | Description                                                        |
| ------------------ | ------------ | ------------------------------------------------------------------ |
| `core.baseDir`     | _(prompted)_ | Directory all repositories are cloned beneath                      |
| `core.layout`      | `nested`     | `nested` → `<baseDir>/<owner>/<repo>`, `flat` → `<baseDir>/<repo>` |
| `core.concurrency` | `auto`       | Parallel repositories. `auto` = CPU count, `0` = unlimited         |
| `core.color`       | `auto`       | `auto`, `always` or `never`                                        |
| `core.outputLines` | `1`          | Trailing output lines shown per in-flight task                     |
| `core.editor`      | _(prompted)_ | Command that opens a repository, e.g. `code`, `idea` or `vim`      |

`core.editor` can be set per repository with `--repo`; see [`gitx config`](#gitx-config).

### `remote`, `github` and `gitlab`

| Key                      | Default        | Description                                 |
| ------------------------ | -------------- | ------------------------------------------- |
| `remote.provider`        | _(prompted)_   | `github` or `gitlab`                        |
| `remote.owner`           | _(prompted)_   | Organisation, group or user repos come from |
| `remote.user`            | _(your login)_ | Login used to filter CI runs                |
| `remote.protocol`        | _(prompted)_   | `https` or `ssh`, for cloning               |
| `remote.visibility`      | `all`          | `all`, `public`, `private` or `internal`    |
| `remote.limit`           | `1000`         | Maximum repositories to list                |
| `remote.includeArchived` | `false`        | Include archived repositories               |
| `github.host`            | `github.com`   | GitHub host, for Enterprise Server          |
| `gitlab.host`            | `gitlab.com`   | GitLab host, for self-managed instances     |

### `clone` and `update`

| Key                  | Default  | Description                                   |
| -------------------- | -------- | --------------------------------------------- |
| `clone.install`      | `false`  | Install dependencies after cloning            |
| `update.install`     | `false`  | Install dependencies after updating           |
| `update.clean`       | `false`  | Prefer clean installs when updating           |
| `update.force`       | `false`  | Install even when already up to date          |
| `update.tidy`        | `true`   | Prune dead branches after pulling             |
| `update.submodules`  | `true`   | Update submodules                             |
| `update.prune`       | `true`   | Pass `--prune` when fetching                  |
| `update.ignoreDirty` | `.idea/` | Paths that don't count as "dirty". Repeatable |

`update.tidy` and `update.submodules` can be set per repository with `--repo`.

### `install`

| Key                       | Default | Description                                                          |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `install.restoreLockfile` | `true`  | Restore the lock file so a sync never leaves a repo dirty            |
| `install.frozen`          | `true`  | Use frozen/immutable installs when a lock file exists                |
| `install.frozenFallback`  | `true`  | Retry unfrozen when a stale lock file breaks a frozen install        |
| `install.volta`           | `auto`  | `auto`, `always` (wrap in `volta run`) or `never` (`VOLTA_BYPASS=1`) |

Every one of these can be overridden per package manager, and a package manager can be switched off entirely:

```ini
[install]
	yarnEnabled = false
	pnpmFrozen = false
	pnpmArgs = --ignore-scripts
```

| Key                                | Description                                       |
| ---------------------------------- | ------------------------------------------------- |
| `install.<manager>Enabled`         | Disable a package manager entirely                |
| `install.<manager>Frozen`          | Per-manager override of `install.frozen`          |
| `install.<manager>RestoreLockfile` | Per-manager override of `install.restoreLockfile` |
| `install.<manager>Args`            | Extra arguments appended to the install command   |

`<manager>Enabled`, `<manager>Frozen` and `<manager>RestoreLockfile` (not `<manager>Args`, which is a list) can _also_
be set per repository with `--repo`, taking priority over both the per-manager and plain settings:

```ini
[install "legacy-monolith"]
	yarnFrozen = false
```

### `skip`

All optional. All glob-aware (`*` and `?`). All repeatable.

| Key            | Description                          |
| -------------- | ------------------------------------ |
| `skip.install` | Never install dependencies for these |
| `skip.update`  | Never update these                   |

Skipping is deliberately narrow: it controls what gitx _does_ to a repository, never whether the repository exists as
far as gitx is concerned. `gitx list` shows everything, `gitx clone-all` clones everything, and `gitx runs` reports on
everything — then `skip.install` and `skip.update` decide what gets left alone.

### `runs`

| Key          | Default | Description                      |
| ------------ | ------- | -------------------------------- |
| `runs.limit` | `10`    | CI runs inspected per repository |

### `alias`

| Key            | Default | Description                    |
| -------------- | ------- | ------------------------------ |
| `alias.<name>` | —       | Shorthand for a longer command |

See [Aliases](#aliases) for what you can put in one.

### A complete example

```ini
[core]
	baseDir = ~/dev
	concurrency = 8

[remote]
	provider = github
	owner = acme

[update]
	install = true
	ignoreDirty = .idea/
	ignoreDirty = .vscode/

[install]
	yarnEnabled = false

[core "legacy-monolith"]
	editor = webstorm

[skip]
	install = docs-site
	update = archived-*

[alias]
	ll = list --all
	sweep = update --install --tidy
	web = !gitx update 'web-*' && echo 'web estate is fresh'
```

---

## Extending it

Node is the only ecosystem implemented today, but nothing about the design assumes it. An ecosystem is a small object
that answers two questions — "is this one of mine?" and "how do I install it?":

```ts
export const goEcosystem: Ecosystem = {
  name: 'go',
  async detect(dir) {
    if (!(await exists(path.join(dir, 'go.mod')))) return undefined;
    return {
      ecosystem: 'go',
      manager: 'go',
      available: hasExecutable('go'),
      hasLockFile: await exists(path.join(dir, 'go.sum')),
      lockFile: 'go.sum',
      plan: (options) => ({ command: 'go', args: ['mod', 'download', ...options.extraArgs] }),
    };
  },
};
```

Register it, and every existing flag — `skip.install`, `install.<manager>.args`, lock file restoration, the parallel
runner, the live display — works for Go repositories with no further changes.
[CONTRIBUTING.md](CONTRIBUTING.md#adding-an-ecosystem) has the step-by-step version.

---

## Contributing

Pull requests and bug reports are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout, the testing approach, and how to add an ecosystem, a configuration
key or a command.

---

## Licence

[MIT](LICENSE.md) © airmrcr
