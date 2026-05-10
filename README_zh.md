# TermDeck

TermDeck 是一个 Linux daemon 和 CLI，用于管理基于 PTY 的持久终端会话。它可以让自动化程序启动 shell、发送命令、轮询输出、识别提示符、查看日志，并提供只读 Web 观察界面。浏览器用户不能向终端输入内容。

TermDeck 面向 agent 工作流：终端会话需要跨越单次 CLI 调用继续存在。daemon 持有 PTY，CLI 和 Web UI 通过本地传输连接 daemon。

## 状态

- 平台：Linux
- 运行时：Node.js 22+
- 本仓库包管理器：pnpm
- 发布产物：GitHub Release tarball
- Web UI：只读观察

## 功能

- 通过 `node-pty` 创建持久 PTY 会话
- 本地 daemon：`termdeckd`
- CLI：`termdeck`
- CLI 到 daemon 使用 Unix socket 上的 length-prefixed protobuf 协议
- 通过 `@xterm/headless` 在服务端维护终端缓冲区
- 只读 Web UI：JSON REST 控制端点 + binary protobuf WebSocket 事件
- 状态识别：running、ready、repl、password、confirm、editor、pager、continuation、eof
- 会话文件：transcript、events、commands、interactions、metadata、state
- `run` 使用 shell marker 切分命令输出边界并捕获 exit code
- 历史检查：history、inspect、log、events、replay
- 密码输入路径不会写入 command log
- Linux 下通过 `/proc/<pid>/stat` 的 `tpgid` 尽量向前台进程组发送信号

## 安装

可以从 GitHub Releases 下载 tarball，也可以从本地 checkout 构建。

```bash
pnpm install
pnpm run build
```

`node-pty` 是 native 依赖。pnpm 必须允许它的 build script。本仓库包含：

```ini
only-built-dependencies[]=node-pty
```

如果 native binding 缺失，package 的 postinstall 检查会直接失败。

## 文档

- [使用文档](docs/usage.md)
- [场景文档](docs/scenarios.md)
- [English README](README.md)

## 快速开始

启动 daemon：

```bash
termdeckd
```

创建会话：

```bash
termdeck new main --cwd "$PWD"
```

也可以让 agent step 在首次使用时创建会话：

```bash
termdeck step main 'pwd && ls' --cwd "$PWD" --timeout-ms 5000 --autostart
```

运行命令：

```bash
termdeck run main 'pwd && ls' --timeout-ms 5000
```

轮询新输出：

```bash
termdeck poll main --quiescence-ms 200
```

查看当前状态和渲染后的屏幕尾部：

```bash
termdeck state main --lines 12
```

以纯文本读取渲染后的屏幕：

```bash
termdeck screen main
```

打开只读 Web UI：

```bash
TERMDECK_WEB_PORT=8787 termdeckd
# 访问 http://127.0.0.1:8787
```

CLI 默认输出适合 agent 读取的文本。`--raw` 输出 PTY 原始字节用于调试。Web 使用序列化 xterm 状态和实时原始事件渲染。

## CLI 命令

会话生命周期：

```bash
termdeck new <session> --cwd <path> [--shell <shell>] [--rows N] [--cols N] [--prompt-regex <regex>]
termdeck list
termdeck kill <session>
termdeck resize <session> --rows N --cols N
termdeck configure <session> [--prompt-regex <regex>]
```

终端 I/O：

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

检查与回放：

```bash
termdeck state <session> [--lines N] [--autostart]
termdeck summary <session> [--lines N] [--events N] [--autostart]
termdeck last-command <session>
termdeck sensitive <session> --on|--off
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

`step` 是面向 agent 的糖衣命令：它可以用 `--cwd` 创建缺失会话，执行一个动作，并固定以一行紧凑状态结束，包含 `status`、`prompt`、`reason`、超时、退出码和截断标记。`project-step` 会从 `cwd` 和可选 label 派生稳定 session id，适合不想手动维护 session 名的 agent。`summary` 返回低 token 的状态、屏幕尾部、输出尾部、近期事件和疑似错误行。调用方需要完整对象时使用 `--json`。

`run` 会在 shell 内加入 begin/exit marker，以便从终端回显中稳定切出命令输出并返回 `exitCode`。命令仍在持久 shell 中执行，所以 `cd`、环境变量和 shell 函数等状态会保留。

`last-command` 返回结构化 command id、命令、seq 范围、duration、exit code、timeout 和 output tail。`sensitive` 模式会对返回文本、log/events/summary 和 Web 输出做 redaction，并隐藏 Web snapshot；原始 transcript 仍是本地磁盘 artifact，需要继续按敏感数据处理。

后台任务支持 `--owner`、`--labels`、`--ttl-ms`、`--restart-policy`、`--max-restarts`、`--backoff-ms`、`task dashboard`、`task prune` 和 `task recover`。状态会区分 stale metadata、TTL 过期、进程已退出、restart count 和 orphan `task-*` session。Web UI 会展示 task dashboard，并提供 active/attention 过滤以及 stop/recover/prune 安全控制，但仍不向 PTY 发送输入。

同步等待：

```bash
termdeck expect <session> <pattern> [--timeout-ms N]
termdeck expect-prompt <session> [--timeout-ms N]
```

## Daemon 配置

环境变量：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `TERMDECK_HOME` | `~/.termdeck` | 运行时状态根目录 |
| `TERMDECK_SOCKET` | `$TERMDECK_HOME/termdeckd.sock` | Unix socket 路径 |
| `TERMDECK_WEB_PORT` | 未设置 | 在 `127.0.0.1:<port>` 启动 Web UI |

socket 权限会设置为 `0600`。

## 数据布局

每个会话位于：

```text
$TERMDECK_HOME/sessions/<session>/
```

文件：

```text
transcript.log      原始 PTY 输出
commands.log        命令日志，不包含密码输入
interaction.log     input/output 交互流
events.jsonl        带 seq 的 daemon 事件
session.json        会话元数据
state.json          最新识别状态
```

## 协议

CLI 客户端通过 Unix socket 使用 length-prefixed protobuf frame。终端事件订阅通过 binary protobuf WebSocket frame。Web REST 端点有意使用 JSON，因为它们只承载低频控制和快照数据。

## 开发

```bash
pnpm install
pnpm run gen
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm pack
```

CI 在 GitHub Actions 上运行 typecheck、lint、test 和 build。

## 限制

- 只支持 Linux。
- 精确终端行为仍取决于 `node-pty` 和宿主 shell。
- 信号发送使用 Linux `/proc/<pid>/stat` 的 `tpgid`；如果该值不可用或过期，会退回到进程组或进程信号。
- Web UI 按设计只读，不接受人类终端输入。
- 浏览器事件解码器只覆盖当前事件 schema。

## License

MIT
