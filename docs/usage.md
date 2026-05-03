# TermDeck Usage Guide

This guide describes operational use of TermDeck on Linux. See [Scenarios](scenarios.md) for task-oriented examples.

## Mental model

TermDeck has three surfaces:

- `termdeckd`: daemon that owns PTY sessions and session files
- `termdeck`: CLI that sends protobuf requests to the daemon over a Unix socket
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

By default, commands print the incremental terminal output only. Metadata is hidden unless you request JSON.

```bash
termdeck run main 'echo ok' --json
```

Use `--raw` when a command path needs the raw response fallback instead of the default display mode:

```bash
termdeck run main 'echo ok' --raw
```

Remove ANSI escape sequences from the returned output:

```bash
termdeck run main 'ls --color=always' --strip-ansi
```

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
termdeck script main --inline 'printf "HOST=%s\n" "$(hostname)"; df -h /' --timeout-ms 30000 --strip-ansi
```

Paste text into the active terminal using bracketed paste:

```bash
termdeck paste main --inline 'printf paste-ok' --enter --timeout-ms 5000 --strip-ansi
```

Use `run` for one interactive shell command whose side effects should persist. Use `script` for multiline diagnostics or complex quoting. Use `paste` for REPL/editor/TUI input.

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
termdeck expect main 'tests [0-9]+.*pass' --timeout-ms 60000 --strip-ansi
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

Read the rendered screen:

```bash
termdeck screen main
```

Read scrollback:

```bash
termdeck scrollback main --lines 200
```

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

- JSON REST for low-frequency session and screen snapshots
- binary protobuf WebSocket events for terminal output replay and live output

The browser reconnects with `afterSeq` so it can replay events missed during a disconnect while the daemon retains them.

## Automation pattern

A typical automation loop:

```bash
termdeck new build --cwd "$PWD"
termdeck run build 'pnpm install' --timeout-ms 120000 --quiescence-ms 500 --strip-ansi
termdeck run build 'pnpm test' --timeout-ms 120000 --quiescence-ms 500 --strip-ansi
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
