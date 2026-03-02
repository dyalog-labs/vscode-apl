import * as vscode from 'vscode';
import { AplSession, ConnectionState } from './aplSession';

/**
 * Provider for the APL REPL webview panel in the bottom panel area.
 */
export class ReplViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'aplRepl';

	private _view?: vscode.WebviewView;
	private _outputHistory: Array<{ type: string; text: string }> = [];
	private _inputHistory: string[] = [];
	private _session: AplSession;
	private _disposables: vscode.Disposable[] = [];
	private _debugSession?: vscode.DebugSession;
	private _isDebugMode = false;
	private _context: vscode.ExtensionContext;

	private static readonly HISTORY_KEY = 'apl.repl.inputHistory';
	private static readonly MAX_HISTORY = 500;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		context: vscode.ExtensionContext,
	) {
		this._context = context;
		this._inputHistory = context.globalState.get<string[]>(ReplViewProvider.HISTORY_KEY, []);
		this._session = AplSession.getInstance();
		this._setupSessionListeners();
		this._setupDebugListeners();
	}

	private _setupSessionListeners(): void {
		// Listen for session state changes
		this._session.on('stateChanged', (state: ConnectionState) => {
			this._updateStatus(state);
		});

		// Listen for session output
		this._session.on('output', (text: string, type: string) => {
			this._appendOutput(type, text);
		});

		// Listen for echo (input acknowledgement)
		this._session.on('echo', (_input: string) => {
			// Input is already shown, echo confirms execution started
		});

		// Listen for end event
		this._session.on('end', () => {
			this._appendOutput('system', 'Session ended.');
		});

		// Listen for errors
		this._session.on('error', (error: Error) => {
			this._appendOutput('error', `Error: ${error.message}`);
		});

		// Listen for autocomplete results
		this._session.on('autocomplete', (options: string[], token: number) => {
			this._view?.webview.postMessage({
				command: 'autocomplete',
				options,
				token
			});
		});

		// Listen for HTML output
		this._session.on('showHtml', (args: { title: string; html: string }) => {
			this._handleShowHtml(args.title, args.html);
		});

		// Listen for interpreter suspension (untrapped error in standalone mode)
		this._session.on('suspended', () => {
			this._handleAutoDebug();
		});
	}

	private _setupDebugListeners(): void {
		// Register debug adapter tracker to capture output
		this._disposables.push(
			vscode.debug.registerDebugAdapterTrackerFactory('apl', {
				createDebugAdapterTracker: (_session) => {
					return {
						onDidSendMessage: (message: any) => {
							// Capture output events from the debug adapter
							if (message.type === 'event' && message.event === 'output') {
								const body = message.body;
								if (body && body.output) {
									const category = body.category || 'stdout';
									const type = category === 'stderr' ? 'error' : 'result';
									// Don't duplicate input echo
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

		// Listen for debug session start
		this._disposables.push(
			vscode.debug.onDidStartDebugSession((session) => {
				if (session.type === 'apl') {
					this._debugSession = session;
					// Only set debug mode if not a noDebug run
					const isNoDebug = (session.configuration as any).noDebug === true;
					if (!isNoDebug) {
						this._isDebugMode = true;
						this._updateDebugMode(true);
					}
					// Focus the REPL panel instead of Debug Console
					this._view?.show(false);
				}
			})
		);

		// Listen for debug session end
		this._disposables.push(
			vscode.debug.onDidTerminateDebugSession((session) => {
				if (session.type === 'apl' && this._debugSession?.id === session.id) {
					this._debugSession = undefined;
					this._isDebugMode = false;
					this._updateDebugMode(false);
				}
			})
		);

		// Check if there's already an active debug session
		const activeSession = vscode.debug.activeDebugSession;
		if (activeSession?.type === 'apl') {
			this._debugSession = activeSession;
			const isNoDebug = (activeSession.configuration as any).noDebug === true;
			this._isDebugMode = !isNoDebug;
		}
	}

	/**
	 * Update webview with debug mode state
	 */
	private _updateDebugMode(isDebug: boolean): void {
		this._view?.webview.postMessage({
			command: 'setDebugMode',
			isDebug
		});
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'media')
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(message => {
			switch (message.command) {
				case 'execute':
					this._handleExecute(message.code);
					return;
				case 'executeWithTrace':
					this._handleExecuteWithTrace(message.code);
					return;
				case 'requestHistory':
					this._sendHistory();
					this._updateStatus(this._session.state);
					return;
				case 'clear':
					this._outputHistory = [];
					return;
				case 'connect':
					this._handleConnect();
					return;
				case 'interrupt':
					this._handleInterrupt();
					return;
				case 'autocomplete':
					this._handleAutocomplete(message.line, message.pos, message.token);
					return;
				case 'valuetip':
					this._handleValueTip(message.expression);
					return;
				case 'navigateToError':
					this._handleNavigateToError(message.name, message.line);
					return;
			}
		});

		// Restore output history when view becomes visible
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this._sendHistory();
				this._updateStatus(this._session.state);
			}
		});

		// Send initial history and status
		if (this._outputHistory.length > 0) {
			this._sendHistory();
		}
		this._updateStatus(this._session.state);

		// Send initial debug mode state
		this._updateDebugMode(this._isDebugMode);

		// No auto-connect — the user clicks the Connect button when ready
	}

	/**
	 * Handle connect request
	 */
	private async _handleConnect(): Promise<void> {
		if (this._session.isConnected) {
			return;
		}

		const config = vscode.workspace.getConfiguration('apl');
		const timing = config.get<string>('connectionTiming') || 'onDemand';

		try {
			if (timing === 'never') {
				// Connect to existing RIDE
				await this._session.connect();
			} else {
				// Spawn new interpreter
				await this._session.spawn();
			}
		} catch (error: any) {
			this._appendOutput('error', `Failed to connect: ${error.message}`);
		}
	}

	/**
	 * Handle code execution request from webview
	 */
	private async _handleExecute(code: string): Promise<void> {
		if (!code.trim()) {
			return;
		}

		// Add to input history and persist
		this._inputHistory.push(code);
		this._saveInputHistory();

		// Echo the input with 6-space indent (like APL session)
		this._appendOutput('input', `      ${code}`);

		// Check for special REPL commands
		if (code.startsWith('/')) {
			await this._handleSpecialCommand(code);
			return;
		}

		// If in debug mode, use the debug session
		if (this._isDebugMode && this._debugSession) {
			try {
				// Use the debug adapter's evaluate request for REPL context
				await this._debugSession.customRequest('evaluate', {
					expression: code,
					context: 'repl'
				});
			} catch (error: any) {
				this._appendOutput('error', `Debug execution error: ${error.message}`);
			}
			return;
		}

		// Standalone mode: must be connected
		if (!this._session.isConnected) {
			this._appendOutput('error', '[Not connected — click Connect to start an interpreter]');
			return;
		}

		// Execute via standalone session
		this._session.execute(code);
	}

	/**
	 * Handle code execution with tracing (Ctrl+Enter)
	 */
	private async _handleExecuteWithTrace(code: string): Promise<void> {
		if (!code.trim()) {
			return;
		}

		// Add to input history and persist
		this._inputHistory.push(code);
		this._saveInputHistory();

		// Echo the input with 6-space indent
		this._appendOutput('input', `      ${code}`);

		// If already in debug mode, execute with trace via debug session
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

		// Not in debug mode - start a debug session attached to REPL
		if (!this._session.isConnected) {
			this._appendOutput('error', '[Not connected — click Connect to start an interpreter]');
			return;
		}

		// Get workspace folder for debug session
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const cwd = workspaceFolders?.[0]?.uri.fsPath || '';

		// Start debug session (will attach to existing REPL session)
		const started = await vscode.debug.startDebugging(
			workspaceFolders?.[0],
			{
				type: 'apl',
				name: 'Trace Expression',
				request: 'launch',
				program: '',  // No program file - just trace expression
				cwd: cwd,
				stopOnEntry: false,
				noDebug: false,
				traceExpression: code  // Custom: expression to trace
			}
		);

		if (!started) {
			this._appendOutput('error', 'Failed to start debug session');
		}
	}

	/**
	 * Auto-start debug session when interpreter enters suspended state
	 * due to an untrapped error in standalone mode.
	 */
	private async _handleAutoDebug(): Promise<void> {
		// Don't auto-debug if already in debug mode
		if (this._isDebugMode) {
			return;
		}

		if (!this._session.isConnected) {
			return;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		const cwd = workspaceFolders?.[0]?.uri.fsPath || '';

		const started = await vscode.debug.startDebugging(
			workspaceFolders?.[0],
			{
				type: 'apl',
				name: 'Error Debug',
				request: 'launch',
				program: '',
				cwd: cwd,
				stopOnEntry: false,
				noDebug: false,
				replSuspended: true
			}
		);

		if (!started) {
			this._appendOutput('system', 'Auto-debug: failed to start debug session');
		}
	}

	/**
	 * Handle special REPL commands (starting with /)
	 */
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
				// Check for commands with arguments
				if (cmd.startsWith('/link')) {
					await this._handleLink(code);
				} else {
					this._appendOutput('error', `Unknown command: ${code}`);
					this._appendOutput('system', 'Type /help for available commands.');
				}
				break;
		}
	}

	/**
	 * Show stack trace (during debug)
	 */
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

	/**
	 * Show variables (during debug)
	 */
	private async _showVariables(): Promise<void> {
		if (!this._isDebugMode || !this._debugSession) {
			this._appendOutput('system', 'Variables view is only available during debugging.');
			this._appendOutput('system', 'Use )VARS in APL to see workspace variables.');
			return;
		}

		try {
			// Get scopes first
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

	/**
	 * Show debug status
	 */
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

	/**
	 * Show REPL help
	 */
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

	/**
	 * Handle disconnect
	 */
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

	/**
	 * Handle link command - links workspace folder to APL namespace
	 */
	private async _handleLink(code: string): Promise<void> {
		// Parse namespace from command: /link [namespace]
		const parts = code.trim().split(/\s+/);
		const namespace = parts[1] || '#';

		// Get workspace folder
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
	}

	/**
	 * Handle interrupt request
	 */
	private _handleInterrupt(): void {
		this._session.interrupt();
	}

	/**
	 * Handle autocomplete request from webview
	 */
	private _handleAutocomplete(line: string, pos: number, token: number): void {
		if (this._session.isConnected) {
			this._session.getAutocomplete(line, pos, token);
		}
	}

	/**
	 * Handle value tip request from webview
	 */
	private async _handleValueTip(expression: string): Promise<void> {
		if (!expression) return;
		// Value tips only available in debug mode (safe evaluate with hover context)
		if (!this._isDebugMode || !this._debugSession) return;

		try {
			const response = await this._debugSession.customRequest('evaluate', {
				expression,
				context: 'hover'
			});
			if (response?.result) {
				this._view?.webview.postMessage({
					command: 'valuetip',
					expression,
					value: response.result
				});
			}
		} catch {
			// Silently ignore hover errors
		}
	}

	/**
	 * Handle click on error location — navigate to source file
	 */
	private async _handleNavigateToError(name: string, line: number): Promise<void> {
		// Extract base name (last component after dots, e.g. #.ns.foo → foo)
		const baseName = name.includes('.') ? name.split('.').pop()! : name;

		// Search for the function file in workspace
		const pattern = `**/${baseName}.{aplf,aplo,apln,aplc,aplci}`;
		const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);

		if (files.length > 0) {
			// If multiple matches and name has namespace path, prefer matching path
			let targetFile = files[0];
			if (files.length > 1 && name.includes('.')) {
				const nsParts = name.split('.');
				nsParts.pop(); // remove function name
				// Filter out root namespace '#' and build expected directory suffix
				const nsDirs = nsParts.filter(p => p !== '#');
				if (nsDirs.length > 0) {
					const suffix = '/' + nsDirs.join('/') + '/' + baseName + '.';
					const match = files.find(f => f.fsPath.replace(/\\/g, '/').includes(suffix));
					if (match) { targetFile = match; }
				}
			}

			const doc = await vscode.workspace.openTextDocument(targetFile);
			const editor = await vscode.window.showTextDocument(doc, {
				preview: true,
				preserveFocus: false
			});

			// APL line numbers map directly to file line numbers (0-indexed)
			const targetLine = Math.min(line, doc.lineCount - 1);
			const position = new vscode.Position(targetLine, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(
				new vscode.Range(position, position),
				vscode.TextEditorRevealType.InCenter
			);
		} else {
			vscode.window.showWarningMessage(`Could not find source for: ${name}`);
		}
	}

	/**
	 * Handle ShowHTML from interpreter — open in separate webview panel
	 */
	private _handleShowHtml(title: string, html: string): void {
		// Notify REPL output
		this._appendOutput('system', `HTML output: ${title}`);
		this._view?.webview.postMessage({ command: 'showHtml', title });

		// Open in a separate webview panel
		const panel = vscode.window.createWebviewPanel(
			'aplHtmlOutput',
			title || 'APL HTML Output',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true }
		);
		panel.webview.html = html;
	}

	/**
	 * Update connection status in webview
	 */
	private _updateStatus(state: ConnectionState): void {
		this._view?.webview.postMessage({
			command: 'setStatus',
			status: state
		});
	}

	/**
	 * Append output to history and send to webview
	 */
	private _appendOutput(type: string, text: string): void {
		this._outputHistory.push({ type, text });
		this._view?.webview.postMessage({
			command: 'appendOutput',
			type,
			text
		});
	}

	/**
	 * Send full output history to webview (used when view becomes visible)
	 */
	private _sendHistory(): void {
		this._view?.webview.postMessage({
			command: 'setHistory',
			history: this._outputHistory,
			inputHistory: this._inputHistory
		});
	}

	/**
	 * Persist input history to globalState
	 */
	private _saveInputHistory(): void {
		// Trim to max size
		if (this._inputHistory.length > ReplViewProvider.MAX_HISTORY) {
			this._inputHistory = this._inputHistory.slice(-ReplViewProvider.MAX_HISTORY);
		}
		this._context.globalState.update(ReplViewProvider.HISTORY_KEY, this._inputHistory);
	}

	/**
	 * Clear the REPL output
	 */
	public clear(): void {
		this._outputHistory = [];
		this._view?.webview.postMessage({ command: 'clear' });
	}

	/**
	 * Interrupt execution
	 */
	public interrupt(): void {
		this._session.interrupt();
	}

	/**
	 * Disconnect the session
	 */
	public disconnect(): void {
		this._session.disconnect();
	}

	/**
	 * Get the session (for sharing with debug adapter)
	 */
	public get session(): AplSession {
		return this._session;
	}

	/**
	 * Dispose resources
	 */
	public dispose(): void {
		this._session.disconnect();
		this._disposables.forEach(d => d.dispose());
	}

	/**
	 * Get the HTML content for the webview
	 */
	private _getHtmlForWebview(webview: vscode.Webview): string {
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'repl.css')
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'repl.js')
		);

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>APL REPL</title>
</head>
<body>
	<div id="repl-container">
		<div id="toolbar">
			<span id="status" class="disconnected">Disconnected</span>
			<span id="debug-indicator">DEBUG</span>
			<button id="connect-btn" title="Connect to interpreter">Connect</button>
			<button id="clear-btn" title="Clear output">Clear</button>
			<button id="interrupt-btn" title="Interrupt execution" disabled>Interrupt</button>
		</div>
		<div id="output"></div>
		<div id="input-area">
			<span id="prompt">&#x2395;</span>
			<textarea id="input" rows="1" placeholder="Enter APL expression..." spellcheck="false"></textarea>
		</div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

/**
 * Generate a nonce for Content Security Policy
 */
function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
