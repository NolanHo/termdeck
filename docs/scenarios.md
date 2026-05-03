# TermDeck Scenarios

This document describes practical terminal-control patterns for agents and automation. All examples assume the daemon is already running and the CLI uses the same `TERMDECK_HOME` as the daemon. For a local deployment, put a wrapper such as `termdeck-local` on `PATH` so callers do not repeat the environment variable.

## 1. Long-running build or test command

Use one persistent session for commands that need the same cwd, environment, shell history, or background processes.

```bash
termdeck new build --cwd /repo
termdeck run build 'pnpm install' --timeout-ms 120000 --quiescence-ms 500 --strip-ansi
termdeck run build 'pnpm test' --timeout-ms 120000 --quiescence-ms 500 --strip-ansi
termdeck expect-prompt build --timeout-ms 30000
termdeck log build --lines 200
```

Why this is different from ordinary process execution:

- `cd`, `export`, virtualenv activation, shell aliases, and job state persist.
- The command can outlive one CLI call.
- A later observer can inspect the same terminal state.

## 2. Periodic polling for background output

Start a background job and poll later.

```bash
termdeck new bg --cwd /repo
termdeck run bg "sh -c 'sleep 3; echo background-finished' &" --quiescence-ms 300 --strip-ansi
termdeck poll bg --timeout-ms 5000 --quiescence-ms 300 --strip-ansi
```

Use this for commands that schedule work but return control to the shell. Examples: local dev servers, file watchers, queue workers, or delayed diagnostics.

If the program prints periodic noise, increase `--quiescence-ms` or use `expect` for a specific pattern instead of relying only on quiescence.

## 3. Log monitoring

Keep a log stream open and let agents inspect it without restarting the command.

```bash
termdeck new logs --cwd /repo
termdeck run logs 'tail -f logs/app.log' --timeout-ms 1000 --quiescence-ms 300
termdeck poll logs --timeout-ms 10000 --quiescence-ms 500
termdeck screen logs
```

Other common commands:

```bash
termdeck run logs 'journalctl -u my-service -f'
termdeck run logs 'kubectl logs -f deploy/my-app'
termdeck run logs 'docker compose logs -f api'
```

Stop the foreground log command:

```bash
termdeck signal logs INT --timeout-ms 3000
```

## 4. REPL workflow

Keep a REPL open while an agent edits files or reasons about code.

```bash
termdeck new py --cwd /repo
termdeck run py 'python3' --timeout-ms 3000 --quiescence-ms 300
termdeck expect py '>>>' --timeout-ms 5000
termdeck send py 'x = 40 + 2'
termdeck ctrl py m
termdeck send py 'print(x)'
termdeck ctrl py m
termdeck poll py --timeout-ms 5000 --quiescence-ms 300 --strip-ansi
```

State detection reports Python and PDB prompts as `repl`.

Exit:

```bash
termdeck ctrl py d
```

## 5. Debugger workflow

A debugger is stateful. Breakpoints, stack frame, and locals live in the terminal session.

```bash
termdeck new debug --cwd /repo
termdeck run debug 'python3 -m pdb script.py' --timeout-ms 5000 --quiescence-ms 300
termdeck expect debug '\(Pdb\)' --timeout-ms 5000
termdeck send debug 'where'
termdeck ctrl debug m
termdeck poll debug --timeout-ms 5000 --quiescence-ms 300 --strip-ansi
```

Continue:

```bash
termdeck send debug 'continue'
termdeck ctrl debug m
```

Interrupt a runaway program:

```bash
termdeck signal debug INT --timeout-ms 5000 --strip-ansi
```

## 6. Interactive password prompt

Use `password` when the next input is a secret.

```bash
termdeck new sudo --cwd /repo
termdeck run sudo 'sudo -v' --timeout-ms 5000 --quiescence-ms 300
termdeck password sudo --timeout-ms 5000 --quiescence-ms 300
```

Properties:

- The CLI reads the password from the user's TTY.
- `commands.log` does not store the secret.
- The response output is `[password sent]`.

Limit: if the remote program echoes secrets by itself, TermDeck cannot prevent that echo from appearing in the PTY transcript.

## 7. SSH session

Use one terminal session to keep a remote login alive across agent steps.

```bash
termdeck new ssh-prod --cwd "$HOME"
termdeck run ssh-prod 'ssh user@host' --timeout-ms 10000 --quiescence-ms 500
termdeck expect-prompt ssh-prod --timeout-ms 30000
termdeck run ssh-prod 'hostname && pwd' --timeout-ms 5000 --quiescence-ms 300 --strip-ansi
```

If SSH asks for a password or key passphrase:

```bash
termdeck password ssh-prod --timeout-ms 10000 --quiescence-ms 500
termdeck expect-prompt ssh-prod --timeout-ms 30000
```

When the remote prompt is unusual, configure a prompt regex:

```bash
termdeck configure ssh-prod --prompt-regex '.*[#$>]\s*$'
termdeck expect-prompt ssh-prod --timeout-ms 30000
```

Close the remote shell:

```bash
termdeck run ssh-prod 'exit' --timeout-ms 5000 --quiescence-ms 300
```

## 8. Pager programs: less, man, git log

Pager programs are cursor-oriented. Plain incremental output can be misleading. Use `screen` or `scrollback`.

```bash
termdeck new pager --cwd /repo
termdeck run pager 'git log --oneline --decorate' --timeout-ms 3000 --quiescence-ms 300
termdeck screen pager
```

Navigate:

```bash
termdeck ctrl pager f   # page down in many pagers
termdeck ctrl pager b   # page up in many pagers
termdeck send pager q   # quit less/man/git pager
termdeck poll pager --timeout-ms 3000 --quiescence-ms 300 --strip-ansi
```

TermDeck state detection can report `pager` when it sees common pager markers.

## 9. Editor or full-screen TUI observation

TermDeck can observe editor/TUI screens. It does not provide browser input. Use CLI input only when automation must drive the program.

```bash
termdeck new edit --cwd /repo --rows 40 --cols 120
termdeck run edit 'vim README.md' --timeout-ms 3000 --quiescence-ms 300
termdeck screen edit
```

Example automated vim exit without saving:

```bash
termdeck send edit $'\e'
termdeck send edit ':q!'
termdeck ctrl edit m
```

For cursor-heavy programs, prefer:

```bash
termdeck screen edit
termdeck scrollback edit --lines 200
```

Do not rely only on `run` output for screen layout.

## 10. Prompt detection override

Default prompt detection works for common shell prompts. Custom prompts may need an explicit regex.

Symptoms:

- The shell is idle, but status stays `running`.
- `expect-prompt` times out even though the terminal shows a prompt.

Inspect the screen:

```bash
termdeck screen main
```

Configure a regex:

```bash
termdeck configure main --prompt-regex '^.*my-prompt>\s*$'
termdeck expect-prompt main --timeout-ms 30000
```

Create future sessions with the regex:

```bash
termdeck new main --cwd /repo --prompt-regex '^.*my-prompt>\s*$'
```

## 11. Multiline diagnostics

Use `script` for multiline commands, nested quotes, or diagnostics that do not need to mutate the persistent shell.

```bash
termdeck script main --inline '
printf "HOST=%s USER=%s PWD=%s\n" "$(hostname)" "$(whoami)" "$PWD"
uname -srmo
uptime -p
free -h
df -h /
ps -eo pid,ppid,stat,pcpu,pmem,comm --sort=-pcpu | head -10
' --timeout-ms 30000 --quiescence-ms 500 --strip-ansi
```

`script` writes a temporary heredoc script in the active terminal and runs it with `bash` by default. It reports a `__TERMDECK_EXIT:<code>__` marker in output. Use `--shell <shell>` if the script needs another interpreter.

Do not use `script` for state that must persist in the interactive shell. Use `run` for `cd`, `export`, aliases, or shell functions.

## 12. Pasting into REPLs and editors

Use `paste` for long text input to REPLs, editors, or TUIs.

```bash
termdeck paste py --inline 'for i in range(3):\n    print(i)' --enter
```

`paste` uses bracketed paste. With `--enter`, TermDeck submits the pasted text after paste end.

## 13. Environment and cwd persistence

A session behaves like a human terminal. State persists inside that shell.

```bash
termdeck new env --cwd /repo
termdeck run env 'export FOO=bar'
termdeck run env 'cd src'
termdeck run env 'printf "FOO=$FOO PWD=$PWD\n"' --strip-ansi
```

Use separate sessions when tasks require independent cwd, environment, or foreground programs.

```bash
termdeck new api --cwd /repo/api
termdeck new web --cwd /repo/web
```

## 14. Web observer for humans

Start the daemon with a web port:

```bash
TERMDECK_WEB_PORT=8787 termdeckd
```

Open:

```text
http://127.0.0.1:8787
```

Use SSH tunneling for remote hosts:

```bash
ssh -L 8787:127.0.0.1:8787 user@host
```

The web UI shows output and reconnects using event sequence numbers. It does not accept terminal input.

## 15. Historical audit and replay

After a task finishes, inspect artifacts without re-running commands.

```bash
termdeck history
termdeck inspect build
termdeck log build --lines 200
termdeck events build --limit 200
termdeck replay build --lines 300
termdeck transcript build
```

Use cases:

- explain why a build failed
- inspect output after an agent session ended
- reconstruct a terminal screen after daemon restart
- compare command log with raw transcript

## 16. Failure recovery

If the daemon is not running:

```bash
termdeckd
```

If a stale socket remains:

```bash
rm -f "$TERMDECK_HOME/termdeckd.sock"
termdeckd
```

If a foreground command hangs:

```bash
termdeck signal main INT --timeout-ms 5000 --strip-ansi
termdeck screen main
```

If a session is no longer needed:

```bash
termdeck kill main
```

If native bindings are missing:

```bash
pnpm rebuild node-pty
node scripts/install-check.mjs
```
