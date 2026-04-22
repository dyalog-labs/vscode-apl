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

	private _disposables: vscode.Disposable[] = [];

	constructor(session: AplSession, onOutput: (type: string, text: string) => void) {
		this._session = session;
		this._onOutput = onOutput;
		this._setupListeners();
	}

	private _setupListeners(): void {
		this._session.on('editWindow', (args: OpenWindowMessage) => {
			this._handleEditWindow(args);
		});

		this._session.on('gotoEditWindow', (args: GotoWindowMessage) => {
			const entry = this._editWindows.get(args.win);
			if (entry) {
				vscode.workspace.openTextDocument(entry.uri).then(doc => {
					vscode.window.showTextDocument(doc, { preview: false });
				});
			}
		});

		this._session.on('updateEditWindow', (args: OpenWindowMessage) => {
			this._handleUpdateEditWindow(args);
		});

		this._session.on('closeEditWindow', (args: CloseWindowMessage) => {
			this._handleCloseEditWindow(args.win);
		});

		this._session.on('replySaveChanges', (args: ReplySaveChangesMessage) => {
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

	// --- Open ---

	private async _handleEditWindow(args: OpenWindowMessage): Promise<void> {
		const { token, name, text, filename, entityType } = args;
		const content = (text || []).join('\n');

		let uri: vscode.Uri;
		let tempFile = false;

		if (filename && fs.existsSync(filename)) {
			uri = vscode.Uri.file(filename);
		} else {
			const tmpDir = Path.join(os.tmpdir(), 'vscode-apl-ed');
			fs.mkdirSync(tmpDir, { recursive: true });

			const safeName = name.replace(/[⎕#./\\:*?"<>|]/g, '_');
			const filepath = Path.join(tmpDir, `${safeName}_${token}.apl`);
			fs.writeFileSync(filepath, content, 'utf-8');

			uri = vscode.Uri.file(filepath);
			tempFile = true;
		}

		this._editWindows.set(token, { uri, tempFile, name, entityType });
		this._editWindowsByUri.set(uri.toString(), token);

		// For variables, replace the display form with array notation before
		// opening the editor so there is no file-change race.
		if (VARIABLE_ENTITY_TYPES.has(entityType) && tempFile) {
			const aplPath = uri.fsPath.replace(/\\/g, '/');
			await new Promise<void>((resolve) => {
				const watcher = fs.watch(uri.fsPath, { persistent: false }, () => {
					watcher.close();
					resolve();
				});
				this._session.execute(`(⊂↑⎕SE.Dyalog.Array.Serialise ${name})⎕NPUT'${aplPath}'1`);
			});
		}

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
	}

	// --- Update (interpreter pushed new content for an open window) ---

	private _handleUpdateEditWindow(args: OpenWindowMessage): void {
		const entry = this._editWindows.get(args.token);
		if (!entry) { return; }

		const content = (args.text || []).join('\n');

		if (entry.tempFile) {
			const doc = vscode.workspace.textDocuments.find(
				d => d.uri.toString() === entry.uri.toString()
			);
			// Only write if the document is clean — don't overwrite user edits
			if (doc && !doc.isDirty && doc.getText() !== content) {
				fs.writeFileSync(entry.uri.fsPath, content, 'utf-8');
			}
		}
	}

	// --- Save / close ---

	private _handleDocumentSaved(doc: vscode.TextDocument): void {
		const token = this._editWindowsByUri.get(doc.uri.toString());
		if (token === undefined) { return; }

		const entry = this._editWindows.get(token);
		if (!entry) { return; }

		const lines = doc.getText().split(/\r?\n/);
		if (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}

		if (VARIABLE_ENTITY_TYPES.has(entry.entityType)) {
			// Variables: SaveChanges silently no-ops, so assign via Execute.
			// The editor shows array notation (from ⎕SE.Dyalog.Array.Serialise),
			// which needs real newlines to preserve structure.
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

		const entry = this._editWindows.get(token);
		if (entry?.tempFile) {
			try { fs.unlinkSync(entry.uri.fsPath); } catch { /* ignore */ }
		}

		this._editWindows.delete(token);
		this._editWindowsByUri.delete(uriStr);
	}

	private _handleCloseEditWindow(win: number): void {
		const entry = this._editWindows.get(win);
		if (!entry) { return; }

		const uriStr = entry.uri.toString();

		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uriStr) {
					vscode.window.tabGroups.close(tab);
					break;
				}
			}
		}

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

		this._disposables.forEach(d => d.dispose());
		this._disposables = [];
	}
}
