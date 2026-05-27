import * as Net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ReplManager } from './replManager';

/**
 * TCP server that lets external tools execute APL in the active REPL session.
 *
 * Protocol:
 *  - First non-empty line of each connection must be `]auth <token>\n`.
 *    The token is a 64-char hex string written to `<tokenDir>/eval-token`
 *    on start. Anything else closes the socket before any APL reaches the
 *    session — this is what protects against local processes and against
 *    browser drive-by attacks (a browser cannot make the first line of a
 *    TCP payload be `]auth …`, since the request always starts with an
 *    HTTP request line or WS handshake).
 *  - On success the server writes `(ok)\0`. The client may then send APL
 *    expressions (one per line) or `]`-prefixed meta-commands. Each reply
 *    is text followed by `\0`.
 *  - Requests are processed through a server-wide FIFO queue so that
 *    concurrent connections — and rapid back-to-back requests on a single
 *    connection — don't cross-contaminate outputs.
 *
 * Bound to 127.0.0.1. Auth is the primary defence; loopback is defence-in-depth.
 */

const TOKEN_FILE = 'eval-token';

interface EvalRequest {
	expr: string;
	socket: Net.Socket;
}

export class EvalServer {
	private _server?: Net.Server;
	private _manager: ReplManager;
	private _tokenDir: string;
	private _token?: string;
	private _queue: EvalRequest[] = [];
	private _busy = false;
	private _sockets: Set<Net.Socket> = new Set();

	constructor(manager: ReplManager, tokenDir: string) {
		this._manager = manager;
		this._tokenDir = tokenDir;
	}

	public async start(port: number): Promise<number> {
		if (this._server) {
			const addr = this._server.address() as Net.AddressInfo;
			return addr.port;
		}

		this._token = crypto.randomBytes(32).toString('hex');
		fs.mkdirSync(this._tokenDir, { recursive: true });
		const tokenPath = path.join(this._tokenDir, TOKEN_FILE);
		try { fs.unlinkSync(tokenPath); } catch { /* may not exist */ }
		fs.writeFileSync(tokenPath, this._token, { mode: 0o600 });

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
			// Revoke the token first so even an in-flight connection can't be reused,
			// and so cleanup runs even if `server.close()` is slow.
			if (this._token !== undefined) {
				try { fs.unlinkSync(path.join(this._tokenDir, TOKEN_FILE)); } catch { /* */ }
				this._token = undefined;
			}
			// Destroy live sockets — otherwise `server.close()` waits forever for idle clients.
			for (const s of this._sockets) {
				try { s.destroy(); } catch { /* */ }
			}
			this._sockets.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			console.log('[EvalServer] Stopped');
		} else if (this._token !== undefined) {
			try { fs.unlinkSync(path.join(this._tokenDir, TOKEN_FILE)); } catch { /* */ }
			this._token = undefined;
		}
		for (const req of this._queue) {
			try { req.socket.destroy(); } catch { /* */ }
		}
		this._queue = [];
		this._busy = false;
	}

	private handleConnection(socket: Net.Socket): void {
		this._sockets.add(socket);
		socket.once('close', () => this._sockets.delete(socket));

		let buf = '';
		let authenticated = false;

		socket.on('data', (data) => {
			buf += data.toString();
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const expr = buf.slice(0, nl).replace(/\r$/, '');
				buf = buf.slice(nl + 1);
				if (!expr) { continue; }

				if (!authenticated) {
					if (this._token !== undefined && expr === `]auth ${this._token}`) {
						authenticated = true;
						try { socket.write('(ok)\0'); } catch { /* */ }
					} else {
						try { socket.end('(auth required)\0'); } catch { /* */ }
						try { socket.destroy(); } catch { /* */ }
						return;
					}
					continue;
				}

				if (expr.startsWith(']')) {
					try { socket.write(this.handleMetaCommand(expr) + '\0'); } catch { /* */ }
					continue;
				}

				this._queue.push({ expr, socket });
				this.dispatch();
			}
		});

		socket.on('error', () => { /* swallow — Node defaults to throwing */ });
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
			// If the in-flight client disconnects before `ready` fires, drain
			// the listeners and free the queue — otherwise `_busy` stays true
			// forever and every later request wedges.
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
				// Join all remaining parts so multi-word labels work, e.g. `]switch My Tab`.
				const id = parts.slice(1).join(' ');
				if (!id) { return '[Usage: ]switch <replId>]'; }
				const tab = this._manager.getTab(id);
				if (!tab) {
					const match = this._manager.getTabList().find(t =>
						t.label.toLowerCase().includes(id.toLowerCase()) ||
						t.replId.includes(id)
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
