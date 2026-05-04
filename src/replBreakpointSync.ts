import * as vscode from 'vscode';
import { AplSession, LinkInfoRow } from './aplSession';
import { normPath } from './utils';

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
	private _debugSessionActive = false;
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
					this._debugSessionActive = false;
					this.refreshLinkInfo();
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

		await session.loadLinkInfo(folder);

		if (!this._debugSessionActive) {
			this._syncAllBreakpoints();
		}
	}

	public detachFromSession(): void {
		this._session = undefined;
	}

	public async refreshLinkInfo(): Promise<void> {
		if (this._session?.isConnected) {
			await this._session.refreshLinkInfo(this._folder);
			if (!this._debugSessionActive) {
				this._syncAllBreakpoints();
			}
		}
	}

	public dispose(): void {
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}

	// --- Private ---

	private async _onBreakpointsChanged(e: vscode.BreakpointsChangeEvent): Promise<void> {
		if (!this._session?.isConnected || this._debugSessionActive) { return; }

		// Ensure linkInfo is loaded — usually already done on session 'ready'.
		await this._session.loadLinkInfo(this._folder);
		if (this._session.linkInfo.length === 0) { return; }

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

		const linkInfo = this._session.linkInfo;
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
			// Find the closest preceding function (largest startLine <= line)
			let row: LinkInfoRow | undefined;
			for (const r of linkInfo) {
				if (normPath(r.filePath) === normalizedPath && r.startLine <= line) {
					if (!row || r.startLine > row.startLine) { row = r; }
				}
			}
			if (row) {
				const lines = fnbp[row.aplName] || [];
				lines.push(line - row.startLine);
				fnbp[row.aplName] = lines;
			}
		}

		// Find all APL functions mapped to this file
		const allFunctions = new Set(
			linkInfo
				.filter(r => normPath(r.filePath) === normalizedPath)
				.map(r => r.aplName)
		);

		// Clear stops on functions that no longer have breakpoints
		// Use error guard (0::⍬) to skip non-stoppable items (namespaces, classes)
		for (const aplName of allFunctions) {
			if (!fnbp[aplName]) {
				this._session.execute(`{0::⍬ ⋄ ⍬ ⎕STOP ⍵}'${aplName}'`);
			}
		}

		// Set stops on functions that have breakpoints
		for (const aplName of Object.keys(fnbp)) {
			const lines = fnbp[aplName].join(' ');
			this._session.execute(`{0::⍬ ⋄ ${lines} ⎕STOP ⍵}'${aplName}'`);
		}
	}

	private _syncAllBreakpoints(): void {
		if (!this._session?.isConnected) { return; }
		const linkInfo = this._session.linkInfo;
		if (linkInfo.length === 0) { return; }

		// Include all linked files so stale ⎕STOP from debug sessions get cleared
		const allFiles = new Set(
			linkInfo.map(r => normPath(r.filePath))
		);
		for (const bp of vscode.debug.breakpoints) {
			if (bp instanceof vscode.SourceBreakpoint) {
				allFiles.add(normPath(bp.location.uri.fsPath));
			}
		}

		for (const filePath of allFiles) {
			this._syncBreakpointsForFile(filePath);
		}
	}
}
