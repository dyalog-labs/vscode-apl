import * as Net from 'net';
import type { ReplManager } from './replManager';

/**
 * TCP server (127.0.0.1) that runs APL in the active REPL for external tools.
 *
 * Protocol: APL expressions or `]`-prefixed meta-commands, one per line;
 * each reply is text terminated by `\0`. A single FIFO queue serializes
 * requests so concurrent connections don't cross-contaminate output.
 *
 * Browser drive-by defense: reject HTTP request lines (plaintext) and TLS
 * ClientHellos (first byte 0x16); drop sockets that send nothing within
 * PRE_DATA_TIMEOUT_MS. Any local process running as the user can still
 * connect — same trust model as RIDE and the language server.
 */

// Known HTTP method + ` HTTP/<digit>` trailer. Both are required so a stray
// APL call like `GET 1 2 3` or `FOO bar HTTP/1` won't false-match.
const HTTP_REQUEST_LINE = /^(GET|POST|HEAD|OPTIONS|PUT|DELETE|PATCH|CONNECT|TRACE) \S+ HTTP\/\d/;
const TLS_HANDSHAKE_BYTE = 0x16;
const PRE_DATA_TIMEOUT_MS = 2000;

interface EvalRequest {
	expr: string;
	socket: Net.Socket;
}

export class EvalServer {
	private _server?: Net.Server;
	private _manager: ReplManager;
	private _queue: EvalRequest[] = [];
	private _busy = false;
	private _sockets: Set<Net.Socket> = new Set();

	constructor(manager: ReplManager) {
		this._manager = manager;
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

				if (expr.startsWith(']')) {
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
			session.execute(req.expr);
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
				// Multi-word labels: `]switch My Tab`.
				const id = parts.slice(1).join(' ');
				if (!id) { return '[Usage: ]switch <replId>]'; }
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
				return `[Unknown command: ]${cmd}]\nAvailable: ]history, ]tabs, ]switch <id>`;
		}
	}
}
