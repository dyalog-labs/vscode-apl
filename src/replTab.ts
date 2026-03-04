import * as vscode from 'vscode';
import { AplSession, ConnectionState } from './aplSession';
import { ReplManager } from './replManager';
import { ReplBreakpointSync } from './replBreakpointSync';

/**
 * A single REPL tab: owns an AplSession and accumulates output history.
 * Does NOT own a webview — the shared ReplViewProvider renders the active tab.
 * When this tab is active, _postMessage is set so events forward to the webview.
 */
export class ReplTab implements vscode.Disposable {

	public readonly replId: string;
	public readonly label: string;
	private _session: AplSession;
	private _manager: ReplManager;

	private _outputHistory: Array<{ type: string; text: string }> = [];
	private _disposables: vscode.Disposable[] = [];
	private _debugSession?: vscode.DebugSession;
	private _isDebugMode = false;
	private _breakpointSync = new ReplBreakpointSync();

	/** Set by the view provider when this tab is active; undefined when background. */
	private _postMessage?: (message: any) => void;

	constructor(
		replId: string,
		label: string,
		session: AplSession,
		manager: ReplManager,
	) {
		this.replId = replId;
		this.label = label;
		this._session = session;
		this._manager = manager;

		this._setupSessionListeners();
		this._setupDebugListeners();
	}

	public get session(): AplSession {
		return this._session;
	}

	public get outputHistory(): ReadonlyArray<{ type: string; text: string }> {
		return this._outputHistory;
	}

	public get isDebugMode(): boolean {
		return this._isDebugMode;
	}

	public get connectionState(): ConnectionState {
		return this._session.state;
	}

	/** Called by the view provider when this tab becomes active. */
	public activate(postMessage: (message: any) => void): void {
		this._postMessage = postMessage;
	}

	/** Called by the view provider when this tab becomes inactive. */
	public deactivate(): void {
		this._postMessage = undefined;
	}

	// --- Session listeners (always active, even when background tab) ---

	private _setupSessionListeners(): void {
		this._session.on('stateChanged', (state: ConnectionState) => {
			this._postMessage?.({ command: 'setStatus', status: state });
		});

		this._session.on('ready', () => {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.replace(/\\/g, '/');
			if (folder) {
				this._breakpointSync.attachToSession(this._session, folder);
			}
		});

		this._session.on('output', (text: string, type: string) => {
			this._appendOutput(type, text);
		});

		this._session.on('echo', (_input: string) => {
			// Input is already shown, echo confirms execution started
		});

		this._session.on('end', () => {
			this._breakpointSync.detachFromSession();
			this._appendOutput('system', 'Session ended.');
		});

		this._session.on('error', (error: Error) => {
			this._appendOutput('error', `Error: ${error.message}`);
		});

		this._session.on('autocomplete', (options: string[], token: number) => {
			this._postMessage?.({ command: 'autocomplete', options, token });
		});

		this._session.on('showHtml', (args: { title: string; html: string }) => {
			this._handleShowHtml(args.title, args.html);
		});

		this._session.on('suspended', () => {
			this._handleAutoDebug();
		});
	}

	private _setupDebugListeners(): void {
		this._disposables.push(
			vscode.debug.registerDebugAdapterTrackerFactory('apl', {
				createDebugAdapterTracker: (session) => {
					if (!this._matchesDebugSession(session)) {
						return undefined;
					}
					return {
						onDidSendMessage: (message: any) => {
							if (message.type === 'event' && message.event === 'output') {
								const body = message.body;
								if (body && body.output) {
									const category = body.category || 'stdout';
									const type = category === 'stderr' ? 'error' : 'result';
									if (!body.output.startsWith('      ')) {
										this._appendOutput(type, body.output.trimEnd());
									}
								}
							}
						}
					};
				}
			})
		);

		this._disposables.push(
			vscode.debug.onDidStartDebugSession((session) => {
				if (session.type === 'apl' && this._matchesDebugSession(session)) {
					this._debugSession = session;
					const isNoDebug = (session.configuration as any).noDebug === true;
					if (!isNoDebug) {
						this._isDebugMode = true;
						this._postMessage?.({ command: 'setDebugMode', isDebug: true });
					}
				}
			})
		);

		this._disposables.push(
			vscode.debug.onDidTerminateDebugSession((session) => {
				if (session.type === 'apl' && this._debugSession?.id === session.id) {
					this._debugSession = undefined;
					this._isDebugMode = false;
					this._postMessage?.({ command: 'setDebugMode', isDebug: false });
				}
			})
		);

		// Check if there's already an active debug session for us
		const activeSession = vscode.debug.activeDebugSession;
		if (activeSession?.type === 'apl') {
			const configReplId = (activeSession.configuration as any).replId;
			if (configReplId === this.replId) {
				this._debugSession = activeSession;
				const isNoDebug = (activeSession.configuration as any).noDebug === true;
				this._isDebugMode = !isNoDebug;
			}
		}
	}

	private _matchesDebugSession(session: vscode.DebugSession): boolean {
		const configReplId = (session.configuration as any).replId;
		if (configReplId) {
			return configReplId === this.replId;
		}
		return this._manager.activeReplId === this.replId;
	}

	// --- Actions (called by the view provider in response to webview messages) ---

	public async handleConnect(): Promise<void> {
		if (this._session.isConnected) {
			return;
		}

		const config = vscode.workspace.getConfiguration('apl');
		const timing = config.get<string>('connectionTiming') || 'onDemand';

		try {
			if (timing === 'never') {
				await this._session.connect();
			} else {
				await this._session.spawn();
			}
		} catch (error: any) {
			this._appendOutput('error', `Failed to connect: ${error.message}`);
		}
	}

	public async handleExecute(code: string): Promise<void> {
		if (!code.trim()) {
			return;
		}

		this._manager.addToHistory(code);
		this._appendOutput('input', `      ${code}`);

		if (code.startsWith('/')) {
			await this._handleSpecialCommand(code);
			return;
		}

		if (this._isDebugMode && this._debugSession) {
			try {
				await this._debugSession.customRequest('evaluate', {
					expression: code,
					context: 'repl'
				});
			} catch (error: any) {
				this._appendOutput('error', `Debug execution error: ${error.message}`);
			}
			return;
		}

		if (!this._session.isConnected) {
			this._appendOutput('error', '[Not connected — click Connect to start an interpreter]');
			return;
		}

		this._session.execute(code);
	}

	public async handleExecuteWithTrace(code: string): Promise<void> {
		if (!code.trim()) {
			return;
		}

		this._manager.addToHistory(code);
		this._appendOutput('input', `      ${code}`);

		if (this._isDebugMode && this._debugSession) {
			try {
				await this._debugSession.customRequest('executeWithTrace', {
					expression: code
				});
			} catch (error: any) {
				this._appendOutput('error', `Debug execution error: ${error.message}`);
			}
			return;
		}

		if (!this._session.isConnected) {
			this._appendOutput('error', '[Not connected — click Connect to start an interpreter]');
			return;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		const cwd = workspaceFolders?.[0]?.uri.fsPath || '';

		const started = await vscode.debug.startDebugging(
			workspaceFolders?.[0],
			{
				type: 'apl',
				name: this.label,
				request: 'launch',
				program: '',
				cwd: cwd,
				stopOnEntry: false,
				noDebug: false,
				traceExpression: code,
				replId: this.replId,
				internalConsoleOptions: 'neverOpen'
			}
		);

		if (!started) {
			this._appendOutput('error', 'Failed to start debug session');
		}
	}

	public handleInterrupt(): void {
		this._session.interrupt();
	}

	public handleAutocomplete(line: string, pos: number, token: number): void {
		if (this._session.isConnected) {
			this._session.getAutocomplete(line, pos, token);
		}
	}

	public async handleValueTip(expression: string): Promise<void> {
		if (!expression) return;
		if (!this._isDebugMode || !this._debugSession) return;

		try {
			const response = await this._debugSession.customRequest('evaluate', {
				expression,
				context: 'hover'
			});
			if (response?.result) {
				this._postMessage?.({
					command: 'valuetip',
					expression,
					value: response.result
				});
			}
		} catch {
			// Silently ignore hover errors
		}
	}

	public async handleNavigateToError(name: string, line: number): Promise<void> {
		const found = await openAplDefinition(name, line);
		if (!found) {
			vscode.window.showWarningMessage(`Could not find source for: ${name}`);
		}
	}

	public async handleGoToDefinition(name: string): Promise<void> {
		await openAplDefinition(name);
	}

	public clear(): void {
		this._outputHistory = [];
		this._postMessage?.({ command: 'clear' });
	}

	public interrupt(): void {
		this._session.interrupt();
	}

	public disconnect(): void {
		this._session.disconnect();
	}

	// --- Private helpers ---

	private _appendOutput(type: string, text: string): void {
		this._outputHistory.push({ type, text });
		this._postMessage?.({ command: 'appendOutput', type, text });
	}

	private async _handleAutoDebug(): Promise<void> {
		if (this._isDebugMode) {
			return;
		}

		if (!this._session.isConnected) {
			return;
		}

		// Switch to this tab before starting debug
		this._manager.switchToTab(this.replId);

		const workspaceFolders = vscode.workspace.workspaceFolders;
		const cwd = workspaceFolders?.[0]?.uri.fsPath || '';

		const started = await vscode.debug.startDebugging(
			workspaceFolders?.[0],
			{
				type: 'apl',
				name: this.label,
				request: 'launch',
				program: '',
				cwd: cwd,
				stopOnEntry: false,
				noDebug: false,
				replSuspended: true,
				replId: this.replId,
				internalConsoleOptions: 'neverOpen'
			}
		);

		if (!started) {
			this._appendOutput('system', 'Auto-debug: failed to start debug session');
		}
	}

	private async _handleSpecialCommand(code: string): Promise<void> {
		const cmd = code.toLowerCase().trim();

		switch (cmd) {
			case '/bt':
			case '/backtrace':
			case '/si':
				await this._showStackTrace();
				break;

			case '/vars':
			case '/variables':
				await this._showVariables();
				break;

			case '/debug':
			case '/status':
				this._showDebugStatus();
				break;

			case '/help':
				this._showReplHelp();
				break;

			case '/disconnect':
				this._handleDisconnect();
				break;

			default:
				if (cmd.startsWith('/link')) {
					await this._handleLink(code);
				} else {
					this._appendOutput('error', `Unknown command: ${code}`);
					this._appendOutput('system', 'Type /help for available commands.');
				}
				break;
		}
	}

	private async _showStackTrace(): Promise<void> {
		if (!this._isDebugMode || !this._debugSession) {
			this._appendOutput('system', 'Stack trace is only available during debugging.');
			this._appendOutput('system', 'Use )SI in APL to see the state indicator.');
			return;
		}

		try {
			const response = await this._debugSession.customRequest('stackTrace', {
				threadId: 1,
				startFrame: 0,
				levels: 20
			});

			if (response.stackFrames && response.stackFrames.length > 0) {
				this._appendOutput('system', '=== Stack Trace ===');
				response.stackFrames.forEach((frame: any, index: number) => {
					const location = frame.source?.name
						? `${frame.source.name}:${frame.line}`
						: `line ${frame.line}`;
					this._appendOutput('result', `[${index}] ${frame.name} (${location})`);
				});
			} else {
				this._appendOutput('system', 'No active stack frames.');
			}
		} catch (error: any) {
			this._appendOutput('error', `Failed to get stack trace: ${error.message}`);
		}
	}

	private async _showVariables(): Promise<void> {
		if (!this._isDebugMode || !this._debugSession) {
			this._appendOutput('system', 'Variables view is only available during debugging.');
			this._appendOutput('system', 'Use )VARS in APL to see workspace variables.');
			return;
		}

		try {
			const scopesResponse = await this._debugSession.customRequest('scopes', {
				frameId: 0
			});

			if (scopesResponse.scopes && scopesResponse.scopes.length > 0) {
				this._appendOutput('system', '=== Variables ===');

				for (const scope of scopesResponse.scopes) {
					this._appendOutput('system', `--- ${scope.name} ---`);

					const varsResponse = await this._debugSession.customRequest('variables', {
						variablesReference: scope.variablesReference
					});

					if (varsResponse.variables && varsResponse.variables.length > 0) {
						varsResponse.variables.forEach((v: any) => {
							const value = v.value.length > 50
								? v.value.substring(0, 47) + '...'
								: v.value;
							this._appendOutput('result', `  ${v.name}: ${value}`);
						});
					} else {
						this._appendOutput('result', '  (no variables)');
					}
				}
			}
		} catch (error: any) {
			this._appendOutput('error', `Failed to get variables: ${error.message}`);
		}
	}

	private _showDebugStatus(): void {
		if (this._isDebugMode && this._debugSession) {
			this._appendOutput('system', `Debug mode: ACTIVE`);
			this._appendOutput('system', `Session: ${this._debugSession.name}`);
			this._appendOutput('system', 'REPL commands are executed in debug context.');
		} else {
			this._appendOutput('system', `Debug mode: INACTIVE`);
			this._appendOutput('system', `Standalone session: ${this._session.isConnected ? 'Connected' : 'Disconnected'}`);
		}
	}

	private _showReplHelp(): void {
		this._appendOutput('system', '=== APL REPL Commands ===');
		this._appendOutput('result', '/link [ns]    - Link workspace folder to namespace (default: #)');
		this._appendOutput('result', '/bt, /si      - Show stack trace (debug mode)');
		this._appendOutput('result', '/vars         - Show variables (debug mode)');
		this._appendOutput('result', '/status       - Show connection/debug status');
		this._appendOutput('result', '/disconnect   - Disconnect from interpreter');
		this._appendOutput('result', '/help         - Show this help');
		this._appendOutput('system', '');
		this._appendOutput('system', 'APL system commands:');
		this._appendOutput('result', ')SI           - State indicator');
		this._appendOutput('result', ')VARS         - Workspace variables');
		this._appendOutput('result', ')FNS          - User functions');
		this._appendOutput('result', ')CLEAR        - Clear workspace');
	}

	private _handleDisconnect(): void {
		if (this._isDebugMode) {
			this._appendOutput('system', 'Cannot disconnect during debug session.');
			this._appendOutput('system', 'Stop the debug session first.');
			return;
		}

		if (this._session.isConnected) {
			this._session.disconnect();
			this._appendOutput('system', 'Disconnected from interpreter.');
		} else {
			this._appendOutput('system', 'Not connected.');
		}
	}

	private async _handleLink(code: string): Promise<void> {
		const parts = code.trim().split(/\s+/);
		const namespace = parts[1] || '#';

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			this._appendOutput('error', 'No workspace folder open.');
			return;
		}

		const folderPath = workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
		const linkCmd = `⎕SE.Link.Create '${namespace}' '${folderPath}'`;

		this._appendOutput('input', linkCmd);

		if (this._isDebugMode && this._debugSession) {
			try {
				await this._debugSession.customRequest('evaluate', {
					expression: linkCmd,
					context: 'repl'
				});
			} catch (error: any) {
				this._appendOutput('error', `Link failed: ${error.message}`);
			}
		} else if (this._session.isConnected) {
			this._session.execute(linkCmd);
		} else {
			this._appendOutput('error', 'Not connected to interpreter.');
		}

		// Refresh breakpoint sync link info after linking
		this._breakpointSync.refreshLinkInfo();
	}

	private _handleShowHtml(title: string, html: string): void {
		this._appendOutput('system', `HTML output: ${title}`);
		this._postMessage?.({ command: 'showHtml', title });

		const htmlPanel = vscode.window.createWebviewPanel(
			'aplHtmlOutput',
			title || 'APL HTML Output',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true }
		);

		// Inject a strict CSP: allow inline scripts/styles for interpreter
		// content but block all network access to prevent exfiltration.
		const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;`;
		const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
		const safeHtml = html.includes('<head>')
			? html.replace('<head>', `<head>${cspTag}`)
			: `<!DOCTYPE html><html><head>${cspTag}</head><body>${html}</body></html>`;

		htmlPanel.webview.html = safeHtml;
	}

	public dispose(): void {
		this._breakpointSync.dispose();
		this._session.disconnect();
		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}

/**
 * Search the workspace for an APL source file matching the given name and open it.
 * Returns true if a file was found and opened, false otherwise.
 */
export async function openAplDefinition(name: string, line: number = 0): Promise<boolean> {
	const baseName = name.includes('.') ? name.split('.').pop()! : name;

	const pattern = `**/${baseName}.{aplf,aplo,apln,aplc,aplci}`;
	const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);

	if (files.length === 0) { return false; }

	let targetFile = files[0];
	if (files.length > 1) {
		let matched = false;
		if (name.includes('.')) {
			const nsParts = name.split('.');
			nsParts.pop();
			const nsDirs = nsParts.filter(p => p !== '#');
			if (nsDirs.length > 0) {
				const suffix = '/' + nsDirs.join('/') + '/' + baseName + '.';
				const match = files.find(f => f.fsPath.replace(/\\/g, '/').includes(suffix));
				if (match) { targetFile = match; matched = true; }
			}
		}
		if (!matched) {
			targetFile = files.reduce((best, f) => {
				const bestDepth = vscode.workspace.asRelativePath(best, false).split(/[/\\]/).length;
				const fDepth = vscode.workspace.asRelativePath(f, false).split(/[/\\]/).length;
				return fDepth < bestDepth ? f : best;
			});
		}
	}

	const doc = await vscode.workspace.openTextDocument(targetFile);
	const editor = await vscode.window.showTextDocument(doc, {
		preview: true,
		preserveFocus: false
	});

	const targetLine = Math.min(line, doc.lineCount - 1);
	const position = new vscode.Position(targetLine, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(
		new vscode.Range(position, position),
		vscode.TextEditorRevealType.InCenter
	);
	return true;
}
