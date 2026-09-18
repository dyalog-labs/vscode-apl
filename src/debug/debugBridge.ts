import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import type { DebugBridge } from '../repl/evalServer';

/**
 * `vscode.debug`-backed implementation of the eval server's DebugBridge.
 *
 * Sessions started through here are real VS Code debug sessions, so the
 * native UI (line highlight, call stack, variables) fires alongside the
 * external client. The bridge also adopts `apl` sessions the user starts
 * from the UI (F5) — an external client can then drive/observe those,
 * and `/debug start` correctly refuses while one is active.
 *
 * Events reach clients via a DebugAdapterTracker registered for the
 * `apl` type: every DAP event the adapter sends is re-emitted as `'dap'`.
 */
export class VsCodeDebugBridge extends EventEmitter implements DebugBridge {
	private _session?: vscode.DebugSession;
	private _disposables: vscode.Disposable[] = [];

	constructor() {
		super();

		// Adopt a session that was already running before we were created
		// (e.g. eval server started mid-debug). The tracker below can't see
		// it — trackers only attach to sessions created after registration —
		// but requests still work through customRequest.
		if (vscode.debug.activeDebugSession?.type === 'apl') {
			this._session = vscode.debug.activeDebugSession;
		}

		this._disposables.push(
			vscode.debug.registerDebugAdapterTrackerFactory('apl', {
				createDebugAdapterTracker: () => ({
					onDidSendMessage: (msg: any) => {
						if (msg?.type === 'event') { this.emit('dap', msg); }
					},
				}),
			}),
			vscode.debug.onDidStartDebugSession((s) => {
				if (s.type === 'apl' && !this._session) { this._session = s; }
			}),
			vscode.debug.onDidTerminateDebugSession((s) => {
				if (s === this._session) { this._session = undefined; }
			}),
		);
	}

	public isActive(): boolean {
		return this._session !== undefined;
	}

	public async start(config: Record<string, unknown>): Promise<boolean> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		return vscode.debug.startDebugging(folder, config as unknown as vscode.DebugConfiguration);
	}

	public async stop(): Promise<void> {
		if (this._session) {
			await vscode.debug.stopDebugging(this._session);
		}
	}

	public async request(command: string, args?: unknown): Promise<unknown> {
		const session = this._session;
		if (!session) { throw new Error('no active apl debug session'); }
		if (command === 'setBreakpoints') {
			return this.setBreakpointsViaModel(args as any);
		}
		return session.customRequest(command, args);
	}

	/**
	 * `setBreakpoints` must NOT go straight to the adapter: that would
	 * change the adapter's breakpoints while VS Code's model (gutter,
	 * Breakpoints panel, post-debug ⎕STOP sync) kept the old ones, and
	 * the next gutter edit or sync would silently revert the change.
	 * Instead update VS Code's model — VS Code then sends the adapter a
	 * proper setBreakpoints itself. The reply acknowledges the accepted
	 * lines; adapter verification arrives asynchronously as breakpoint
	 * events on `/debug listen`.
	 */
	private setBreakpointsViaModel(args: { source?: { path?: string }; breakpoints?: Array<{ line: number }> }): unknown {
		const path = args?.source?.path;
		if (!path) { throw new Error('setBreakpoints requires source.path'); }
		const uri = vscode.Uri.file(path);

		const existing = vscode.debug.breakpoints.filter(bp =>
			bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === uri.fsPath);
		if (existing.length > 0) { vscode.debug.removeBreakpoints(existing); }

		const lines = (args.breakpoints ?? []).map(b => b.line);
		if (lines.length > 0) {
			vscode.debug.addBreakpoints(lines.map(l => new vscode.SourceBreakpoint(
				new vscode.Location(uri, new vscode.Position(l - 1, 0)))));
		}
		return { breakpoints: lines.map(line => ({ line, verified: false })) };
	}

	public dispose(): void {
		for (const d of this._disposables) { d.dispose(); }
		this._disposables = [];
		this.removeAllListeners();
	}
}
