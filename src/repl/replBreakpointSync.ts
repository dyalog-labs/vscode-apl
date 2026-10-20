import * as vscode from 'vscode';
import type { AplSession } from '../session/aplSession';
import { CLEAR_ALL_STOPS, mapBreakpointsToStops, packStatements, setStopsStatement } from '../session/linkBreakpoints';
import { normPath } from '../utils';

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

		const affectedFiles = new Set<string>();
		for (const bp of [...e.added, ...e.removed, ...e.changed]) {
			if (bp instanceof vscode.SourceBreakpoint && bp.location.uri.scheme === 'file') {
				affectedFiles.add(normPath(bp.location.uri.fsPath));
			}
		}
		if (affectedFiles.size === 0) { return; }

		await this._session.loadLinkInfo(this._folder);
		// An unknown APL file may have been fixed since the fetch: fetch again,
		// unless the interpreter is not answering.
		const known = new Set(this._session.linkInfo.map(r => normPath(r.filePath)));
		if (!this._session.linkInfoBackingOff && [...affectedFiles].some(f => !known.has(f) && isAplDocument(f))) {
			await this._session.refreshLinkInfo(this._folder);
		}
		if (this._session.linkInfo.length === 0) { return; }

		for (const filePath of affectedFiles) {
			this._syncBreakpointsForFile(filePath);
		}
	}

	/**
	 * Bring ⎕STOP for the file's functions in line with VS Code in as few
	 * lines as possible: clears for functions without breakpoints (skipped
	 * when CLEAR_ALL_STOPS just ran) and one set per function with them.
	 */
	private _syncBreakpointsForFile(filePath: string, clearOthers = true): void {
		if (!this._session?.isConnected) { return; }

		const linkInfo = this._session.linkInfo;
		const normalizedPath = normPath(filePath);

		// Get all enabled VS Code breakpoints for this file
		const vscBps = vscode.debug.breakpoints.filter(
			bp => bp instanceof vscode.SourceBreakpoint
				&& bp.enabled
				&& normPath(bp.location.uri.fsPath) === normalizedPath
		) as vscode.SourceBreakpoint[];

		const { stops } = mapBreakpointsToStops(
			vscBps.map(bp => ({ line: bp.location.range.start.line, bp })),
			filePath,
			linkInfo,
		);

		const statements: string[] = [];
		if (clearOthers) {
			const toClear = new Set(
				linkInfo
					.filter(r => normPath(r.filePath) === normalizedPath && !stops[r.aplName])
					.map(r => r.aplName)
			);
			for (const aplName of toClear) { statements.push(setStopsStatement(aplName, [])); }
		}
		for (const aplName of Object.keys(stops)) {
			statements.push(setStopsStatement(aplName, stops[aplName]));
		}

		for (const line of packStatements(statements)) {
			this._session.execute(line);
		}
	}

	/**
	 * Full sync: one line clears the stops of every function the interpreter
	 * loaded from a file, including those left by debugging or set by hand;
	 * then the files with breakpoints are set.
	 */
	private _syncAllBreakpoints(): void {
		if (!this._session?.isConnected) { return; }
		if (this._session.linkInfo.length === 0) { return; }

		this._session.execute(CLEAR_ALL_STOPS);

		const filesWithBreakpoints = new Set<string>();
		for (const bp of vscode.debug.breakpoints) {
			if (bp instanceof vscode.SourceBreakpoint && bp.location.uri.scheme === 'file') {
				filesWithBreakpoints.add(normPath(bp.location.uri.fsPath));
			}
		}
		for (const filePath of filesWithBreakpoints) {
			this._syncBreakpointsForFile(filePath, false);
		}
	}
}

/** Whether VS Code shows the file as APL; other languages are not Link's business. */
function isAplDocument(path: string): boolean {
	return vscode.workspace.textDocuments.some(d => d.languageId === 'apl' && normPath(d.uri.fsPath) === path);
}
