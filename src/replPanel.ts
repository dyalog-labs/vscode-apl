import * as vscode from 'vscode';

/**
 * Provider for the APL REPL webview panel in the bottom panel area.
 */
export class ReplViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'aplRepl';

	private _view?: vscode.WebviewView;
	private _outputHistory: Array<{ type: string; text: string }> = [];
	private _inputHistory: string[] = [];

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

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
					return;
				case 'clear':
					this._outputHistory = [];
					return;
			}
		});

		// Restore output history when view becomes visible
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this._sendHistory();
			}
		});

		// Send initial history if we have any
		if (this._outputHistory.length > 0) {
			this._sendHistory();
		}
	}

	/**
	 * Handle code execution request from webview
	 */
	private _handleExecute(code: string) {
		if (!code.trim()) {
			return;
		}

		// Add to input history
		this._inputHistory.push(code);

		// Echo the input
		this._appendOutput('input', `      ${code}`);

		// TODO: Phase 2 - Connect to APL runtime and execute
		// For now, show a placeholder message
		this._appendOutput('system', '[REPL not connected - Phase 2 will add interpreter connection]');
	}

	/**
	 * Append output to history and send to webview
	 */
	private _appendOutput(type: string, text: string) {
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
	private _sendHistory() {
		this._view?.webview.postMessage({
			command: 'setHistory',
			history: this._outputHistory,
			inputHistory: this._inputHistory
		});
	}

	/**
	 * Clear the REPL output
	 */
	public clear() {
		this._outputHistory = [];
		this._view?.webview.postMessage({ command: 'clear' });
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
