import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as Path from 'path';
import { AplSession } from './aplSession';
import type { CloseWindowMessage, GotoWindowMessage, OpenWindowMessage, ReplySaveChangesMessage } from './rideMessages';

interface EditWindowEntry {
	uri: vscode.Uri;
	tempFile: boolean;
	name: string;
	entityType: number;
}

// entityType values for variables (from RIDE source):
// 2: SimpleCharArray, 4: SimpleNumericArray, 8: MixedSimpleArray,
// 16: NestedArray, 128: SimpleCharVector
const VARIABLE_ENTITY_TYPES = new Set([2, 4, 8, 16, 128]);

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
 * (go-to-definition), or any other RIDE `Edit` request.  Tracks RIDE
 * tokens, maps them to VS Code editors (backed by temp files or workspace
 * files), and keeps editor content in sync with the interpreter state.
 */
export class EditWindowManager implements vscode.Disposable {

	private _session: AplSession;
	private _onOutput: (type: string, text: string) => void;

	/** RIDE token → editor file info */
	private _editWindows = new Map<number, EditWindowEntry>();
	/** Reverse lookup: URI string → RIDE token */
	private _editWindowsByUri = new Map<string, number>();
	/** Debounced serialisation timers, keyed by token */
	private _serialiseTimers = new Map<number, ReturnType<typeof setTimeout>>();

	private _disposables: vscode.Disposable[] = [];
	/** Session listener references for removal in dispose() */
	private _sessionListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

	constructor(session: AplSession, onOutput: (type: string, text: string) => void) {
		this._session = session;
		this._onOutput = onOutput;
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
			if (args.err) {
				this._onOutput('error', `Save failed for window ${args.win}: error ${args.err}`);
			}
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
		const { token, name, text, filename, entityType } = args;
		const content = (text || []).join('\n');

		let uri: vscode.Uri;
		let tempFile = false;

		let resolved = filename ? Path.resolve(filename) : '';

		// The interpreter doesn't set `filename` for variables even when Link
		// is active.  Consult the session's link cache so we open the linked
		// file instead of an unlinked temp copy.
		if (!resolved && VARIABLE_ENTITY_TYPES.has(entityType)) {
			const linkPath = await this._session.getLinkedFile(name, entityType);
			if (linkPath) { resolved = Path.resolve(linkPath); }
		}

		if (resolved && fs.existsSync(resolved)) {
			uri = vscode.Uri.file(resolved);
		} else {
			fs.mkdirSync(TEMP_DIR, { recursive: true });

			const safeName = name.replace(/[⎕#./\\:*?"<>|]/g, '_');
			const filepath = Path.join(TEMP_DIR, `${safeName}_${token}.apl`);
			fs.writeFileSync(filepath, content, 'utf-8');

			uri = vscode.Uri.file(filepath);
			tempFile = true;
		}

		this._editWindows.set(token, { uri, tempFile, name, entityType });
		this._editWindowsByUri.set(uri.toString(), token);

		// For variables, replace display form with array notation before opening
		if (VARIABLE_ENTITY_TYPES.has(entityType) && tempFile) {
			await this._serialiseToFile(name, uri.fsPath);
		}

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	// --- Goto (interpreter wants to bring a window to front) ---

	private async _handleGotoEditWindow(win: number): Promise<void> {
		const entry = this._editWindows.get(win);
		if (!entry) { return; }

		// Re-serialise variables to array notation (may have changed)
		if (VARIABLE_ENTITY_TYPES.has(entry.entityType) && entry.tempFile) {
			await this._serialiseToFile(entry.name, entry.uri.fsPath);
		}

		const doc = await vscode.workspace.openTextDocument(entry.uri);
		await vscode.window.showTextDocument(doc, { preview: false });
		await vscode.commands.executeCommand('workbench.action.files.revert');
	}

	// --- Update (interpreter pushed new content for an open window) ---

	private async _handleUpdateEditWindow(args: OpenWindowMessage): Promise<void> {
		const entry = this._editWindows.get(args.token);
		if (!entry) { return; }

		if (entry.tempFile) {
			const doc = vscode.workspace.textDocuments.find(
				d => d.uri.toString() === entry.uri.toString()
			);
			if (doc?.isDirty) { return; }

			const content = (args.text || []).join('\n');
			if (doc && doc.getText() !== content) {
				fs.writeFileSync(entry.uri.fsPath, content, 'utf-8');
			}

			// Debounce: once updates stop, re-serialise to array notation
			if (VARIABLE_ENTITY_TYPES.has(entry.entityType)) {
				this._debouncedSerialise(args.token, entry.name, entry.uri.fsPath);
			}
		}
	}

	// --- Serialise helpers ---

	private _debouncedSerialise(token: number, name: string, fsPath: string): void {
		const prev = this._serialiseTimers.get(token);
		if (prev) { clearTimeout(prev); }

		this._serialiseTimers.set(token, setTimeout(() => {
			this._serialiseTimers.delete(token);
			this._serialiseToFile(name, fsPath);
		}, 500));
	}

	private _serialiseToFile(name: string, fsPath: string): Promise<void> {
		const aplPath = fsPath.replace(/\\/g, '/').replace(/'/g, "''");
		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				watcher.close();
				resolve();
			}, 5000);
			const watcher = fs.watch(fsPath, { persistent: false }, () => {
				clearTimeout(timeout);
				watcher.close();
				resolve();
			});
			this._session.execute(`(⊂↑⎕SE.Dyalog.Array.Serialise ${name})⎕NPUT'${aplPath}'1`);
		});
	}

	// --- Save / close ---

	private _handleDocumentSaved(doc: vscode.TextDocument): void {
		const token = this._editWindowsByUri.get(doc.uri.toString());
		if (token === undefined) { return; }

		const entry = this._editWindows.get(token);
		if (!entry) { return; }

		// For linked (non-temp) files, Link's file watcher syncs the change
		// to the interpreter — sending our own update would duplicate work
		// and can misparse .apla display form as array notation.
		if (!entry.tempFile) { return; }

		const lines = doc.getText().split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}

		if (VARIABLE_ENTITY_TYPES.has(entry.entityType)) {
			const value = lines.join('\n');
			this._session.execute(`${entry.name} ← ${value}`);
			return;
		}

		this._session.sendMessage('SaveChanges', {
			win: token,
			text: lines,
			stop: [],
			trace: [],
			monitor: [],
		});
	}

	private _handleTabClosed(uri: vscode.Uri): void {
		const uriStr = uri.toString();
		const token = this._editWindowsByUri.get(uriStr);
		if (token === undefined) { return; }

		this._session.sendMessage('CloseWindow', { win: token });
		const timer = this._serialiseTimers.get(token);
		if (timer) { clearTimeout(timer); this._serialiseTimers.delete(token); }

		const entry = this._editWindows.get(token);
		if (entry?.tempFile) {
			try { fs.unlinkSync(entry.uri.fsPath); } catch { /* ignore */ }
		}

		this._editWindows.delete(token);
		this._editWindowsByUri.delete(uriStr);
	}

	private async _handleCloseEditWindow(win: number): Promise<void> {
		const entry = this._editWindows.get(win);
		if (!entry) { return; }

		const timer = this._serialiseTimers.get(win);
		if (timer) { clearTimeout(timer); this._serialiseTimers.delete(win); }

		const uriStr = entry.uri.toString();

		const closePromises: Thenable<unknown>[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
					closePromises.push(vscode.window.tabGroups.close(tab));
				}
			}
		}
		await Promise.all(closePromises);

		if (entry.tempFile) {
			try { fs.unlinkSync(entry.uri.fsPath); } catch { /* ignore */ }
		}

		this._editWindows.delete(win);
		this._editWindowsByUri.delete(uriStr);
	}

	// --- Lifecycle ---

	public dispose(): void {
		for (const [token, entry] of this._editWindows) {
			if (entry.tempFile) {
				try { fs.unlinkSync(entry.uri.fsPath); } catch { /* ignore */ }
			}
			if (this._session.isConnected) {
				this._session.sendMessage('CloseWindow', { win: token });
			}
		}
		this._editWindows.clear();
		this._editWindowsByUri.clear();
		for (const t of this._serialiseTimers.values()) { clearTimeout(t); }
		this._serialiseTimers.clear();

		for (const { event, fn } of this._sessionListeners) {
			this._session.removeListener(event, fn);
		}
		this._sessionListeners = [];

		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
