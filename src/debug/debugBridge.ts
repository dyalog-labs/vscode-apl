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
	/** How long setBreakpoints waits for adapter propagation before
	 *  falling back to the optimistic reply. Tests shrink this. */
	public propagationTimeoutMs = 2000;
	/** Independent propagation barriers for each source file. */
	private _bpWaiters = new Map<string, {
		lines: number[];
		reply: Promise<unknown>;
		seq?: number;
		settled: boolean;
		settle: (body?: unknown) => void;
	}>();

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
				createDebugAdapterTracker: (session: vscode.DebugSession) => {
					// Adopt the first session to appear when none is tracked —
					// covers /debug listen before any /debug start, where
					// onDidStartDebugSession may fire after early DAP events.
					if (!this._session) { this._session = session; }
					return {
						onWillReceiveMessage: (msg: any) => {
							// VS Code propagating our model change: this is the
							// final setBreakpoints request for the waited-on file.
							// Removals can send intermediate (including empty)
							// sets; only acknowledge the requested replacement.
							if (session !== this._session) { return; }
							if (msg?.type !== 'request' || msg.command !== 'setBreakpoints'
								|| !msg.arguments?.source?.path) { return; }
							const w = this._bpWaiters.get(vscode.Uri.file(msg.arguments.source.path).fsPath);
							if (w && w.seq === undefined) {
								const specs = msg.arguments.breakpoints ?? [];
								if (Array.isArray(specs)) {
									const lines = [...new Set<number>(specs.map(b => b.line))].sort((a, b) => a - b);
									if (lines.length === w.lines.length && lines.every((line, i) => line === w.lines[i])) {
										w.seq = msg.seq;
									}
								}
							}
						},
						onDidSendMessage: (msg: any) => {
							// Only the tracked session's events may reach
							// listeners: requests target _session, and mixing
							// in another session's stopped/terminated events
							// would have clients stepping the wrong session.
							if (session !== this._session) { return; }
							if (msg?.type === 'response' && msg.command === 'setBreakpoints') {
								for (const w of this._bpWaiters.values()) {
									if (w.seq !== undefined && msg.request_seq === w.seq) {
										w.settle(msg.body);
										break;
									}
								}
							}
							if (msg?.type === 'event') { this.emit('dap', msg); }
						},
					};
				},
			}),
			vscode.debug.onDidStartDebugSession((s) => {
				if (s.type === 'apl' && !this._session) { this._session = s; }
			}),
			vscode.debug.onDidTerminateDebugSession((s) => {
				if (s === this._session) {
					this._session = undefined;
					for (const w of this._bpWaiters.values()) { w.settle(); }
				}
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
	 * proper setBreakpoints itself. The reply is held until the tracker
	 * observes the adapter's response to that propagation and carries its
	 * authoritative body (verified flags, breakpoint ids), so a client may
	 * `continue` immediately after. If nothing arrives within
	 * `propagationTimeoutMs` (adapter gone, change coalesced away) the
	 * optimistic accepted-lines reply is returned instead of hanging.
	 */
	private setBreakpointsViaModel(args: { source?: { path?: string }; breakpoints?: Array<{ line: number }> }): unknown {
		const path = args?.source?.path;
		if (!path) { throw new Error('setBreakpoints requires source.path'); }
		const uri = vscode.Uri.file(path);

		// Validate and construct the full replacement BEFORE touching the
		// model — clearing first would turn a malformed request into silent
		// destruction of the user's breakpoints.
		const specs = args.breakpoints ?? [];
		if (!Array.isArray(specs)) { throw new Error('breakpoints must be an array'); }
		const lines = specs.map(b => b?.line);
		if (lines.some(l => typeof l !== 'number' || !Number.isInteger(l) || l < 1)) {
			throw new Error('breakpoint lines must be integers >= 1');
		}
		const targetLines = [...new Set(lines)].sort((a, b) => a - b);
		const existing = vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint =>
			bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === uri.fsPath);
		// Keep already-requested stops so removing other lines cannot briefly
		// produce the target set and then clear it again before the additions.
		const retained = existing.filter(bp => bp.enabled && !bp.condition && !bp.hitCondition && !bp.logMessage
			&& bp.location.range.start.character === 0 && lines.includes(bp.location.range.start.line + 1));
		const removals = existing.filter(bp => !retained.includes(bp));
		const additions = lines.filter(line => !retained.some(bp => bp.location.range.start.line + 1 === line))
			.map(line => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0))));
		const optimistic = { breakpoints: lines.map(line => ({ line, verified: false })) };

		// Nothing to change → VS Code sends the adapter nothing; waiting
		// would only burn the timeout.
		if (removals.length === 0 && additions.length === 0) {
			const pending = this._bpWaiters.get(uri.fsPath);
			if (pending && targetLines.length === pending.lines.length
				&& targetLines.every((line, i) => line === pending.lines[i])) {
				return pending.reply;
			}
			return optimistic;
		}

		// A replacement supersedes only the pending change for this file.
		this._bpWaiters.get(uri.fsPath)?.settle(undefined);
		let resolve!: (body: unknown) => void;
		const reply = new Promise<unknown>(r => { resolve = r; });
		let timer: NodeJS.Timeout;
		const waiter = {
			lines: targetLines,
			reply,
			seq: undefined as number | undefined,
			settled: false,
			settle: (body?: unknown) => {
				if (waiter.settled) { return; }
				waiter.settled = true;
				clearTimeout(timer);
				if (this._bpWaiters.get(uri.fsPath) === waiter) { this._bpWaiters.delete(uri.fsPath); }
				resolve(body ?? optimistic);
			},
		};
		timer = setTimeout(() => waiter.settle(undefined), this.propagationTimeoutMs);
		this._bpWaiters.set(uri.fsPath, waiter);

		// Install the waiter BEFORE touching the model: propagation can be
		// synchronous-ish and must not race past us.
		if (removals.length > 0) { vscode.debug.removeBreakpoints(removals); }
		if (additions.length > 0) { vscode.debug.addBreakpoints(additions); }

		return reply;
	}

	public dispose(): void {
		for (const w of this._bpWaiters.values()) { w.settle(); }
		for (const d of this._disposables) { d.dispose(); }
		this._disposables = [];
		this.removeAllListeners();
	}
}
