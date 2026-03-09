import * as vscode from 'vscode';
import * as fs from 'fs';
import * as Path from 'path';
import { AplSession } from './aplSession';
import { normPath } from './utils';

interface LinkInfoRow {
	aplName: string;
	filePath: string;
	startLine: number;
}

/**
 * Syncs VS Code breakpoints to the Dyalog interpreter when a REPL
 * session is connected but no debug session is active.
 *
 * When a debug session starts, this disables itself to avoid conflicting
 * with AplRuntime's breakpoint management. When the debug session ends,
 * it re-syncs all current breakpoints.
 */
export class ReplBreakpointSync implements vscode.Disposable {

	private _session: AplSession | undefined;
	private _linkInfo: LinkInfoRow[] = [];
	private _linkMap: Record<string, string> = {};
	private _debugSessionActive = false;
	private _linkInfoLoaded = false;
	private _folder = '';
	private _disposables: vscode.Disposable[] = [];


	constructor() {
		this._disposables.push(
			vscode.debug.onDidChangeBreakpoints(e => this._onBreakpointsChanged(e))
		);

		this._disposables.push(
			vscode.debug.onDidStartDebugSession(session => {
				if (session.type === 'apl') {
					this._debugSessionActive = true;
				}
			})
		);

		this._disposables.push(
			vscode.debug.onDidTerminateDebugSession(session => {
				if (session.type === 'apl') {
					// Only clear flag if no other APL debug session is still active
					const hasOther = vscode.debug.activeDebugSession?.type === 'apl';
					if (!hasOther) {
						this._debugSessionActive = false;
						this._syncAllBreakpoints();
					}
				}
			})
		);
	}

	public async attachToSession(session: AplSession, folder: string): Promise<void> {
		// Guard: don't re-attach if already attached to this session
		if (this._session === session) {
			return;
		}
		this._session = session;
		this._folder = folder;
		this._linkInfoLoaded = false;

		await this._loadLinkInfo();

		if (!this._debugSessionActive) {
			await this._syncAllBreakpoints();
		}
	}

	public detachFromSession(): void {
		this._session = undefined;
		this._linkInfo = [];
		this._linkMap = {};
		this._linkInfoLoaded = false;
	}

	public async refreshLinkInfo(): Promise<void> {
		if (this._session?.isConnected) {
			await this._loadLinkInfo();
			if (!this._debugSessionActive) {
				await this._syncAllBreakpoints();
			}
		}
	}

	public dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}

	// --- Private ---

	private async _loadLinkInfo(): Promise<void> {
		if (!this._session?.isConnected || !this._folder) {
			return;
		}

		const linkPath = `${this._folder}/.vscode/link.json`;
		const linkDir = Path.dirname(linkPath);
		if (!fs.existsSync(linkDir)) {
			fs.mkdirSync(linkDir, { recursive: true });
		}

		// Delete stale file
		try { fs.unlinkSync(linkPath); } catch { /* ignore */ }

		// Execute in interpreter and wait for the echo
		await this._execAndWait(`{}(⊂⎕JSON ⍕¨¨5177⌶⍬)⎕NPUT '${linkPath}' 1`);

		// Wait for file to appear (up to 5 seconds)
		const exists = await this._waitForFile(linkPath, 5000);
		if (!exists) {
			return;
		}

		try {
			const raw = fs.readFileSync(linkPath, 'utf-8');
			const map: Record<string, string> = {};
			this._linkInfo = JSON.parse(raw).map((row: string[]) => {
				const aplName = row[0][0] === '#' ? row[0] : `${row[1]}.${row[0]}`;
				const filePath = Path.resolve(row[3]);
				const startLine = +row[4];
				map[aplName] = filePath;
				map[filePath] = aplName;
				return { aplName, filePath, startLine };
			});
			this._linkMap = map;
			this._linkInfoLoaded = true;
		} catch (e) {
			console.error('[ReplBreakpointSync] Failed to parse link info:', e);
		}
	}

	private _waitForFile(filePath: string, timeout: number): Promise<boolean> {
		return new Promise(resolve => {
			const start = Date.now();
			const interval = Math.min(timeout, 100);
			const check = () => {
				if (fs.existsSync(filePath)) {
					resolve(true);
				} else if (Date.now() - start > timeout) {
					resolve(false);
				} else {
					setTimeout(check, interval);
				}
			};
			check();
		});
	}

	private _execAndWait(expression: string): Promise<void> {
		return new Promise<void>(resolve => {
			if (!this._session?.isConnected) {
				resolve();
				return;
			}

			const text = expression.endsWith('\n') ? expression : `${expression}\n`;
			const handler = (input: string) => {
				if (input === text) {
					this._session?.removeListener('echo', handler);
					clearTimeout(timer);
					resolve();
				}
			};
			this._session.on('echo', handler);

			const timer = setTimeout(() => {
				this._session?.removeListener('echo', handler);
				resolve();
			}, 5000);

			this._session.execute(expression);
		});
	}

	private async _onBreakpointsChanged(e: vscode.BreakpointsChangeEvent): Promise<void> {
		if (!this._session?.isConnected || this._debugSessionActive) { return; }

		if (!this._linkInfoLoaded) {
			await this._loadLinkInfo();
			if (!this._linkInfoLoaded) { return; }
		}

		const affectedFiles = new Set<string>();
		for (const bp of [...e.added, ...e.removed, ...e.changed]) {
			if (bp instanceof vscode.SourceBreakpoint) {
				affectedFiles.add(normPath(bp.location.uri.fsPath));
			}
		}

		for (const filePath of affectedFiles) {
			this._syncBreakpointsForFile(filePath);
		}
	}

	private _syncBreakpointsForFile(filePath: string): void {
		if (!this._session?.isConnected) { return; }

		const normalizedPath = normPath(filePath);

		// Get all enabled VS Code breakpoints for this file
		const vscBps = vscode.debug.breakpoints.filter(
			bp => bp instanceof vscode.SourceBreakpoint
				&& bp.enabled
				&& normPath(bp.location.uri.fsPath) === normalizedPath
		) as vscode.SourceBreakpoint[];

		// Group breakpoint lines by APL function name
		const fnbp: Record<string, number[]> = {};
		for (const bp of vscBps) {
			const line = bp.location.range.start.line; // 0-based
			const row = this._linkInfo.find(
				r => normPath(r.filePath) === normalizedPath && r.startLine < line
			);
			if (row) {
				const lines = fnbp[row.aplName] || [];
				lines.push(line - row.startLine);
				fnbp[row.aplName] = lines;
			}
		}

		// Find all APL functions mapped to this file
		const allFunctions = new Set(
			this._linkInfo
				.filter(r => normPath(r.filePath) === normalizedPath)
				.map(r => r.aplName)
		);

		// Clear stops on functions that no longer have breakpoints
		for (const aplName of allFunctions) {
			if (!fnbp[aplName]) {
				this._session.execute(`{}⍬ ⎕STOP '${aplName}'`);
			}
		}

		// Set stops on functions that have breakpoints
		for (const aplName of Object.keys(fnbp)) {
			const lines = fnbp[aplName].join(' ');
			this._session.execute(`{}${lines} ⎕STOP '${aplName}'`);
		}
	}

	private _syncAllBreakpoints(): void {
		if (!this._session?.isConnected || !this._linkInfoLoaded) { return; }

		const affectedFiles = new Set<string>();
		for (const bp of vscode.debug.breakpoints) {
			if (bp instanceof vscode.SourceBreakpoint) {
				affectedFiles.add(normPath(bp.location.uri.fsPath));
			}
		}

		for (const filePath of affectedFiles) {
			this._syncBreakpointsForFile(filePath);
		}
	}
}
