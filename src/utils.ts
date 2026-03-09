import * as vscode from 'vscode';

/**
 * A type-safe container for a single pending request/reply exchange.
 * Call create() to get a promise, then resolve() or reject() when the reply arrives.
 */
export class PendingRequest<T> {
	private _resolve?: (value: T) => void;
	private _reject?: (error: Error) => void;
	private _promise?: Promise<T>;
	private _timer?: ReturnType<typeof setTimeout>;

	get pending(): boolean { return !!this._resolve; }
	get promise(): Promise<T> | undefined { return this._promise; }

	create(timeoutMs?: number): Promise<T> {
		this._promise = new Promise<T>((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
		if (timeoutMs !== undefined) {
			this._timer = setTimeout(() => this.resolve(undefined as T), timeoutMs);
		}
		return this._promise;
	}

	resolve(value: T): void {
		if (this._timer) { clearTimeout(this._timer); this._timer = undefined; }
		this._resolve?.(value);
		this._resolve = undefined;
		this._reject = undefined;
	}

	reject(error: Error): void {
		if (this._timer) { clearTimeout(this._timer); this._timer = undefined; }
		this._reject?.(error);
		this._resolve = undefined;
		this._reject = undefined;
	}
}

/**
 * A type-safe map of pending keyed request/reply exchanges.
 * Each key (token/id) maps to its own pending promise.
 */
export class PendingRequests<T> {
	private _pending = new Map<number, { resolve: (value: T) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();

	create(key: number, timeoutMs?: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const entry: { resolve: (value: T) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
			if (timeoutMs !== undefined) {
				entry.timer = setTimeout(() => this.resolve(key, undefined as T), timeoutMs);
			}
			this._pending.set(key, entry);
		});
	}

	resolve(key: number, value: T): void {
		const entry = this._pending.get(key);
		if (entry) {
			if (entry.timer) { clearTimeout(entry.timer); }
			entry.resolve(value);
			this._pending.delete(key);
		}
	}

	reject(key: number, error: Error): void {
		const entry = this._pending.get(key);
		if (entry) {
			if (entry.timer) { clearTimeout(entry.timer); }
			entry.reject(error);
			this._pending.delete(key);
		}
	}
}

/**
 * Normalize a file path by uppercasing the drive letter (Windows).
 */
export const normPath = (path: string) => path.replace(/^\w:/, m => m.toUpperCase());

/**
 * Search the workspace for an APL source file matching the given name and open it.
 * Returns true if a file was found and opened, false otherwise.
 */
export async function openAplDefinition(name: string, line: number = 0): Promise<boolean> {
	const baseName = name.includes('.') ? name.split('.').pop()! : name;

	const pattern = `**/${baseName}.{aplf,aplo,apln,aplc,aplci}`;
	const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);

	if (files.length === 0) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) { return false; }
		const nsParts = name.split('.').filter(p => p !== '#');
		const funcName = nsParts.pop()!;
		const dirParts = nsParts;
		const relPath = [...dirParts, `${funcName}.aplf`].join('/');
		const newUri = vscode.Uri.joinPath(folder.uri, relPath);
		const untitledUri = newUri.with({ scheme: 'untitled' });
		const doc = await vscode.workspace.openTextDocument(untitledUri);
		const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
		await editor.edit(eb => eb.insert(new vscode.Position(0, 0), funcName + '\n'));
		return true;
	}

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
		preview: false,
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
