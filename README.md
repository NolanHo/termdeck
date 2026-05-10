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
- MCP server: `termdeck-mcp`
- Length-prefixed protobuf CLI-to-daemon protocol over Unix socket
- Server-side terminal buffer via `@xterm/headless`
- Observe-only web UI with JSON REST control endpoints and binary protobuf WebSocket events
- Prompt/state classification: running, ready, repl, password, confirm, editor, pager, continuation, eof
- Session artifacts: transcript, events, commands, interactions, metadata, state
- Shell command markers for `run` output boundaries and exit-code capture
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
- [Scenarios](docs/scenarios.md)
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

Or let an agent step create it on first use:

```bash
termdeck step main 'pwd && ls' --cwd "$PWD" --timeout-ms 5000 --autostart
```

Or use a project-derived session name so callers do not have to manage one:

```bash
termdeck project-step 'pwd && ls' --cwd "$PWD" --timeout-ms 5000 --autostart
```

Run a command:

```bash
termdeck run main 'pwd && ls' --timeout-ms 5000
```

Poll new output:

```bash
termdeck poll main --quiescence-ms 200
```

Check the current state with a rendered screen tail:

```bash
termdeck state main --lines 12
```

Read the rendered screen as plain text:

```bash
termdeck screen main
```

Open the observe-only web UI:

```bash
TERMDECK_WEB_PORT=8787 termdeckd
# browse http://127.0.0.1:8787
```

The CLI defaults to agent-readable text. `--raw` prints PTY bytes for debugging. Web rendering uses serialized xterm state and raw live events.

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
termdeck step <session> [command] [--cwd <path>] [--op run|poll|send|paste|ctrl|signal] [--timeout-ms N] [--startup-timeout-ms N] [--quiescence-ms N] [--lines N] [--autostart]
termdeck project-step [command] [--cwd <path>] [--name <label>] [--op run|poll|send|paste|ctrl|signal] [--timeout-ms N] [--autostart]
termdeck run <session> <command> [--timeout-ms N] [--quiescence-ms N]
termdeck script <session> [file] [--inline <script>] [--shell bash] [--timeout-ms N] [--quiescence-ms N]
termdeck paste <session> [file] [--inline <text>] [--enter] [--timeout-ms N] [--quiescence-ms N]
termdeck send <session> <data> [--timeout-ms N] [--quiescence-ms N]
termdeck ctrl <session> <key> [--timeout-ms N] [--quiescence-ms N]
termdeck poll <session> [--timeout-ms N] [--quiescence-ms N]
termdeck password <session> [--timeout-ms N] [--quiescence-ms N]
termdeck signal <session> <signal> [--timeout-ms N] [--quiescence-ms N]
```

Inspection:

```bash
termdeck state <session> [--lines N] [--autostart]
termdeck summary <session> [--lines N] [--events N] [--autostart]
termdeck last-command <session>
termdeck search <query> [--session ID] [--cwd PATH] [--task NAME] [--kind transcript,events,commands,metadata,tasks] [--regex] [--limit N] [--context N]
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

Background task helpers:

```bash
termdeck task start <name> <command> --cwd <path> [--owner USER] [--labels a,b] [--ttl-ms N] [--restart-policy never|on-exit|on-failure] [--max-restarts N] [--backoff-ms N] [--ready-url URL] [--ready-port N] [--expect PATTERN]
termdeck task status <name>
termdeck task recover <name>
termdeck task logs <name> [--lines N]
termdeck task list
termdeck task dashboard
termdeck task prune [--stale] [--expired] [--dry-run]
termdeck task stop <name>
```

Session cleanup:

```bash
termdeck list [--cwd <path>] [--name <text>] [--status ready|running|repl|password|confirm|editor|pager|eof|unknown]
termdeck prune [--cwd <path>] [--name <text>] [--status STATUS]
```

## MCP server

`termdeck-mcp` exposes the same TermDeck capability surface as the CLI over stdio MCP. CLI, MCP, and the web UI are peer access surfaces; `termdeckd` remains the owner of PTYs, sessions, transcripts, and web observation.

Register the server directly. When no environment is provided, CLI and MCP discover an existing daemon by checking the system socket at `/var/lib/termdeck/termdeckd.sock` before falling back to `~/.termdeck/termdeckd.sock`. Agents do not need to choose a backend.

```toml
[mcp_servers.termdeck]
command = "termdeck-mcp"
```

Set `TERMDECK_HOME` or `TERMDECK_SOCKET` only when you intentionally want project-isolated state or a non-default daemon.

The MCP `step` tool is the agent-friendly default entrypoint. It discovers or autostarts `termdeckd` by default, creates a missing session when `cwd` is supplied, and returns stable JSON fields such as `status`, `reason`, `prompt`, `exitCode`, `timedOut`, `outputTruncated`, `lastSeq`, `transcriptPath`, and `cwd`. `project_step` goes one level higher by deriving a stable session id from `cwd` and an optional label.

`summary` returns a compact inspection object with a screen tail, output tail, recent events, and likely error lines. `last_command` returns structured command id, command text, seq bounds, duration, exit code, timeout flag, and output tail. Use these when an agent needs state without replaying a large transcript.

`search` scans local sessions and task metadata across transcripts, events, commands, session metadata, and task specs. It supports filters for session id, task name, cwd, kind, regex, limit, and context lines. The Web UI exposes the same search for human inspection.

Agent-facing text views redact common secret-shaped values by default, including returned output, log/events views, summaries, and last-command records. Web snapshots and WebSocket output remain visible because the web surface is a local human observer. Raw transcripts remain local artifacts and should still be treated as sensitive.

Task helpers report stale metadata, expired TTLs, exited backing processes, restart counts, readiness diagnostics, and orphan `task-*` sessions. Optional restart policies can restart exited tasks on any exit or only non-zero exit. The web UI surfaces the same dashboard data with filters for active and attention-needed work, task logs, search results, and safe task stop/recover/prune controls.

Synchronization:

```bash
termdeck expect <session> <pattern> [--timeout-ms N]
termdeck expect-prompt <session> [--timeout-ms N]
```

## Daemon configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TERMDECK_HOME` | discovered daemon, then `~/.termdeck` | Runtime state root |
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
