/*---------------------------------------------------------
 * Copyright (C) Tiamatica, martanit. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as Path from 'path';
import { AplSession, LinkInfoRow } from './aplSession';
import { mapBreakpointsToStops } from './linkBreakpoints';
import { TEMP_DIR } from './editWindowManager';
import { normPath, PendingRequest, PendingRequests } from './utils';
import type {
	AppendSessionOutputMessage, CloseWindowMessage, DisconnectMessage, EchoInputMessage,
	GetHelpInformationMessage, GotoWindowMessage, HadErrorMessage, IdentifyMessage,
	InterpreterStatusMessage, InternalErrorMessage, NotificationMessage, OpenWindowMessage,
	OptionsDialogMessage, ReplyClearTraceStopMonitorMessage, ReplyFormatCodeMessage,
	ReplyGetAutocompleteMessage, ReplyGetConfigurationMessage, ReplyGetHelpInformationMessage,
	ReplyGetLanguageBarMessage, ReplyGetLogMessage, ReplyGetSIStackMessage,
	ReplyGetSyntaxInformationMessage, ReplyGetThreadsMessage, ReplySaveChangesMessage,
	ReplyTreeListMessage, RideMessage, SetHighlightLineMessage, SetPromptTypeMessage,
	ShowHTMLMessage, StatusOutputMessage, StringDialogMessage, SysErrorMessage,
	TaskDialogMessage, UnknownCommandMessage, UpdateDisplayNameMessage, ValueTipMessage,
	WindowTypeChangedMessage,
} from './rideMessages';

/**
 * Parse a stack frame description in `name[line]` format.
 * Returns the function name and line offset within the function.
 */
export function parseStackDescription(description: string): { name: string; lineOffset: number } {
	const m = /(.*)\[(\d+)\]/.exec(description);
	if (!m) {
		return { name: description || '', lineOffset: 0 };
	}
	return { name: m[1], lineOffset: +m[2] };
}

export interface FileAccessor {
	isWindows: boolean;
	checkExists(filePath: string, timeout: number): Promise<boolean>;
	deleteFile(path: string): Promise<void>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export interface IAplBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IStepInTargets {
	id: number;
	label: string;
}

interface IStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
}

interface IStack {
	count: number;
	frames: IStackFrame[];
}

/**
 * APL runtime with minimal debugger functionality.
 */
export class AplRuntime extends EventEmitter {

	// the initial file we are debugging
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}
	
	// the current interpreterStatus
	private _status?: InterpreterStatusMessage;
	public get status(): InterpreterStatusMessage | undefined {
		return this._status;
	}

	// maps from sourceFile to array of APL breakpoints
	private _breakPoints = new Map<string, IAplBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private _noDebug = false;
	private _trace = false;
	private _folder = '.';

	private _session?: AplSession;
	private _autoDebug = false;  // True when debug session was auto-started on error
	/** Identifier of the REPL this debug session is attached to.  Used to
	 *  give tracer temp files a stable, per-REPL path so VS Code-persisted
	 *  breakpoints reapply across debug sessions. */
	private _replId = 'default';

	private _winId = 0; // current window id
	public get winId(): number { return this._winId; }
	public get currentWindow(): OpenWindowMessage | undefined { return this._windows[this._winId]; }

	private _executeText = '';
	private _echoReceived = new PendingRequest<void>();
	private _execTimeoutMs = 10000;
	private _windows: OpenWindowMessage[] = [];


	constructor(private _fileAccessor: FileAccessor) {
		super();
	}

	/**
	 * Attach to an existing AplSession (REPL) instead of spawning new interpreter.
	 * This allows debugging within the same Dyalog session as the REPL.
	 */
	public async attachToSession(session: AplSession, replId: string, program: string, folder: string, stopOnEntry: boolean, noDebug: boolean): Promise<void> {
		this._session = session;
		this._replId = replId;
		this._noDebug = noDebug;
		this._sourceFile = program;
		this._folder = folder;
		this._trace = stopOnEntry;

		// Register as the debug message handler
		session.setDebugHandler((command, args) => {
			this.handleMessage([command, args] as RideMessage);
		});

		// Refresh link info — REPL activity since the last load may have ⎕FIX'd
		// or re-Linked things. Matches the pre-consolidation behaviour where
		// the runtime always re-fetched on attach.
		await session.refreshLinkInfo(this._folder);

		// Debugging a file requires Link — without it there's no mapping
		// between file lines and APL functions for breakpoints and source
		// navigation.  REPL tracing (Ctrl+Enter) works without Link since
		// the function just needs to exist in the workspace.
		if (this._sourceFile && session.linkInfo.length === 0) {
			this.detachFromSession();
			throw new Error('Link is not active. Please link your workspace to debug files.');
		}

		// ⎕FIX the file to ensure the latest save is loaded (Link may lag)
		if (this._sourceFile) {
			await this.exec(0, `name←⊃2 ⎕FIX 'file://${this._sourceFile}'`, 1);
		}

		// Set breakpoints AFTER ⎕FIX (⎕FIX clears stops on the function)
		await this.initialiseBreakpoints();

		if (this._sourceFile) {
			if (this._trace) {
				// stopOnEntry: add line 1 to existing stops and execute.
				// (1,⎕STOP name) preserves breakpoints set by initialiseBreakpoints.
				// Don't await — the interpreter suspends at the first stop.
				this.exec(0, '{}(1,⎕STOP name)⎕STOP name ⋄ ⍎name').catch(e => {
					this.log(`stopOnEntry exec failed: ${e?.message ?? e}`);
				});
			} else {
				await this.exec(0, '⍎name', 1);
			}
		}
	}

	/**
	 * Detach from the shared session (called when debug session ends).
	 */
	public detachFromSession(): void {
		if (this._session) {
			this._session.clearDebugHandler();
			this._session = undefined;
		}
		this._autoDebug = false;
	}

	/**
	 * Attach to an AplSession that is already in a suspended state due to an untrapped error.
	 * Registers as the debug handler, gets link info, then replays buffered messages
	 * so the debugger renders the suspended state.
	 */
	public async attachToSuspendedSession(session: AplSession, replId: string, folder: string): Promise<void> {
		this._session = session;
		this._replId = replId;
		this._autoDebug = true;
		this._noDebug = false;
		this._sourceFile = '';
		this._folder = folder;
		this._trace = false;

		this.log(`attachToSuspendedSession: isSuspended=${session.isSuspended}, pendingCount=${session.pendingDebugMessageCount}`);

		// Register as the debug message handler
		session.setDebugHandler((command, args) => {
			this.handleMessage([command, args] as RideMessage);
		});

		// Check if still suspended (user might have resolved it already)
		if (!session.isSuspended) {
			this.log('attachToSuspendedSession: no longer suspended, aborting');
			this.detachFromSession();
			this.sendEvent('end');
			return;
		}

		// Get link info from existing session (interpreter can execute while suspended).
		// Refresh: the suspended interpreter may have ⎕FIX'd things since the last load.
		this.log('attachToSuspendedSession: refreshing link info...');
		await session.refreshLinkInfo(this._folder);

		this.log(`attachToSuspendedSession: replaying ${session.pendingDebugMessageCount} buffered messages`);
		// Replay the buffered messages (OpenWindow, HadError, SetHighlightLine)
		// This triggers openWindow() -> sets _winId, setHighlightLine() -> emits stopOnStep
		session.replayPendingMessages();
		this.log(`attachToSuspendedSession: done, _winId=${this._winId}`);
	}

	private async initialiseBreakpoints() {
		// Set breakpoints sequentially — exec can only track one echo at a time
		for (const [filePath, bps] of this._breakPoints) {
			await this.setBreakPointOnFile(bps, filePath);
		}
	}

	/**
	 * Stop debug session.
	 */
	public terminate(): void {
		this._autoDebug = false;
		this.detachFromSession();
	}

	private err(e: Error | string): void {
		console.error(e);
	}

	private log(msg: String): void {
		console.log(msg);
	}

	private handleMessage(rideMessage: RideMessage) {
		switch (rideMessage[0]) {
			case 'AppendSessionOutput': this.appendSessionOutput(rideMessage[1] as AppendSessionOutputMessage); break;
			case 'CloseWindow': this.closeWindow(rideMessage[1] as CloseWindowMessage); break;
			case 'Disconnect': this.disconnect(rideMessage[1] as DisconnectMessage); break;
			case 'EchoInput': this.echoInput(rideMessage[1] as EchoInputMessage); break;
			case 'GotoWindow': this.gotoWindow(rideMessage[1] as GotoWindowMessage); break;
			case 'HadError': this.hadError(rideMessage[1] as HadErrorMessage); break;
			case 'Identify': this.identify(rideMessage[1] as IdentifyMessage); break;
			case 'InternalError': this.internalError(rideMessage[1] as InternalErrorMessage); break;
			case 'InterpreterStatus': this.interpreterStatus(rideMessage[1] as InterpreterStatusMessage); break;
			case 'InvalidSyntax': this.invalidSyntax(); break;
			case 'NotificationMessage': this.notificationMessage(rideMessage[1] as NotificationMessage); break;
			case 'OpenWindow': this.openWindow(rideMessage[1] as OpenWindowMessage); break;
			case 'OptionsDialog': this.optionsDialog(rideMessage[1] as OptionsDialogMessage); break;
			case 'ReplyClearTraceStopMonitor': this.replyClearTraceStopMonitor(rideMessage[1] as ReplyClearTraceStopMonitorMessage); break;
			case 'ReplyFormatCode': this.replyFormatCode(rideMessage[1] as ReplyFormatCodeMessage); break;
			case 'ReplyGetAutocomplete': this.replyGetAutocomplete(rideMessage[1] as ReplyGetAutocompleteMessage); break;
			case 'ReplyGetConfiguration': this.replyGetConfiguration(rideMessage[1] as ReplyGetConfigurationMessage); break;
			case 'ReplyGetHelpInformation': this.replyGetHelpInformation(rideMessage[1] as ReplyGetHelpInformationMessage); break;
			case 'ReplyGetLanguageBar': this.replyGetLanguageBar(rideMessage[1] as ReplyGetLanguageBarMessage); break;
			case 'ReplyGetLog': this.replyGetLog(rideMessage[1] as ReplyGetLogMessage); break;
			case 'ReplyGetSIStack': this.replyGetSIStack(rideMessage[1] as ReplyGetSIStackMessage); break;
			case 'ReplyGetSyntaxInformation': this.replyGetSyntaxInformation(rideMessage[1] as ReplyGetSyntaxInformationMessage); break;
			case 'ReplyGetThreads': this.replyGetThreads(rideMessage[1] as ReplyGetThreadsMessage); break;
			case 'ReplySaveChanges': this.replySaveChanges(rideMessage[1] as ReplySaveChangesMessage); break;
			case 'ReplyTreeList': this.replyTreeList(rideMessage[1] as ReplyTreeListMessage); break;
			case 'ShowHTML': this.showHTML(rideMessage[1] as ShowHTMLMessage); break;
			case 'SetHighlightLine': this.setHighlightLine(rideMessage[1] as SetHighlightLineMessage); break;
			case 'SetPromptType': this.setPromptType(rideMessage[1] as SetPromptTypeMessage); break;
			case 'StatusOutput': this.statusOutput(rideMessage[1] as StatusOutputMessage); break;
			case 'StringDialog': this.stringDialog(rideMessage[1] as StringDialogMessage); break;
			case 'SysError': this.sysError(rideMessage[1] as SysErrorMessage); break;
			case 'TaskDialog': this.taskDialog(rideMessage[1] as TaskDialogMessage); break;
			case 'UnknownCommand': this.unknownCommand(rideMessage[1] as UnknownCommandMessage); break;
			case 'UpdateDisplayName': this.updateDisplayName(rideMessage[1] as UpdateDisplayNameMessage); break;
			case 'UpdateWindow': this.updateWindow(rideMessage[1] as OpenWindowMessage); break;
			case 'ValueTip': this.valueTip(rideMessage[1] as ValueTipMessage); break;
			case 'WindowTypeChanged': this.windowTypeChanged(rideMessage[1] as WindowTypeChangedMessage); break;
			default: this.send('UnknownCommand', { name: rideMessage[0] });
		}
	}

	private add(text: string) {
		this.sendEvent('output', text, this._sourceFile, 'stdout');
	}

	private send(command: string, args: object): void {
		if (this._session) {
			this._session.sendMessage(command, args);
		}
	}

	private async exec(trace: number, expression: string, awaitEcho?: number) {
		const text = `${expression}\n`;
		this._executeText = text;
		const echoPromise = awaitEcho ? this._echoReceived.create(this._execTimeoutMs) : undefined;
		this.send('Execute', { trace, text });
		if (echoPromise) {
			await echoPromise;
		}
	}

	// RIDE protocol message handlers
	private appendSessionOutput(x: AppendSessionOutputMessage) {
		this.add(x.result);
	}

	private identify(x: IdentifyMessage) {
	}

	private invalidSyntax() {
		this.err('Invalid syntax.');
	}

	private disconnect(x: DisconnectMessage) {
		this.log('Interpreter disconnected: ' + x.message);
		this.sendEvent('end');
	}

	private sysError(x: SysErrorMessage) {
		this.err('SysError: ' + x.text);
		this.sendEvent('end');
	}

	private internalError(x: InternalErrorMessage) {
		this.err(`An error (${x.error}) occurred processing ${x.message}`);
	}
	private notificationMessage(x: NotificationMessage) {
		// this.alert(x.message, 'Notification'); 
	}

	private updateDisplayName(x: UpdateDisplayNameMessage) {
		// this.wsid = x.displayName;
		// this.updTitle();
		// this.wse && this.wse.refresh();
	}

	private echoInput(x: EchoInputMessage) {
		if (x.input === this._executeText) {
			this._echoReceived.resolve(undefined);
		}
	}

	private setPromptType(x: SetPromptTypeMessage) {
	}

	private _hadError = 0;
	private _lastError: { dmx: number; error: number } | undefined;
	public get lastError() { return this._lastError; }
	private hadError(x: HadErrorMessage) {
		this._hadError = x.error;
		this._lastError = { dmx: x.dmx, error: x.error };
	}

	private gotoWindow(x: GotoWindowMessage) {
		const win = this._windows[x.win];
		if (!win) return;
		this.sendEvent('openWindow', { filename: win.filename });
	}

	private windowTypeChanged(x: WindowTypeChangedMessage) {
		// return ide.wins[x.win].setTC(x.tracer); 
	}
	
	private replyGetAutocomplete(x: ReplyGetAutocompleteMessage) {
		this._autocompletion.resolve({ options: x.options, skip: x.skip });
	}

	private replyGetHelpInformation(x: ReplyGetHelpInformationMessage) {
		this.sendEvent("openHelp", x);
	}

	private replyGetLanguageBar(x: ReplyGetLanguageBarMessage) {
		// const { entries } = x;
		// D.lb.order = entries.map((k) => k.avchar || ' ').join('');
		// entries.forEach((k) => {
		// if (k.avchar) {
		// 	D.lb.tips[k.avchar] = [
		// 	`${k.name.slice(5)} (${k.avchar})`,
		// 	k.helptext.join('\n'),
		// 	];
		// 	D.sqglDesc[k.avchar] = `${k.name.slice(5)} (${k.avchar})`;
		// }
		// });
		// ide.lbarRecreate();
	}
	private replyGetSyntaxInformation(x: ReplyGetSyntaxInformationMessage) {
		// D.ParseSyntaxInformation(x);
		// D.ipc && D.ipc.server.broadcast('syntax', D.syntax);
	}
	private valueTip(x: ValueTipMessage) {
		this.log('getValueTip');
		this._valueTip.resolve(x.token, x);
	}
	private setHighlightLine(x: SetHighlightLineMessage) {
		if (this._windows[x.win]) {
			this._windows[x.win].currentRow = x.line;
		}
		if (this._hadError === 1001) {
			this.sendEvent('stopOnBreakpoint');
			this._hadError = 0;
		} else {
			this.sendEvent('stopOnStep');
		}
	}
	private updateWindow(x: OpenWindowMessage) {
		this._windows[x.token] = x;
	}
	private replySaveChanges(x: ReplySaveChangesMessage) {
		if (x.err) {
			this.log(`SaveChanges failed for win ${x.win}: error ${x.err}`);
		} else {
			this.log(`SaveChanges succeeded for win ${x.win}`);
		}
	}
	private closeWindow(x: CloseWindowMessage) {
		const win = this._windows[x.win];
		if (!win) return;
		const filename = Path.resolve(win.filename);
		delete this._windows[x.win];

		// Hand temp files to EditWindowManager so the user can keep editing
		// after the debug session ends.  The manager will ⎕FIX on save and
		// delete the file when the tab is closed.
		if (filename.startsWith(TEMP_DIR)) {
			this.sendEvent('closeTempTab', { filename });
		}

		this.sendEvent('closeWindow', { filename });

		// Auto-terminate: if this was an auto-debug session and all tracer windows are closed,
		// the suspension has been resolved (user continued, reset, or cut back)
		if (this._autoDebug && !this._hasOpenWindows()) {
			this._autoDebug = false;
			this.sendEvent('end');
		}
	}

	private _hasOpenWindows(): boolean {
		return Object.keys(this._windows).length > 0;
	}


	private openWindow(x: OpenWindowMessage) {
		// When no file is associated (no Link), create a temp file from
		// the function source so VS Code can display it in the editor.
		// Use a per-REPL subdir so the filename stays stable across debug
		// sessions (VS Code persists breakpoints by file path).  No
		// cross-REPL collision because each REPL gets its own subdir.
		if (!x.filename && x.text?.length) {
			const replDir = Path.join(TEMP_DIR, this._replId);
			if (!fs.existsSync(replDir)) {
				fs.mkdirSync(replDir, { recursive: true });
			}
			const safeName = x.name.replace(/[⎕#./\\:*?"<>|]/g, '_');
			const tmpFile = Path.join(replDir, `${safeName}.aplf`);
			fs.writeFileSync(tmpFile, x.text.join('\n'), 'utf8');
			x.filename = tmpFile;

			// Tell EditWindowManager.  Pass the token + initial stops so
			// mid-debug Ctrl+S can route through SaveChanges (preserving
			// breakpoints).  When the token is reaped on debug end the
			// manager falls back to ⎕FIX.
			this.sendEvent('openTempTab', {
				filename: tmpFile,
				token: x.token,
				stops: x.stop ?? [],
			});
		}
		this._windows[x.token] = x;
		this._winId = x.token;
		const filename = Path.resolve(x.filename);
		this.sendEvent('openWindow', { filename });
		this.verifyBreakpoints(filename, x.stop);
	}
	private showHTML(x: ShowHTMLMessage) {
		this.sendEvent('openWebview', x);
	}
	private optionsDialog(x: OptionsDialogMessage) {
		// D.util.optionsDialog(x, (r) => {
		// D.send('ReplyOptionsDialog', { index: r, token: x.token });
		// });
	}
	private stringDialog(x: StringDialogMessage) {
		// D.util.stringDialog(x, (r) => {
		// D.send('ReplyStringDialog', { value: r, token: x.token });
		// });
	}
	private taskDialog(x: TaskDialogMessage) {
		this.sendEvent('taskDialog', x);
	}
	private replyClearTraceStopMonitor(x: ReplyClearTraceStopMonitorMessage) {
		// $.alert(`The following items were cleared:
		// ${x.traces} traces
		// ${x.stops} stops
		// ${x.monitors} monitors`, 'Clear all trace/stop/monitor');
	}
	/** Look up the temp file for a function name from open debug windows.
	 *  Stack descriptions use fully-qualified names (#.goo) while
	 *  OpenWindow.name is the local name (goo), so also match the
	 *  last component after the final dot.
	 */
	private _windowFile(name: string): string | undefined {
		const localName = name.includes('.') ? name.split('.').pop()! : name;
		for (const win of Object.values(this._windows)) {
			if (win.name === name || win.name === localName) {
				return Path.resolve(win.filename);
			}
		}
		return undefined;
	}

	private replyGetSIStack(x: ReplyGetSIStackMessage) {
		this.log('getSIStack');
		const frames: IStackFrame[] = x.stack.map((s, i) => {
			const { name, lineOffset } = parseStackDescription(s.description);
			const file = this._session?.linkedFileFor(name) || this._windowFile(name) || '';
			return {
				index: i,
				name,
				file: s.filename || file,
				line: s.fileline + lineOffset,
			};
		});
		this._siStack.resolve({
			frames,
			count: x.stack.length
		});
	}
	private replyGetThreads(x: ReplyGetThreadsMessage) {
		// const l = x.threads.length;
		// I.sb_threads.innerText = `&: ${l}`;
		// I.sb_threads.classList.toggle('active', l > 1);
		// ide.dbg && ide.dbg.threads.render(x.threads);
	}
	private interpreterStatus(x: InterpreterStatusMessage) {
		this.sendEvent('dyalogStatus', x);
	}
	private replyFormatCode(x: ReplyFormatCodeMessage) {
		// const w = D.wins[x.win];
		// w.ReplyFormatCode(x.text);
		// ide.hadErr > 0 && (ide.hadErr -= 1);
		// ide.focusWin(w);
	}
	private replyGetConfiguration(x: ReplyGetConfigurationMessage) {
		// x.configurations.forEach((c) => {
		// 	if (c.name === 'AUTO_PAUSE_THREADS') D.prf.pauseOnError(c.value === '1');
		// });
	}
	private replyTreeList(x: ReplyTreeListMessage) {
		this._treelist.resolve(x.nodeId, x);
	}
	private statusOutput(x: StatusOutputMessage) {
		this.sendEvent('output', x.text, undefined, 'stderr');
	}
	private replyGetLog(x: ReplyGetLogMessage) {
		this.add(x.result.join('\n'));
	}
	private unknownCommand(x: UnknownCommandMessage) {
	}

	/**
	 * Execute expression
	 */
	public execute(expr: string) {
		this.exec(0, expr);
	}

	/**
	 * Execute expression with tracing enabled (for stepping through)
	 */
	public executeWithTrace(expr: string) {
		this.exec(1, expr);
	}

	private _autocompletion = new PendingRequest<{ options: string[]; skip: number }>();
	/**
	 * Get autocomplete
	 */
	public getAutocomplete(line: string, pos: number, token: number): Promise<{ options: string[]; skip: number }> {
		const promise = this._autocompletion.create();
		this.send('GetAutocomplete', { line, pos, token });
		return promise;
	}

	private _siStack = new PendingRequest<IStack>();
	/**
	 * Get stack
	 */
	public getSIStack(): Promise<IStack> {
		if (this._siStack.pending) {
			return this._siStack.promise!;
		}
		const promise = this._siStack.create();
		this.send('GetSIStack', {});
		return promise;
	}

	/**
	 * Trace backward
	 */
	 public traceBackward() {
		this.send('TraceBackward', { win: this._winId });
	}

	/**
	 * Trace forward
	 */
	 public traceForward() {
		this.send('TraceForward', { win: this._winId });
	}

	/**
	 * Cutback
	 */
	public cutback() {
		this.send('Cutback', { win: this._winId });
	}

	/**
	 * Step Over
	 */
	public stepOver() {
		this.send('RunCurrentLine', { win: this._winId });
	}

	/**
	 * Reply to TaskDialog
	 */
	public replyTaskDialog(index: number, token: number) {
		this.send('ReplyTaskDialog', { index, token });
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue() {
		this.send('Continue', { win: this._winId });
	}

	/**
	 * Step to the next/previous line.
	 */
	public step() {
		this.send('RunCurrentLine', { win: this._winId });
	}

	/**
	 * Step into
	 */
	public stepIn(targetId: number | undefined) {
		this.send('StepInto', { win: this._winId });
	}
	
	/**
	 * Request resume execution of the current function, but stop on the next line of the calling function.
	 */
	public stepOut() {
		this.send('ContinueTrace', { win: this._winId });
	}

	/**
	 * Sync file changes to any open tracer window for that file.
	 * Sends SaveChanges via RIDE protocol to update the suspended function
	 * in the interpreter, enabling "edit and continue" during debugging.
	 */
	public syncFileToTracer(filePath: string): void {
		const normalizedPath = normPath(Path.resolve(filePath));

		for (const token of Object.keys(this._windows)) {
			const win = this._windows[+token];
			if (!win?.filename) continue;

			if (normPath(Path.resolve(win.filename)) !== normalizedPath) continue;

			try {
				let content = fs.readFileSync(filePath, 'utf-8');
				// Strip BOM if present
				if (content.charCodeAt(0) === 0xFEFF) {
					content = content.slice(1);
				}
				const lines = content.split(/\r?\n/);
				// Remove trailing empty line from final newline
				if (lines.length > 0 && lines[lines.length - 1] === '') {
					lines.pop();
				}

				let text: string[];
				const hasNabla = lines.some(l => /^\s*∇/.test(l));

				if (!hasNabla) {
					// Single-function file (.aplf) - entire file is the function
					text = lines;
				} else {
					// Multi-function file (.apln, .aplc) - extract function between ∇ boundaries
					let startIdx = -1;
					// Try linkInfo first for accurate start line
					const linkRow = this._session?.linkInfo.find(row =>
						normPath(row.filePath) === normalizedPath &&
						(row.aplName.endsWith(`.${win.name}`) || row.aplName === win.name)
					);
					if (linkRow) {
						startIdx = linkRow.startLine;
					} else {
						// Fallback: search for ∇ line containing the function name
						startIdx = lines.findIndex(l => {
							const m = l.match(/^\s*∇\s*(.*)/);
							return m && m[1].includes(win.name);
						});
					}
					if (startIdx === -1) continue;

					// Extract header from the ∇ line (strip leading whitespace and ∇)
					const header = lines[startIdx].replace(/^\s*∇\s*/, '');
					// Find the closing ∇
					let endIdx = startIdx + 1;
					while (endIdx < lines.length && !/^\s*∇\s*$/.test(lines[endIdx])) {
						endIdx++;
					}
					text = [header, ...lines.slice(startIdx + 1, endIdx)];
				}

				// Calculate line shift to adjust the interpreter's execution pointer
				const oldRow = win.currentRow ?? 0;
				let delta = 0;
				if (win.text && oldRow < win.text.length) {
					const tracedContent = win.text[oldRow];
					const lineDelta = text.length - win.text.length;
					if (lineDelta !== 0 && oldRow + lineDelta >= 0 && oldRow + lineDelta < text.length && text[oldRow + lineDelta] === tracedContent) {
						delta = lineDelta;
					}
				}

				this.log(`syncFileToTracer: sending SaveChanges for win ${token} (${win.name}), line delta ${delta}`);
				this.send('SaveChanges', {
					win: +token,
					text,
					stop: win.stop || [],
					trace: win.trace || [],
					monitor: win.monitor || [],
				});
				win.text = text;

				// Move the execution pointer to follow the traced line
				if (delta > 0) {
					for (let i = 0; i < delta; i++) {
						this.send('TraceForward', { win: +token });
					}
				} else if (delta < 0) {
					for (let i = 0; i < -delta; i++) {
						this.send('TraceBackward', { win: +token });
					}
				}
			} catch (e) {
				this.log(`syncFileToTracer error: ${e}`);
			}
		}
	}

	/**
	 * Get help on current pos
	 */
	public getHelpInformation(message: GetHelpInformationMessage) {
		this.send('GetHelpInformation', message);
	}

	private _valueTip = new PendingRequests<ValueTipMessage>();
	/**
	 * Get Value Tip
	 */
	public getValueTip(
		line: string,
		pos: number,
		token: number,
		win: number = 0,
		maxWidth: number = 200,
		maxHeight: number = 100): Promise<ValueTipMessage> {
		const promise = this._valueTip.create(token, 500);
		this.send('GetValueTip', { win, token, line, pos, maxWidth, maxHeight });
		return promise;
	}

	private _treelist = new PendingRequests<ReplyTreeListMessage>();
	/**
	 * Get tree list
	 */
	public getTreeList(nodeId: number): Promise<ReplyTreeListMessage> {
		const promise = this._treelist.create(nodeId);
		this.send('TreeList', { nodeId });
		return promise;
	}

	public getStepInTargets(frameId: number): IStepInTargets[] {
		return [];
	}

	public getBreakpoints(path: string, line: number): number[] {
		const filePath = normPath(path);
		let bps = this._breakPoints.get(filePath);
		if (bps && bps.some(bp => bp.line === line)) {
			return [0];
		}
		return [];
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<IAplBreakpoint> {

		const filePath = normPath(path);
		let bps = this._breakPoints.get(filePath);
		if (!bps) {
			bps = new Array<IAplBreakpoint>();
			this._breakPoints.set(filePath, bps);
		}
		let bp: IAplBreakpoint | undefined = bps.find(bp => bp.line === line);
		if (!bp) {
			bp = { verified: false, line, id: this._breakpointId++ };
			bps.push(bp);
		}
		await this.setBreakPointOnFile(bps, filePath);
		return bp;
	}

	private async setBreakPointOnFile(bps: IAplBreakpoint[], filePath: string): Promise<void> {
		const linkInfo = this._session?.linkInfo ?? [];
		if (linkInfo.length === 0) {
			return;
		}
		const { stops, matched } = mapBreakpointsToStops(
			bps.map(bp => ({ line: bp.line, bp })),
			filePath,
			linkInfo,
		);
		for (const aplName of Object.keys(stops)) {
			const lines = stops[aplName].join(' ');
			await this.exec(0, `{}${lines} ⎕STOP '${aplName}'`, 1);
		}
		for (const bp of matched) {
			bp.verified = true;
			this.sendEvent('breakpointValidated', bp);
		}
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): IAplBreakpoint | undefined {
		const bps = this._breakPoints.get(normPath(path));
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public async clearBreakpoints(path: string): Promise<void> {
		const filePath = normPath(path);
		this._breakPoints.delete(filePath);
		// Clear stops on ALL functions in this file, not just one
		for (const row of this._session?.linkInfo ?? []) {
			if (normPath(row.filePath) === filePath) {
				await this.exec(0, `{}⍬ ⎕STOP '${row.aplName}'`, 1);
			}
		}
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}

	// private methods

	private async verifyBreakpoints(path: string, lines: number[]): Promise<void> {

		if (this._noDebug) {
			return;
		}

		const bps = this._breakPoints.get(normPath(path));
		if (bps) {
			bps.forEach(bp => {
				if (!bp.verified && lines.includes(bp.line)) {
					bp.verified = true;
					this.sendEvent('breakpointValidated', bp);
				}
			});
		}
	}

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}