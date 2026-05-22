import * as Net from 'net';
import * as vscode from 'vscode';
import type { ReplManager } from './replManager';

/**
 * A lightweight TCP server that allows external tools (e.g. Claude Code)
 * to execute APL expressions in the active REPL session.
 *
 * Protocol:
 *  - Client sends one line of APL terminated by \n
 *  - Server replies with the output followed by a NUL byte (\0)
 *  - Lines starting with ] are meta-commands handled locally
 *
 * Binds to 127.0.0.1 only. Disabled by default (apl.evalServer.port = 0).
 *
 * Requests are processed through a server-wide FIFO queue so that
 * concurrent connections — and rapid back-to-back requests on a single
 * connection — don't cross-contaminate outputs.
 */

interface EvalRequest {
	expr: string;
	socket: Net.Socket;
}

export class EvalServer {
	private _server?: Net.Server;
	private _manager: ReplManager;
	private _queue: EvalRequest[] = [];
	private _busy = false;

	constructor(manager: ReplManager) {
		this._manager = manager;
	}

	public start(): void {
		if (this._server) {
			return;
		}
		const config = vscode.workspace.getConfiguration('apl');
		const port = config.get<number>('evalServer.port') || 0;
		if (port <= 0) {
			return;
		}

		this._server = Net.createServer((socket) => {
			let buf = '';

			socket.on('data', (data) => {
				buf += data.toString();
				let nl: number;
				while ((nl = buf.indexOf('\n')) !== -1) {
					const expr = buf.slice(0, nl).replace(/\r$/, '');
					buf = buf.slice(nl + 1);
					if (!expr) { continue; }

					if (expr.startsWith(']')) {
						socket.write(this.handleMetaCommand(expr) + '\0');
						continue;
					}

					this._queue.push({ expr, socket });
					this.dispatch();
				}
			});

			socket.on('error', () => {});
		});

		this._server.on('error', (e: Error) => {
			console.log(`[EvalServer] Error: ${e.message}`);
			this._server = undefined;
		});

		this._server.listen(port, '127.0.0.1', () => {
			console.log(`[EvalServer] Listening on 127.0.0.1:${port}`);
		});
	}

	public stop(): void {
		if (this._server) {
			this._server.close();
			this._server = undefined;
			console.log('[EvalServer] Stopped');
		}
		for (const req of this._queue) {
			try { req.socket.destroy(); } catch { /* */ }
		}
		this._queue = [];
		this._busy = false;
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
			const onOutput = (text: string) => { output += text; };
			const onReady = () => {
				session.removeListener('output', onOutput);
				session.removeListener('ready', onReady);
				this._busy = false;
				try { req.socket.write(output + '\0'); } catch { /* */ }
				this.dispatch();
			};
			session.on('output', onOutput);
			session.on('ready', onReady);
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
				const id = parts[1];
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
