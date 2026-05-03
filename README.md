# TermDeck

TermDeck is a Linux daemon and CLI for persistent PTY-backed terminal sessions. It lets automation start a shell, send commands, poll output, detect prompts, inspect logs, and expose an observe-only web view without giving browser users terminal input capability.

TermDeck targets agent workflows where the terminal must outlive one CLI invocation. The daemon owns the PTY. The CLI and web UI connect to the daemon over local transports.

## Status

- Platform: Linux
- Runtime: Node.js 22+
- Package manager used by this repo: pnpm
- Release artifact: GitHub Release tarball
- Web UI: observe-only

## Features

- Persistent PTY sessions via `node-pty`
- Local daemon: `termdeckd`
- CLI: `termdeck`
- Length-prefixed protobuf CLI-to-daemon protocol over Unix socket
- Server-side terminal buffer via `@xterm/headless`
- Observe-only web UI with JSON REST control endpoints and binary protobuf WebSocket events
- Prompt/state classification: running, ready, repl, password, confirm, editor, pager, eof
- Session artifacts: transcript, events, commands, interactions, metadata, state
- Historical inspection: history, inspect, log, events, replay
- Password input path that avoids command logging
- Linux foreground process-group signal targeting via `/proc/<pid>/stat` `tpgid`

## Install

Download the release tarball from GitHub Releases or install from a local checkout.

```bash
pnpm install
pnpm run build
```

`node-pty` is a native dependency. pnpm must allow its build script. This repo includes:

```ini
only-built-dependencies[]=node-pty
```

The package postinstall check fails fast if the native binding is missing.

## Documentation

- [Usage Guide](docs/usage.md)
- [Chinese README](README_zh.md)

## Quick start

Start the daemon:

```bash
termdeckd
```

Create a session:

```bash
termdeck new main --cwd "$PWD"
```

Run a command:

```bash
termdeck run main 'pwd && ls' --timeout-ms 5000 --strip-ansi
```

Poll new output:

```bash
termdeck poll main --quiescence-ms 200
```

Read the rendered screen:

```bash
termdeck screen main
```

Open the observe-only web UI:

```bash
TERMDECK_WEB_PORT=8787 termdeckd
# browse http://127.0.0.1:8787
```

## CLI commands

Session lifecycle:

```bash
termdeck new <session> --cwd <path> [--shell <shell>] [--rows N] [--cols N] [--prompt-regex <regex>]
termdeck list
termdeck kill <session>
termdeck resize <session> --rows N --cols N
termdeck configure <session> [--prompt-regex <regex>]
```

Terminal I/O:

```bash
termdeck run <session> <command> [--timeout-ms N] [--quiescence-ms N] [--strip-ansi]
termdeck send <session> <data> [--timeout-ms N] [--quiescence-ms N] [--strip-ansi]
termdeck ctrl <session> <key> [--timeout-ms N] [--quiescence-ms N] [--strip-ansi]
termdeck poll <session> [--timeout-ms N] [--quiescence-ms N] [--strip-ansi]
termdeck password <session> [--timeout-ms N] [--quiescence-ms N]
termdeck signal <session> <signal> [--timeout-ms N] [--quiescence-ms N]
```

Inspection:

```bash
termdeck screen <session>
termdeck scrollback <session> [--lines N]
termdeck transcript <session>
termdeck metadata <session>
termdeck history
termdeck inspect <session>
termdeck log <session> [--lines N]
termdeck events <session> [--after-seq N] [--limit N]
termdeck replay <session> [--lines N]
termdeck clear-scrollback <session>
```

Synchronization:

```bash
termdeck expect <session> <pattern> [--timeout-ms N] [--strip-ansi]
termdeck expect-prompt <session> [--timeout-ms N] [--strip-ansi]
```

## Daemon configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TERMDECK_HOME` | `~/.termdeck` | Runtime state root |
| `TERMDECK_SOCKET` | `$TERMDECK_HOME/termdeckd.sock` | Unix socket path |
| `TERMDECK_WEB_PORT` | unset | Starts web UI on `127.0.0.1:<port>` |

Socket permissions are set to `0600`.

## Data layout

Each session lives under:

```text
$TERMDECK_HOME/sessions/<session>/
```

Files:

```text
transcript.log      raw PTY output
commands.log        logged commands, excludes password input
interaction.log     input/output interaction stream
events.jsonl        sequenced daemon events
session.json        session metadata
state.json          latest detected state
```

## Protocol

CLI clients use length-prefixed protobuf frames over the Unix socket. Terminal event subscribers use binary protobuf WebSocket frames. Web REST endpoints intentionally return JSON because they are low-frequency control and snapshot endpoints.

## Development

```bash
pnpm install
pnpm run gen
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm pack
```

CI runs typecheck, lint, tests, and build on GitHub Actions.

## Limitations

- Linux only.
- Exact terminal semantics still depend on `node-pty` and the host shell.
- Signal targeting uses Linux `/proc/<pid>/stat` `tpgid`; if unavailable or stale, TermDeck falls back to process-group or process signaling.
- The web UI is observe-only by design. It does not accept human terminal input.
- The browser event decoder handles the current event schema only.

## License

MIT
