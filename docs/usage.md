# TermDeck Usage Guide

This guide describes operational use of TermDeck on Linux. See [Scenarios](scenarios.md) for task-oriented examples.

## Mental model

TermDeck has three surfaces:

- `termdeckd`: daemon that owns PTY sessions and session files
- `termdeck`: CLI that sends protobuf requests to the daemon over a Unix socket
- `termdeck-mcp`: stdio MCP server that exposes the same daemon-backed capability surface as the CLI
- Web UI: observe-only browser view for terminal output

The daemon must be running before CLI commands work. Sessions keep running after the CLI process exits.

## Start the daemon

```bash
termdeckd
```

Default paths:

```text
TERMDECK_HOME=~/.termdeck
TERMDECK_SOCKET=$TERMDECK_HOME/termdeckd.sock
```

To isolate state for one project:

```bash
export TERMDECK_HOME="$PWD/.termdeck"
termdeckd
```

For agent usage, `project-step` can derive a stable session id from `cwd`, which avoids passing a manually chosen session name through every call:

```bash
termdeck project-step 'pwd && ls' --cwd "$PWD" --autostart
```

For a machine-wide local deployment, write the env var into a wrapper in a directory on `PATH`:

```bash
cat >/usr/local/bin/termdeck-local <<'SH'
#!/bin/sh
TERMDECK_HOME=/var/lib/termdeck exec termdeck "$@"
SH
chmod +x /usr/local/bin/termdeck-local
```

To enable the web UI:

```bash
TERMDECK_WEB_PORT=8787 termdeckd
```

Open:

```text
http://127.0.0.1:8787
```

The web UI is observe-only. It never forwards keyboard input to the PTY.

## Create a session

```bash
termdeck new main --cwd "$PWD"
```

Use a specific shell:

```bash
termdeck new main --cwd "$PWD" --shell /bin/bash
```

Set terminal size:

```bash
termdeck new main --cwd "$PWD" --rows 40 --cols 140
```

Set a prompt regex when the default shell prompt detector is insufficient:

```bash
termdeck new main --cwd "$PWD" --prompt-regex '.*[$#>]\s*$'
```

## Run commands

Run a command and wait for output quiescence:

```bash
termdeck run main 'pnpm test' --timeout-ms 120000 --quiescence-ms 500
```

By default, commands print the incremental terminal output with ANSI escapes removed for agent-readable text. Metadata is hidden unless you request JSON.

```bash
termdeck run main 'echo ok' --json
```

`run` wraps the command with shell markers so the response can separate command output from terminal echo and report `exitCode` when the command completes. The persistent shell still executes the command itself, so stateful operations such as `cd`, exported variables, and shell functions remain in the session.

Read the last structured command record:

```bash
termdeck last-command main --json
```

Enable sensitive mode when returned views may contain secrets:

```bash
termdeck sensitive main --on
```

Sensitive mode redacts returned command output, screen/log/events/summary views, and web output. It also hides the web snapshot for that session. The raw local transcript remains an artifact on disk, so keep `TERMDECK_HOME` permissions tight and avoid entering secrets unless necessary.

Use `--raw` when a command path needs the original PTY bytes, including ANSI color/control sequences:

```bash
termdeck run main 'echo ok' --raw
```

The raw stream remains in transcript/events and is used by the Web UI. The CLI default is the daemon-derived text view.

Poll output produced since the previous operation mark:

```bash
termdeck poll main --quiescence-ms 300
```

Send raw input without appending a newline:

```bash
termdeck send main 'echo partial'
termdeck ctrl main m
```

Run a script block without changing the persistent shell state:

```bash
termdeck script main --inline 'printf "HOST=%s\n" "$(hostname)"; df -h /' --timeout-ms 30000
```

The terminal transcript and Web UI show the pasted heredoc wrapper. The CLI response filters that wrapper and prints only output between TermDeck's begin and exit sentinels. `--json` includes `exitCode` when the script reaches the exit sentinel.

Paste text into the active terminal using bracketed paste:

```bash
termdeck paste main --inline 'printf paste-ok' --enter --timeout-ms 5000
```

Use `run` for one interactive shell command whose side effects should persist. Use `script` for multiline diagnostics or complex quoting. Use `paste` for REPL/editor/TUI input.

`run` does not rewrite commands. If a command has unmatched quotes or an unfinished heredoc, the shell can enter continuation mode. TermDeck reports that as `prompt: continuation` with reason `shell continuation prompt`; recover with Ctrl-C:

```bash
termdeck ctrl main c --timeout-ms 3000
```

Common control keys:

```bash
termdeck ctrl main c   # Ctrl-C
termdeck ctrl main d   # Ctrl-D
termdeck ctrl main m   # Enter
termdeck ctrl main l   # Ctrl-L
```

## Wait for synchronization points

Wait for a text pattern:

```bash
termdeck expect main 'tests [0-9]+.*pass' --timeout-ms 60000
```

Wait for a prompt-like ready state:

```bash
termdeck expect-prompt main --timeout-ms 30000
```

State detection can report:

```text
running
ready
repl
password
confirm
editor
pager
continuation
eof
```

## Password prompts

Use `password` for secret input:

```bash
termdeck password main
```

The CLI reads from the TTY. The daemon writes `[password sent]` to the interaction record and does not write the secret to `commands.log`.

## Signals

Send a signal to the foreground process group when Linux exposes it through `/proc/<pid>/stat`:

```bash
termdeck signal main INT --timeout-ms 5000
termdeck signal main TERM --timeout-ms 5000
```

Signal names may omit the `SIG` prefix. `INT` and `SIGINT` are equivalent.

If foreground process-group signaling fails with `ESRCH`, TermDeck falls back to signaling the PTY shell process.

## Inspect live sessions

List active sessions:

```bash
termdeck list
```

Read the rendered screen as plain text:

```bash
termdeck screen main
```

Read scrollback as plain text:

```bash
termdeck scrollback main --lines 200
```

`screen` and `scrollback` serve agent inspection. They strip terminal state to text. The Web UI renders serialized xterm state plus live raw PTY events from the daemon.

Read a compact agent-oriented summary:

```bash
termdeck summary main --lines 80 --events 20 --json
```

The summary includes current state, a rendered screen tail, recent output tail, recent event lines, and likely error lines. It is intended for low-token inspection before deciding whether to fetch raw logs or transcript data.

Read metadata:

```bash
termdeck metadata main
```

Clear the server-side xterm scrollback:

```bash
termdeck clear-scrollback main
```

## Inspect historical sessions

List persisted sessions:

```bash
termdeck history
```

Filter live sessions before cleanup:

```bash
termdeck list --cwd "$PWD"
termdeck list --name build --status ready
termdeck prune --cwd "$PWD" --status eof
```

Inspect one session's metadata:

```bash
termdeck inspect main
```

Read the command/output log:

```bash
termdeck log main --lines 100
```

Read sequenced daemon events:

```bash
termdeck events main --after-seq 10 --limit 50
```

Replay the transcript into a headless terminal and print reconstructed scrollback:

```bash
termdeck replay main --lines 200
```

Print the raw transcript path:

```bash
termdeck transcript main
```

## Background tasks

Task helpers are named TermDeck sessions with small readiness metadata. They do not bypass the daemon or create a separate terminal runner.

```bash
termdeck task start web 'pnpm dev --host 127.0.0.1' --cwd "$PWD" --labels dev,web --ttl-ms 7200000 --restart-policy on-failure --max-restarts 2 --backoff-ms 3000 --ready-port 5173 --autostart
termdeck task status web
termdeck task recover web
termdeck task logs web --lines 100
termdeck task dashboard
termdeck task prune --stale --expired --dry-run
termdeck task stop web
```

Readiness can be detected with `--ready-url`, `--ready-port`, or `--expect`. When more than one readiness check is supplied, all checks must pass and `task status` reports per-check diagnostics plus a short log tail on failure. Task metadata can include `--owner`, `--labels`, `--ttl-ms`, and restart policy fields. Status distinguishes stale metadata, expired TTLs, exited backing processes, and restart counts. If task metadata exists but the backing session is gone, status reports a stale task; `task recover` recreates the session from metadata and reruns the task command. `task dashboard` also reports orphan `task-*` sessions that have no task metadata.

Restart policies are `never`, `on-exit`, and `on-failure`. Automatic restarts honor `--max-restarts` and `--backoff-ms`.

## MCP

`termdeck-mcp` is the MCP access surface for the same daemon-owned capabilities exposed by `termdeck`.

```toml
[mcp_servers.termdeck]
command = "termdeck-mcp"
env = { TERMDECK_HOME = "/path/to/project/.termdeck" }
```

Use MCP `step` as the default low-level agent entrypoint. It supports autostart, missing-session creation via `cwd`, terminal operations equivalent to CLI `step --op`, and stable JSON results. Use MCP `project_step` when the caller wants TermDeck to derive the session id from `cwd`. CLI and MCP should remain capability-equivalent; add new public terminal operations to both surfaces and keep the parity test passing.

## Session files

Each session lives under:

```text
$TERMDECK_HOME/sessions/<session>/
```

Files:

```text
transcript.log      raw PTY output
commands.log        command log, excludes password input
interaction.log     input/output interaction stream
events.jsonl        sequenced daemon events
session.json        session metadata
state.json          latest detected state
```

## Web observer

Start the daemon with a web port:

```bash
TERMDECK_WEB_PORT=8787 termdeckd
```

The browser uses:

- `GET /api/sessions` for live session metadata
- `GET /api/tasks` for task dashboard data, including readiness, stale/expired/exited states, and orphan task sessions
- JSON REST for serialized xterm snapshots
- binary protobuf WebSocket events for live output after the snapshot sequence

The browser loads a serialized xterm snapshot first, then subscribes with `afterSeq=lastSeq`. Reconnects use `afterSeq` to replay events missed during a disconnect while the daemon retains them. The sidebar supports active and attention filters for sessions and tasks; the top dashboard summarizes session count, task count, ready tasks, and attention-needed items. Web task controls can stop, recover, and prune stale/expired tasks, but the browser remains observe-only for PTY input.

## Automation pattern

A typical automation loop:

```bash
termdeck new build --cwd "$PWD"
termdeck run build 'pnpm install' --timeout-ms 120000 --quiescence-ms 500
termdeck run build 'pnpm test' --timeout-ms 120000 --quiescence-ms 500
termdeck expect-prompt build --timeout-ms 30000
termdeck log build --lines 200
```

Use one session per long-lived task when commands share state. Use separate sessions when tasks need independent cwd, environment, or foreground jobs.

## Troubleshooting

`termdeckd is not running`:

```bash
termdeckd
```

Native binding missing:

```bash
pnpm install
pnpm rebuild node-pty
node scripts/install-check.mjs
```

Stale socket:

```bash
rm -f "$TERMDECK_HOME/termdeckd.sock"
termdeckd
```

Unexpected `running` state after command completion:

```bash
termdeck configure main --prompt-regex 'your prompt regex here'
termdeck expect-prompt main --timeout-ms 30000
```

Need raw output for debugging:

```bash
termdeck transcript main
termdeck events main --limit 200
```
