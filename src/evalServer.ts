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
 */
export class EvalServer {
	private _server?: Net.Server;
	private _manager: ReplManager;

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

					const session = this._manager.activeSession;
					if (!session || !session.isConnected) {
						socket.write('[No active session]\0');
						continue;
					}

					let output = '';
					const onOutput = (text: string) => { output += text; };
					const onReady = () => {
						session.removeListener('output', onOutput);
						session.removeListener('ready', onReady);
						socket.write(output + '\0');
					};
					session.on('output', onOutput);
					session.on('ready', onReady);
					session.execute(expr);
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
