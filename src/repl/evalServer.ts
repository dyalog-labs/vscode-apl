import * as Net from 'net';
import type { ReplManager } from './replManager';

/**
 * TCP server (127.0.0.1) that runs APL in the active REPL for external tools.
 *
 * Protocol: APL expressions or `/`-prefixed meta-commands, one per line;
 * each reply is text terminated by `\0`. A single FIFO queue serializes
 * requests so concurrent connections don't cross-contaminate output.
 *
 * `/debug` meta-commands proxy into a real VS Code debug session through
 * an injected DebugBridge, so an external client can drive the debugger
 * while the user watches the native UI. Flow/inspection commands never
 * enter the eval FIFO — `pause` must reach the interpreter while an eval
 * is stuck. `evaluate`/`setExpression` DO join the FIFO: they run APL on
 * the same interpreter, and interleaving them with a queued eval would
 * attribute their output to the wrong client. Consequence: on a socket
 * that mixes evals and flow commands, replies may interleave — flow
 * replies are immediate while eval(-uate) replies wait for the queue.
 *
 * Browser drive-by defense: reject HTTP request lines (plaintext) and TLS
 * ClientHellos (first byte 0x16); drop sockets that send nothing within
 * PRE_DATA_TIMEOUT_MS. Any local process running as the user can still
 * connect — same trust model as RIDE and the language server.
 */

/**
 * What the eval server needs from the debug side, kept vscode-free so
 * the server stays unit-testable. The real implementation
 * (`VsCodeDebugBridge`) wraps `vscode.debug` and emits `'dap'` for every
 * DAP event the adapter sends.
 */
export interface DebugBridge {
	isActive(): boolean;
	start(config: Record<string, unknown>): Promise<boolean>;
	stop(): Promise<void>;
	request(command: string, args?: unknown): Promise<unknown>;
	on(event: 'dap', listener: (msg: unknown) => void): unknown;
	removeListener(event: 'dap', listener: (msg: unknown) => void): unknown;
}

const DEBUG_USAGE =
	'[Usage: /debug start [json] | stop | status | listen | <dapCommand> [json]]';

// Single-thread adapter (threadID hardcoded to 1), so flow commands can
// default their args and stay one-word ergonomic from the CLI.
const THREAD_DEFAULT_COMMANDS = new Set([
	'next', 'continue', 'stepIn', 'stepOut', 'pause', 'stackTrace',
]);

// DAP commands that execute APL on the shared interpreter. These must be
// serialized through the eval FIFO — bypassing it lets a debug evaluation
// run between two queued evals and its output leak into the queued
// client's reply. `start` stays out of band: launching through the FIFO
// could deadlock behind a stuck eval.
const SERIALIZED_COMMANDS = new Set(['evaluate', 'setExpression']);

// Known HTTP method + ` HTTP/<digit>` trailer. Both are required so a stray
// APL call like `GET 1 2 3` or `FOO bar HTTP/1` won't false-match.
const HTTP_REQUEST_LINE = /^(GET|POST|HEAD|OPTIONS|PUT|DELETE|PATCH|CONNECT|TRACE) \S+ HTTP\/\d/;
const TLS_HANDSHAKE_BYTE = 0x16;
const PRE_DATA_TIMEOUT_MS = 2000;

interface EvalRequest {
	/** APL expression to run on the session (eval requests). */
	expr?: string;
	/** Deferred work holding the FIFO slot instead (serialized /debug). */
	run?: () => Promise<void>;
	socket: Net.Socket;
}

export class EvalServer {
	private _server?: Net.Server;
	private _manager: ReplManager;
	private _queue: EvalRequest[] = [];
	private _busy = false;
	private _sockets: Set<Net.Socket> = new Set();
	private _debugBridge?: DebugBridge;
	private _debugListeners: Set<Net.Socket> = new Set();
	private _dapListener?: (msg: unknown) => void;
	// isActive() only flips once startDebugging resolves; this guards the
	// window in between so concurrent /debug start can't double-launch.
	private _debugStarting = false;

	constructor(manager: ReplManager, debugBridge?: DebugBridge) {
		this._manager = manager;
		this._debugBridge = debugBridge;
	}

	public async start(port: number): Promise<number> {
		if (this._server) {
			const addr = this._server.address() as Net.AddressInfo;
			return addr.port;
		}

		return new Promise((resolve, reject) => {
			const server = Net.createServer((socket) => this.handleConnection(socket));
			let resolved = false;

			server.on('error', (e: Error) => {
				if (!resolved) {
					this._server = undefined;
					reject(e);
				} else {
					console.log(`[EvalServer] runtime error: ${e.message}`);
				}
			});

			server.listen(port, '127.0.0.1', () => {
				const addr = server.address() as Net.AddressInfo;
				console.log(`[EvalServer] Listening on 127.0.0.1:${addr.port}`);
				this._server = server;
				resolved = true;
				resolve(addr.port);
			});
		});
	}

	public isRunning(): boolean {
		return this._server !== undefined;
	}

	public async stop(): Promise<void> {
		if (this._server) {
			const server = this._server;
			this._server = undefined;
			// server.close() otherwise hangs on idle clients.
			for (const s of this._sockets) { s.destroy(); }
			this._sockets.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			console.log('[EvalServer] Stopped');
		}
		if (this._dapListener && this._debugBridge) {
			this._debugBridge.removeListener('dap', this._dapListener);
			this._dapListener = undefined;
		}
		this._debugListeners.clear();
		this._queue = [];
		this._busy = false;
	}

	private handleConnection(socket: Net.Socket): void {
		this._sockets.add(socket);

		let buf = '';
		let cleared = false;
		let idleTimer: NodeJS.Timeout | undefined = setTimeout(() => {
			if (!cleared) { socket.destroy(); }
		}, PRE_DATA_TIMEOUT_MS);

		const clearIdleTimer = () => {
			if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
		};

		socket.once('close', () => {
			clearIdleTimer();
			this._sockets.delete(socket);
		});

		socket.on('data', (data) => {
			buf += data.toString();

			if (!cleared) {
				// TLS ClientHello has no newline — sniff before waiting for one.
				if (buf.charCodeAt(0) === TLS_HANDSHAKE_BYTE) {
					socket.destroy();
					return;
				}
				const nl = buf.indexOf('\n');
				if (nl === -1) { return; }
				const firstLine = buf.slice(0, nl).replace(/\r$/, '');
				if (HTTP_REQUEST_LINE.test(firstLine)) {
					socket.destroy();
					return;
				}
				cleared = true;
				clearIdleTimer();
			}

			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const expr = buf.slice(0, nl).replace(/\r$/, '');
				buf = buf.slice(nl + 1);
				if (!expr) { continue; }

				if (expr === '/debug' || expr.startsWith('/debug ')) {
					this.handleDebugCommand(expr, socket).then((reply) => {
						try { socket.write(reply + '\0'); } catch { /* */ }
					});
					continue;
				}

				if (expr.startsWith('/')) {
					try { socket.write(this.handleMetaCommand(expr) + '\0'); } catch { /* */ }
					continue;
				}

				this._queue.push({ expr, socket });
				this.dispatch();
			}
		});

		socket.on('error', () => { /* Node throws otherwise */ });
	}

	private dispatch(): void {
		if (this._busy) { return; }
		while (this._queue.length > 0) {
			if (this._queue[0].socket.destroyed) {
				this._queue.shift();
				continue;
			}
			const req = this._queue.shift()!;
			if (req.run) {
				this._busy = true;
				void req.run().then(() => {
					this._busy = false;
					this.dispatch();
				});
				return;
			}
			const session = this._manager.activeSession;
			if (!session || !session.isConnected) {
				try { req.socket.write('[No active session]\0'); } catch { /* */ }
				continue;
			}
			this._busy = true;
			let output = '';
			let settled = false;
			const onOutput = (text: string) => { output += text; };
			const cleanup = () => {
				if (settled) { return; }
				settled = true;
				session.removeListener('output', onOutput);
				session.removeListener('ready', onReady);
				req.socket.removeListener('close', onSocketClose);
				this._busy = false;
				this.dispatch();
			};
			const onReady = () => {
				if (settled) { return; }
				try { req.socket.write(output + '\0'); } catch { /* */ }
				cleanup();
			};
			// If the client dies before `ready` fires, free `_busy` so the
			// queue doesn't wedge.
			const onSocketClose = () => { cleanup(); };
			session.on('output', onOutput);
			session.on('ready', onReady);
			req.socket.once('close', onSocketClose);
			session.execute(req.expr!);
			return;
		}
	}

	private handleMetaCommand(input: string): string {
		const parts = input.slice(1).trim().split(/\s+/);
		const cmd = parts[0]?.toLowerCase();

		switch (cmd) {
			case 'history': {
				const tab = this._manager.activeTab;
				if (!tab) { return '[No active tab]'; }
				return tab.outputHistory
					.map(e => `[${e.type}] ${e.text}`)
					.join('')
					|| '[Empty history]';
			}
			case 'tabs': {
				return this._manager.getTabList()
					.map(t => `${t.isActive ? '* ' : '  '}${t.replId} ${t.label}`)
					.join('\n')
					|| '[No tabs]';
			}
			case 'switch': {
				// Multi-word labels: `/switch My Tab`.
				const id = parts.slice(1).join(' ');
				if (!id) { return '[Usage: /switch <replId>]'; }
				const tab = this._manager.getTab(id);
				if (!tab) {
					const match = this._manager.getTabList().find(t =>
						t.label.toLowerCase().includes(id.toLowerCase())
					);
					if (match) {
						this._manager.switchToTab(match.replId);
						return `Switched to ${match.label}`;
					}
					return `[Tab not found: ${id}]`;
				}
				this._manager.switchToTab(id);
				return `Switched to ${tab.label}`;
			}
			default:
				return `[Unknown command: /${cmd}]\nAvailable: /history, /tabs, /switch <id>, /debug`;
		}
	}

	/**
	 * `/debug <subcommand> [json]` — lifecycle commands are handled here;
	 * anything unrecognized is forwarded to the adapter as a DAP request.
	 * Always resolves to a reply string (errors are bracketed, results
	 * are JSON) so the caller can write it unconditionally.
	 */
	private async handleDebugCommand(input: string, socket: Net.Socket): Promise<string> {
		const bridge = this._debugBridge;
		if (!bridge) { return '[Debug unavailable]'; }

		const rest = input.slice('/debug'.length).trim();
		const space = rest.indexOf(' ');
		const sub = space === -1 ? rest : rest.slice(0, space);
		const argText = space === -1 ? '' : rest.slice(space + 1).trim();

		if (!sub) { return DEBUG_USAGE; }

		let args: unknown;
		if (argText) {
			try {
				args = JSON.parse(argText);
			} catch (e: any) {
				return `[Debug error: invalid JSON: ${e.message}]`;
			}
		}

		switch (sub) {
			case 'start': {
				if (bridge.isActive()) {
					return '[Debug error: a debug session is already active]';
				}
				if (this._debugStarting) {
					return '[Debug error: a debug session is already starting]';
				}
				const config = {
					type: 'apl',
					request: 'launch',
					name: 'aple debug',
					// "" = live-workspace debug. Without it the config provider
					// falls back to whichever APL file is open in the editor and
					// the launch would load and run that file.
					program: '',
					...(args as Record<string, unknown> | undefined),
				};
				this._debugStarting = true;
				try {
					return await bridge.start(config) ? '[Debug started]' : '[Debug start failed]';
				} catch (e: any) {
					return `[Debug error: ${e.message}]`;
				} finally {
					this._debugStarting = false;
				}
			}
			case 'stop': {
				if (!bridge.isActive()) { return '[No debug session]'; }
				try {
					await bridge.stop();
					return '[Debug stopped]';
				} catch (e: any) {
					return `[Debug error: ${e.message}]`;
				}
			}
			case 'status':
				return bridge.isActive() ? '[Debug session active]' : '[No debug session]';
			case 'listen': {
				this.addDebugListener(socket);
				return '[Listening]';
			}
			default: {
				if (!bridge.isActive()) { return '[No debug session]'; }
				if (args === undefined && THREAD_DEFAULT_COMMANDS.has(sub)) {
					args = { threadId: 1 };
				}
				if (SERIALIZED_COMMANDS.has(sub)) {
					// Hold the FIFO slot until the debug evaluation settles;
					// the connection handler writes the reply when we resolve.
					return new Promise<string>((resolve) => {
						this._queue.push({
							socket,
							run: async () => resolve(await this.forwardDebugRequest(bridge, sub, args)),
						});
						this.dispatch();
					});
				}
				return this.forwardDebugRequest(bridge, sub, args);
			}
		}
	}

	private async forwardDebugRequest(bridge: DebugBridge, command: string, args: unknown): Promise<string> {
		try {
			const result = await bridge.request(command, args);
			return JSON.stringify(result ?? {});
		} catch (e: any) {
			return `[Debug error: ${e.message}]`;
		}
	}

	/**
	 * Subscribe a socket to DAP events. The bridge subscription itself is
	 * lazy — created on the first listener, removed in stop() — so a
	 * server nobody debugs through never touches the bridge.
	 */
	private addDebugListener(socket: Net.Socket): void {
		this._debugListeners.add(socket);
		socket.once('close', () => {
			this._debugListeners.delete(socket);
			this.detachDapListenerIfIdle();
		});

		if (this._dapListener || !this._debugBridge) { return; }
		this._dapListener = (msg: unknown) => {
			const text = JSON.stringify(msg) + '\0';
			for (const s of this._debugListeners) {
				if (s.destroyed) {
					this._debugListeners.delete(s);
					continue;
				}
				try { s.write(text); } catch { this._debugListeners.delete(s); }
			}
			this.detachDapListenerIfIdle();
		};
		this._debugBridge.on('dap', this._dapListener);
	}

	/** Drop the bridge subscription once nobody is listening. */
	private detachDapListenerIfIdle(): void {
		if (this._debugListeners.size === 0 && this._dapListener && this._debugBridge) {
			this._debugBridge.removeListener('dap', this._dapListener);
			this._dapListener = undefined;
		}
	}
}
