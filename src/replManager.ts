import * as vscode from 'vscode';
import { AplSession } from './aplSession';
import { ReplTab } from './replTab';

/**
 * Manages all REPL tabs. Singleton accessible from both
 * activation code and the debug adapter.
 *
 * Each tab owns an AplSession + output history.
 * The ReplViewProvider renders the active tab's content
 * in the single bottom-panel webview.
 */
export class ReplManager implements vscode.Disposable {
	private static _instance: ReplManager | undefined;

	private _tabs: Map<string, ReplTab> = new Map();
	private _tabOrder: string[] = [];
	private _activeTabId: string | undefined;
	private _counter = 0;
	private _context!: vscode.ExtensionContext;

	// Shared input history (persisted in globalState)
	private _inputHistory: string[] = [];
	private static readonly HISTORY_KEY = 'apl.repl.inputHistory';
	private static readonly MAX_HISTORY = 500;

	/** Callback set by the view provider to be notified of tab changes. */
	private _onTabsChanged?: () => void;

	private constructor() {}

	public static getInstance(): ReplManager {
		if (!ReplManager._instance) {
			ReplManager._instance = new ReplManager();
		}
		return ReplManager._instance;
	}

	/** Must be called once during extension activation. */
	public initialize(context: vscode.ExtensionContext): void {
		this._context = context;
		this._inputHistory = context.globalState.get<string[]>(
			ReplManager.HISTORY_KEY, []
		);
	}

	/** Register a callback for when tabs are added/removed/switched. */
	public set onTabsChanged(cb: (() => void) | undefined) {
		this._onTabsChanged = cb;
	}

	/** Create a new REPL tab. Returns the replId. */
	public createTab(): string {
		this._counter++;
		const replId = `repl-${this._counter}-${Date.now()}`;
		const label = `REPL ${this._counter}`;

		const session = new AplSession();
		const tab = new ReplTab(replId, label, session, this);

		this._tabs.set(replId, tab);
		this._tabOrder.push(replId);
		this._activeTabId = replId;

		this._onTabsChanged?.();
		return replId;
	}

	/** Close a tab, disconnecting its session. */
	public closeTab(replId: string): void {
		const tab = this._tabs.get(replId);
		if (!tab) return;

		tab.deactivate();
		tab.dispose();
		this._tabs.delete(replId);
		this._tabOrder = this._tabOrder.filter(id => id !== replId);

		if (this._activeTabId === replId) {
			this._activeTabId = this._tabOrder.length > 0
				? this._tabOrder[this._tabOrder.length - 1]
				: undefined;
		}

		this._onTabsChanged?.();
	}

	/** Switch to a specific tab. */
	public switchToTab(replId: string): void {
		if (!this._tabs.has(replId)) return;
		if (this._activeTabId === replId) return;

		// Deactivate current
		if (this._activeTabId) {
			this._tabs.get(this._activeTabId)?.deactivate();
		}
		this._activeTabId = replId;
		this._onTabsChanged?.();
	}

	/** Get the active tab. */
	public get activeTab(): ReplTab | undefined {
		if (!this._activeTabId) return undefined;
		return this._tabs.get(this._activeTabId);
	}

	/** Get the active tab's session (for debug adapter). */
	public get activeSession(): AplSession | undefined {
		return this.activeTab?.session;
	}

	/** Get the active tab's replId. */
	public get activeReplId(): string | undefined {
		return this._activeTabId;
	}

	/** Get a specific tab by replId. */
	public getTab(replId: string): ReplTab | undefined {
		return this._tabs.get(replId);
	}

	/** Get all tabs in order, with active flag. */
	public getTabList(): Array<{ replId: string; label: string; isActive: boolean }> {
		return this._tabOrder.map(id => {
			const tab = this._tabs.get(id)!;
			return {
				replId: id,
				label: tab.label,
				isActive: id === this._activeTabId
			};
		});
	}

	/** Whether there are any tabs. */
	public get hasTabs(): boolean {
		return this._tabs.size > 0;
	}

	/** Shared input history. */
	public get inputHistory(): string[] {
		return this._inputHistory;
	}

	/** Add an entry to shared input history and persist. */
	public addToHistory(code: string): void {
		this._inputHistory.push(code);
		if (this._inputHistory.length > ReplManager.MAX_HISTORY) {
			this._inputHistory = this._inputHistory.slice(-ReplManager.MAX_HISTORY);
		}
		this._context.globalState.update(ReplManager.HISTORY_KEY, this._inputHistory);
	}

	/** Clear the active tab's output. */
	public clearActiveTab(): void {
		this.activeTab?.clear();
	}

	/** Interrupt the active tab's session. */
	public interruptActiveTab(): void {
		this.activeTab?.interrupt();
	}

	public dispose(): void {
		for (const tab of this._tabs.values()) {
			tab.dispose();
		}
		this._tabs.clear();
		this._tabOrder = [];
	}
}
