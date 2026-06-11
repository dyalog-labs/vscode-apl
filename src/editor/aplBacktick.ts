/**
 * Editor-side backtick prefix input for APL characters.
 * Detects backtick + key sequences in APL files and replaces them
 * with the corresponding APL character.
 */

import * as vscode from 'vscode';
import { buildAplKeyMap, AplKeyEntry } from './aplKeys';

export class AplBacktickHandler implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];
	private _keyMap: Map<string, AplKeyEntry>;
	private _statusBarItem: vscode.StatusBarItem;

	/** Track pending backtick position per document URI */
	private _pendingBacktick: Map<string, vscode.Position> = new Map();

	/** Guard against recursion when applying our own edits */
	private _isApplyingEdit = false;

	constructor() {
		this._keyMap = buildAplKeyMap();

		this._statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right, 99
		);
		this._statusBarItem.text = '$(keyboard) APL `\u2026';
		this._statusBarItem.tooltip = 'APL backtick prefix mode active — type a key for an APL character';
		this._disposables.push(this._statusBarItem);

		this._disposables.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				this._onDocumentChange(e);
			})
		);

		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => {
				this._clearAllPending();
			})
		);

		this._disposables.push(
			vscode.window.onDidChangeTextEditorSelection(e => {
				// If user moves cursor while pending, cancel
				if (this._pendingBacktick.has(e.textEditor.document.uri.toString())) {
					const pendingPos = this._pendingBacktick.get(e.textEditor.document.uri.toString())!;
					const cursorPos = e.selections[0]?.active;
					// Allow cursor to be right after the backtick (normal typing position)
					if (cursorPos && !cursorPos.isEqual(pendingPos.translate(0, 1))) {
						this._clearPending(e.textEditor.document.uri.toString());
					}
				}
			})
		);
	}

	private _isAplDocument(doc: vscode.TextDocument): boolean {
		return doc.languageId === 'apl';
	}

	private _isEnabled(): boolean {
		return vscode.workspace.getConfiguration('apl')
			.get<boolean>('backtickInput', true);
	}

	private _onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
		if (this._isApplyingEdit) return;
		if (!this._isAplDocument(e.document)) return;
		if (!this._isEnabled()) return;

		// Only process single-character typed changes (not paste, undo, etc.)
		if (e.contentChanges.length !== 1) return;
		const change = e.contentChanges[0];
		if (change.text.length !== 1 || change.rangeLength > 0 && change.text !== change.text[0]) return;

		// Only handle single char insertions (rangeLength 0 = pure insert, or 1 = overwrite)
		if (change.text.length !== 1) return;

		const docUri = e.document.uri.toString();
		const typedChar = change.text;

		// Check if we have a pending backtick for this document
		if (this._pendingBacktick.has(docUri)) {
			const backtickPos = this._pendingBacktick.get(docUri)!;
			this._clearPending(docUri);

			if (typedChar === ' ') {
				// Backtick + space: replace backtick+space with just a literal backtick
				const replaceRange = new vscode.Range(
					backtickPos,
					backtickPos.translate(0, 2)
				);
				this._applyEdit(e.document, replaceRange, '`');
				return;
			}

			// Look up APL character (includes ` -> ⋄)
			const entry = this._keyMap.get(typedChar);
			if (entry) {
				// Replace backtick + typed char with APL character
				const replaceRange = new vscode.Range(
					backtickPos,
					backtickPos.translate(0, 2)
				);
				this._applyEdit(e.document, replaceRange, entry.char);
				return;
			}

			// No mapping found: leave both characters as-is
			return;
		}

		// Not in pending state: check if a backtick was just typed
		if (typedChar === '`') {
			this._pendingBacktick.set(docUri, change.range.start);
			this._statusBarItem.show();
			return;
		}
	}

	private async _applyEdit(
		document: vscode.TextDocument,
		range: vscode.Range,
		newText: string
	): Promise<void> {
		this._isApplyingEdit = true;
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, range, newText);
			await vscode.workspace.applyEdit(edit);
		} finally {
			this._isApplyingEdit = false;
		}
	}

	private _clearPending(docUri: string): void {
		this._pendingBacktick.delete(docUri);
		if (this._pendingBacktick.size === 0) {
			this._statusBarItem.hide();
		}
	}

	private _clearAllPending(): void {
		this._pendingBacktick.clear();
		this._statusBarItem.hide();
	}

	public dispose(): void {
		this._clearAllPending();
		this._disposables.forEach(d => d.dispose());
	}
}
