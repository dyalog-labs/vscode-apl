import * as vscode from 'vscode';
import { ReplManager } from './replManager';

/**
 * WebviewViewProvider for the APL REPL panel (bottom panel area).
 * Renders a tab bar + REPL content for the active tab.
 * Delegates all REPL logic to the active ReplTab via ReplManager.
 */
export class ReplViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {

	public static readonly viewType = 'aplRepl';

	private _view?: vscode.WebviewView;
	private _manager: ReplManager;
	private _extensionUri: vscode.Uri;

	constructor(
		extensionUri: vscode.Uri,
		manager: ReplManager,
	) {
		this._extensionUri = extensionUri;
		this._manager = manager;

		// When tabs change (add/remove/switch), update the webview
		this._manager.onTabsChanged = () => this._onTabsChanged();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
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
			const tab = this._manager.activeTab;

			switch (message.command) {
				case 'ready':
					// Webview loaded — auto-create first tab if none exist
					if (!this._manager.hasTabs) {
						this._manager.createTab();
					}
					this._syncFullState();
					return;

				// --- Tab management ---
				case 'newTab':
					this._manager.createTab();
					return;
				case 'switchTab':
					this._manager.switchToTab(message.tabId);
					return;
				case 'closeTab':
					this._manager.closeTab(message.tabId);
					return;
				case 'reorderTab':
					this._manager.reorderTab(message.tabId, message.targetId, message.before);
					return;

				// --- REPL actions (delegated to active tab) ---
				case 'execute':
					tab?.handleExecute(message.code);
					return;
				case 'executeWithTrace':
					tab?.handleExecuteWithTrace(message.code);
					return;
				case 'requestHistory':
					this._syncFullState();
					return;
				case 'clear':
					tab?.clear();
					return;
				case 'connect':
					tab?.handleConnect();
					return;
				case 'interrupt':
					tab?.handleInterrupt();
					return;
				case 'autocomplete':
					tab?.handleAutocomplete(message.line, message.pos, message.token);
					return;
				case 'valuetip':
					tab?.handleValueTip(message.expression);
					return;
				case 'navigateToError':
					tab?.handleNavigateToError(message.name, message.line);
					return;
			}
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this._syncFullState();
			}
		});
	}

	/** Called when the manager's tab list or active tab changes. */
	private _onTabsChanged(): void {
		// Wire up the new active tab to forward to our webview
		this._activateCurrentTab();
		this._syncFullState();
	}

	/** Wire the active tab's postMessage to our webview. */
	private _activateCurrentTab(): void {
		// Deactivate all tabs first
		for (const info of this._manager.getTabList()) {
			this._manager.getTab(info.replId)?.deactivate();
		}

		// Activate the current tab
		const tab = this._manager.activeTab;
		if (tab && this._view) {
			tab.activate((msg: any) => {
				this._view?.webview.postMessage(msg);
			});
		}
	}

	/** Send full state to the webview (tab list + active tab's history/status). */
	private _syncFullState(): void {
		if (!this._view) return;

		const webview = this._view.webview;
		const tab = this._manager.activeTab;

		// Send tab list
		webview.postMessage({
			command: 'setTabs',
			tabs: this._manager.getTabList()
		});

		if (tab) {
			// Activate the tab so it can forward messages
			this._activateCurrentTab();

			// Send history
			webview.postMessage({
				command: 'setHistory',
				history: tab.outputHistory,
				inputHistory: this._manager.inputHistory
			});

			// Send status
			webview.postMessage({
				command: 'setStatus',
				status: tab.connectionState
			});

			// Send debug mode
			webview.postMessage({
				command: 'setDebugMode',
				isDebug: tab.isDebugMode
			});
		}
	}

	public dispose(): void {
		this._manager.onTabsChanged = undefined;
	}

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
		<div id="tab-bar">
			<div id="tab-list"></div>
			<button id="new-tab-btn" title="New REPL">+</button>
		</div>
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

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
