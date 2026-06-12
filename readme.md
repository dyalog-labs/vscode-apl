# APL for VS Code

A VS Code extension for developing and debugging [Dyalog APL](https://www.dyalog.com/) programs. It connects to a Dyalog interpreter using the [RIDE protocol](https://github.com/Dyalog/ride/blob/master/docs/protocol.md), providing an integrated REPL, debugger, and editor experience.

Forked from and based on [vscode-apl-debug](https://github.com/tiamatica/vscode-apl-debug) by Tiamatica.

## Features

### Interactive REPL
- Multi-session tabbed REPL panel with drag-to-reorder tabs
- Autocomplete, value tooltips, and persistent history
- Syntax-highlighted output with clickable error links
- `Ctrl+Enter` to execute with tracing
- `/link` command to link workspace folders to APL namespaces

### Debugging
- Step through `.apl` files with full debug support (step into, step over, trace back/forward, cutback)
- Attach debugger to an existing REPL session
- Auto-enter debug mode on untrapped errors
- Breakpoint sync between VS Code and the REPL session
- Edit-and-continue: file edits are synced to the tracer via SaveChanges
- Separate local and global variable scopes in the debugger

### Editor
- APL language bar and backtick (`` ` ``) prefix input for APL characters
- `F1` documentation viewer for APL primitives and system functions
- `Shift+Enter` go-to-definition and smart `Escape` behavior
- `Ctrl+Up` to toggle localization of a variable in the function header

### Eval Server (external tool integration)

An opt-in TCP server that evaluates APL expressions in the active REPL session, so external tools (shell scripts, editors, other processes) can talk to your workspace.

- Set `apl.evalServer.port` in settings (Ctrl+,) - the default `0` means disabled, then open the command palette (Ctrl+Shift+P) and run **APL: Start Eval Server**. The server never starts automatically, and **APL: Stop Eval Server** (or clicking the status bar item) shuts it down.
- Protocol: one expression per line; each reply is text terminated by `\0`. Meta-commands: `/history`, `/tabs`, `/switch <id>`.
- Listens on `127.0.0.1` only and rejects connections that look like HTTP requests or TLS handshakes, so browsers can't reach it — but be aware that any local process running as your user can.

[bin/aple](bin/aple) is a ready-made client:

```bash
$ APL_EVAL_PORT=4502 bin/aple '2+2'   # port must match apl.evalServer.port
4
```

## Getting Started

1. Build and install the extension locally (see [Build and Run](#build-and-run) below).
2. Open a folder containing `.apl` files.
3. Use the command **Open APL REPL** (`apl.focusRepl`) to start an interactive session, or:
4. Switch to the Run and Debug viewlet, press the gear icon, and select **APL Debug** to create a launch configuration.
5. Press `F5` to start debugging.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F1` | Show documentation for symbol at cursor |
| `Shift+Enter` | Go to definition |
| `Ctrl+Enter` | Execute with tracing (REPL) |
| `Ctrl+Up` | Toggle variable localization |
| `Tab` | Cycle REPL autocomplete suggestions |
| `` ` `` + key | Insert APL character |
| `Escape` | Close editor or cutback (context-aware) |

## Build and Run

* Clone the project: `git clone https://github.com/martanit/vscode-apl.git`
* Open the project folder in VS Code.
* Run `npm install` to install dependencies.
* Press `F5` to build and launch the extension in another VS Code window.

### Packaging a local VSIX

To produce a `.vsix` file for local installation:

```bash
npm run package
```

This creates a `vscode-apl-<version>.vsix` file. Install it in VS Code with:

```bash
code --install-extension vscode-apl-<version>.vsix
```

Or use **Extensions > Install from VSIX...** from the command palette.

## License

[MIT](LICENSE.txt)
