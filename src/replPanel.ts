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

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) {
		this._session = AplSession.getInstance();
		this._setupSessionListeners();
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

		// Listen for ready event
		this._session.on('ready', () => {
			this._appendOutput('system', 'APL session ready.');
		});

		// Listen for end event
		this._session.on('end', () => {
			this._appendOutput('system', 'Session ended.');
		});

		// Listen for errors
		this._session.on('error', (error: Error) => {
			this._appendOutput('error', `Error: ${error.message}`);
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

		// Auto-connect based on setting
		this._autoConnect();
	}

	/**
	 * Auto-connect based on connectionTiming setting
	 */
	private async _autoConnect(): Promise<void> {
		const config = vscode.workspace.getConfiguration('apl');
		const timing = config.get<string>('connectionTiming') || 'onDemand';

		if (timing === 'onDemand' && !this._session.isConnected) {
			await this._handleConnect();
		}
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
			this._appendOutput('system', 'Connecting to interpreter...');

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

		// Add to input history
		this._inputHistory.push(code);

		// Echo the input with 6-space indent (like APL session)
		this._appendOutput('input', `      ${code}`);

		// Ensure connected
		if (!this._session.isConnected) {
			await this._handleConnect();
			if (!this._session.isConnected) {
				this._appendOutput('error', '[Not connected to interpreter]');
				return;
			}
		}

		// Execute
		this._session.execute(code);
	}

	/**
	 * Handle interrupt request
	 */
	private _handleInterrupt(): void {
		this._session.interrupt();
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
