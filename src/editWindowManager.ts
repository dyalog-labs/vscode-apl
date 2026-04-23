import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as Path from 'path';
import { AplSession } from './aplSession';
import type { CloseWindowMessage, GotoWindowMessage, OpenWindowMessage, ReplySaveChangesMessage } from './rideMessages';

interface EditWindowEntry {
	token: number;
	name: string;
	entityType: number;
	readOnly: boolean;
	/** Set when in read-only view mode (apl-view: scheme virtual doc) */
	viewUri?: vscode.Uri;
	/** Set when in editable mode (temp file on disk) */
	tempFile?: string;
	/** Set while a SaveChanges round-trip is in flight */
	pendingSave?: {
		resolve: () => void;
		reject: (err: Error) => void;
	};
}

/**
 * Provides read-only, live-updating virtual documents for variable views.
 * Content is refreshed by the interpreter via UpdateWindow messages.
 */
class AplViewProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	private _contents = new Map<number, string>();

	provideTextDocumentContent(uri: vscode.Uri): string {
		const token = parseInt(uri.authority, 10);
		return this._contents.get(token) ?? '';
	}

	setContent(token: number, text: string): void {
		this._contents.set(token, text);
		this._onDidChange.fire(AplViewProvider.uriForToken(token));
	}

	deleteContent(token: number): void {
		this._contents.delete(token);
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	static uriForToken(token: number, name?: string): vscode.Uri {
		const safeName = (name ?? 'view').replace(/[⎕#./\\:*?"<>|]/g, '_');
		return vscode.Uri.parse(`apl-view://${token}/${safeName}.apl`);
	}
}

/** Shared temp directory for all vscode-apl temp files (edit windows and debug tracers). */
export const TEMP_DIR = Path.join(os.tmpdir(), 'vscode-apl');

/** Remove leftover temp files from a previous session (e.g. after a crash). */
export function cleanTempDir(): void {
	if (!fs.existsSync(TEMP_DIR)) { return; }
	try {
		for (const file of fs.readdirSync(TEMP_DIR)) {
			try { fs.unlinkSync(Path.join(TEMP_DIR, file)); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

/**
 * Manages non-debug edit windows — those opened via )ED, Shift+Enter
 * (go-to-definition), or any other RIDE `Edit` request.
 *
 * Variables open read-only in display form (via TextDocumentContentProvider)
 * and transition to editable array notation after ShowAsArrayNotation.
 * Functions open directly as editable temp files. All saves go through
 * the RIDE SaveChanges protocol, and CloseWindow is deferred until any
 * pending save completes.
 */
export class EditWindowManager implements vscode.Disposable {

	private _session: AplSession;
	private _onOutput: (type: string, text: string) => void;

	/** RIDE token → editor entry */
	private _editWindows = new Map<number, EditWindowEntry>();
	/** Reverse lookup: URI string → RIDE token */
	private _editWindowsByUri = new Map<string, number>();
	/** Read-only virtual document provider */
	private _viewProvider: AplViewProvider;

	private _disposables: vscode.Disposable[] = [];
	/** Session listener references for removal in dispose() */
	private _sessionListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

	constructor(session: AplSession, onOutput: (type: string, text: string) => void) {
		this._session = session;
		this._onOutput = onOutput;
		this._viewProvider = new AplViewProvider();
		this._disposables.push(
			vscode.workspace.registerTextDocumentContentProvider('apl-view', this._viewProvider)
		);
		this._setupListeners();
	}

	private _onSession(event: string, fn: (...args: any[]) => void): void {
		this._session.on(event, fn);
		this._sessionListeners.push({ event, fn });
	}

	private _setupListeners(): void {
		this._onSession('editWindow', (args: OpenWindowMessage) => {
			this._handleEditWindow(args);
		});

		this._onSession('gotoEditWindow', (args: GotoWindowMessage) => {
			this._handleGotoEditWindow(args.win);
		});

		this._onSession('updateEditWindow', (args: OpenWindowMessage) => {
			this._handleUpdateEditWindow(args);
		});

		this._onSession('closeEditWindow', (args: CloseWindowMessage) => {
			this._handleCloseEditWindow(args.win);
		});

		this._onSession('replySaveChanges', (args: ReplySaveChangesMessage) => {
			this._handleReplySaveChanges(args);
		});

		this._disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				this._handleDocumentSaved(doc);
			})
		);

		this._disposables.push(
			vscode.window.tabGroups.onDidChangeTabs((event) => {
				for (const closedTab of event.closed) {
					if (closedTab.input instanceof vscode.TabInputText) {
						this._handleTabClosed(closedTab.input.uri);
					}
				}
			})
		);
	}

	// --- Public API ---

	/**
	 * Ask the interpreter to open a definition by name (e.g. from Shift+Enter).
	 * The interpreter replies with an OpenWindow message handled by this manager.
	 */
	public editDefinition(name: string): void {
		this._session.sendMessage('Edit', { win: 0, pos: 0, text: name });
	}

	/**
	 * Request the interpreter to switch a read-only variable view into
	 * editable array notation.  The interpreter responds with UpdateWindow
	 * (entityType 262144, readOnly 0), handled by _handleUpdateEditWindow.
	 */
	public requestEditMode(token: number): void {
		const entry = this._editWindows.get(token);
		if (!entry || !entry.readOnly) { return; }
		this._session.sendMessage('ShowAsArrayNotation', { win: token });
	}

	/**
	 * Close the VS Code tab for a temp file and delete it.
	 * Called when a debug tracer window closes so the orphaned tab doesn't linger.
	 * If the document has unsaved edits, ⎕FIX them into the interpreter first
	 * so the user's changes are not lost.
	 */
	public async closeTempTab(filename: string): Promise<void> {
		const uri = vscode.Uri.file(filename);
		const uriStr = uri.toString();

		// If the user has unsaved edits, ⎕FIX them before closing.
		const doc = vscode.workspace.textDocuments.find(
			d => d.uri.toString() === uriStr
		);
		if (doc?.isDirty) {
			const lines = doc.getText().split(/\r?\n/);
			if (lines.length > 0 && lines[lines.length - 1] === '') {
				lines.pop();
			}
			const quoted = lines.map(l => `'${l.replace(/'/g, "''")}'`).join(' ');
			this._session.execute(`2 ⎕FIX ${quoted}`);
		}

		const closePromises: Thenable<unknown>[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
					closePromises.push(vscode.window.tabGroups.close(tab));
				}
			}
		}
		await Promise.all(closePromises);

		try { fs.unlinkSync(uri.fsPath); } catch { /* ignore */ }
	}

	// --- Open ---

	private async _handleEditWindow(args: OpenWindowMessage): Promise<void> {
		const { token, name, text, entityType, readOnly } = args;
		const content = (text || []).join('\n');
		const isReadOnly = readOnly === 1;

		if (isReadOnly) {
			// Read-only view: use virtual document provider
			const viewUri = AplViewProvider.uriForToken(token, name);
			this._viewProvider.setContent(token, content);

			const entry: EditWindowEntry = { token, name, entityType, readOnly: true, viewUri };
			this._editWindows.set(token, entry);
			this._editWindowsByUri.set(viewUri.toString(), token);

			const doc = await vscode.workspace.openTextDocument(viewUri);
			await vscode.window.showTextDocument(doc, { preview: false });
		} else {
			// Editable: use temp file
			await this._openAsTempFile(token, name, entityType, content);
		}
	}

	private async _openAsTempFile(token: number, name: string, entityType: number, content: string): Promise<void> {
		fs.mkdirSync(TEMP_DIR, { recursive: true });

		const safeName = name.replace(/[⎕#./\\:*?"<>|]/g, '_');
		const filepath = Path.join(TEMP_DIR, `${safeName}_${token}.apl`);
		fs.writeFileSync(filepath, content, 'utf-8');

		const uri = vscode.Uri.file(filepath);
		const entry: EditWindowEntry = { token, name, entityType, readOnly: false, tempFile: filepath };
		this._editWindows.set(token, entry);
		this._editWindowsByUri.set(uri.toString(), token);

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	// --- Goto (interpreter wants to bring a window to front) ---

	private async _handleGotoEditWindow(win: number): Promise<void> {
		const entry = this._editWindows.get(win);
		if (!entry) { return; }

		const uri = entry.viewUri ?? (entry.tempFile ? vscode.Uri.file(entry.tempFile) : undefined);
		if (!uri) { return; }

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	// --- Update (interpreter pushed new content for an open window) ---

	private async _handleUpdateEditWindow(args: OpenWindowMessage): Promise<void> {
		const entry = this._editWindows.get(args.token);
		if (!entry) { return; }

		const content = (args.text || []).join('\n');
		const nowEditable = args.readOnly === 0;

		// Transition: read-only view → editable temp file (after ShowAsArrayNotation)
		if (entry.readOnly && nowEditable) {
			// Close the virtual document tab
			if (entry.viewUri) {
				const uriStr = entry.viewUri.toString();
				const closePromises: Thenable<unknown>[] = [];
				for (const group of vscode.window.tabGroups.all) {
					for (const tab of group.tabs) {
						if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
							closePromises.push(vscode.window.tabGroups.close(tab));
						}
					}
				}
				await Promise.all(closePromises);
				this._editWindowsByUri.delete(uriStr);
				this._viewProvider.deleteContent(args.token);
			}

			// Open as editable temp file
			entry.viewUri = undefined;
			entry.readOnly = false;
			entry.entityType = args.entityType;
			await this._openAsTempFile(args.token, entry.name, args.entityType, content);
			return;
		}

		// Still in read-only view mode: update the virtual document
		if (entry.readOnly && entry.viewUri) {
			this._viewProvider.setContent(args.token, content);
			return;
		}

		// In edit mode: update temp file if not dirty
		if (entry.tempFile) {
			const uri = vscode.Uri.file(entry.tempFile);
			const doc = vscode.workspace.textDocuments.find(
				d => d.uri.toString() === uri.toString()
			);
			if (doc?.isDirty) { return; }

			if (doc && doc.getText() !== content) {
				fs.writeFileSync(entry.tempFile, content, 'utf-8');
			}
		}
	}

	// --- Save ---

	private _handleDocumentSaved(doc: vscode.TextDocument): void {
		const token = this._editWindowsByUri.get(doc.uri.toString());
		if (token === undefined) { return; }

		const entry = this._editWindows.get(token);
		if (!entry) { return; }

		const lines = doc.getText().split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}

		const promise = new Promise<void>((resolve, reject) => {
			entry.pendingSave = { resolve, reject };
		});
		promise.catch(() => {});

		this._session.sendMessage('SaveChanges', {
			win: token,
			text: lines,
			stop: [],
			trace: [],
			monitor: [],
		});
	}

	private _handleReplySaveChanges(args: ReplySaveChangesMessage): void {
		const entry = this._editWindows.get(args.win);
		if (!entry?.pendingSave) { return; }

		if (args.err) {
			this._onOutput('error', `Save failed for window ${args.win}: error ${args.err}`);
			entry.pendingSave.reject(new Error(`Save failed: error ${args.err}`));
		} else {
			entry.pendingSave.resolve();
		}
		entry.pendingSave = undefined;
	}

	// --- Close ---

	private async _handleTabClosed(uri: vscode.Uri): Promise<void> {
		const uriStr = uri.toString();
		const token = this._editWindowsByUri.get(uriStr);
		if (token === undefined) { return; }

		const entry = this._editWindows.get(token);

		// Wait for any in-flight save before sending CloseWindow
		if (entry?.pendingSave) {
			try {
				await new Promise<void>((resolve, reject) => {
					const pending = entry.pendingSave!;
					const origResolve = pending.resolve;
					const origReject = pending.reject;
					pending.resolve = () => { origResolve(); resolve(); };
					pending.reject = (err) => { origReject(err); reject(err); };
				});
			} catch {
				// Save failed, still close the window
			}
		}

		this._session.sendMessage('CloseWindow', { win: token });

		if (entry?.tempFile) {
			try { fs.unlinkSync(entry.tempFile); } catch { /* ignore */ }
		}
		this._editWindows.delete(token);
		this._editWindowsByUri.delete(uriStr);
	}

	private async _handleCloseEditWindow(win: number): Promise<void> {
		const entry = this._editWindows.get(win);
		if (!entry) { return; }

		if (entry.viewUri) {
			const uriStr = entry.viewUri.toString();
			const closePromises: Thenable<unknown>[] = [];
			for (const group of vscode.window.tabGroups.all) {
				for (const tab of group.tabs) {
					if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
						closePromises.push(vscode.window.tabGroups.close(tab));
					}
				}
			}
			await Promise.all(closePromises);
			this._viewProvider.deleteContent(win);
			this._editWindowsByUri.delete(uriStr);
		} else if (entry.tempFile) {
			const uri = vscode.Uri.file(entry.tempFile);
			const uriStr = uri.toString();
			const closePromises: Thenable<unknown>[] = [];
			for (const group of vscode.window.tabGroups.all) {
				for (const tab of group.tabs) {
					if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
						closePromises.push(vscode.window.tabGroups.close(tab));
					}
				}
			}
			await Promise.all(closePromises);
			try { fs.unlinkSync(entry.tempFile); } catch { /* ignore */ }
			this._editWindowsByUri.delete(uriStr);
		}

		this._editWindows.delete(win);
	}

	// --- Lifecycle ---

	public dispose(): void {
		for (const [token, entry] of this._editWindows) {
			if (entry.tempFile) {
				try { fs.unlinkSync(entry.tempFile); } catch { /* ignore */ }
			}
			if (entry.viewUri) {
				this._viewProvider.deleteContent(token);
			}
			if (this._session.isConnected) {
				this._session.sendMessage('CloseWindow', { win: token });
			}
		}
		this._editWindows.clear();
		this._editWindowsByUri.clear();
		this._viewProvider.dispose();

		for (const { event, fn } of this._sessionListeners) {
			this._session.removeListener(event, fn);
		}
		this._sessionListeners = [];

		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
