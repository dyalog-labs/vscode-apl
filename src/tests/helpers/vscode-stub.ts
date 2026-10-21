/**
 * Minimal vscode module stub for running tests outside VS Code.
 * Only stubs what's needed to allow module loading — tests that
 * exercise vscode API should run in the Extension Host instead.
 */

export const workspace = {
	workspaceFolders: undefined as any,
	textDocuments: [] as any[],
	findFiles: async () => [],
	openTextDocument: async () => ({}),
	getConfiguration: () => ({
		get: () => undefined
	}),
	fs: {
		stat: async () => { throw new Error('not implemented'); },
		readFile: async () => new Uint8Array(),
		writeFile: async () => {},
		delete: async () => {}
	},
	asRelativePath: (p: any) => p,
	onDidChangeBreakpoints: () => ({ dispose: () => {} }),
	onDidSaveTextDocument: () => ({ dispose: () => {} }),
	registerFileSystemProvider: () => ({ dispose: () => {} })
};

export const window = {
	showTextDocument: async () => ({}),
	createWebviewPanel: () => ({ webview: { html: '' }, dispose: () => {} }),
	showWarningMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	showInformationMessage: async () => undefined,
	showInputBox: async () => undefined,
	showQuickPick: async () => undefined,
	activeTextEditor: undefined as any,
	createStatusBarItem: () => ({
		text: '',
		show: () => {},
		hide: () => {},
		dispose: () => {}
	}),
	registerWebviewViewProvider: () => ({ dispose: () => {} }),
	tabGroups: {
		all: [] as any[],
		close: async () => true,
		onDidChangeTabs: () => ({ dispose: () => {} })
	}
};

export const commands = {
	registerCommand: () => ({ dispose: () => {} }),
	registerTextEditorCommand: () => ({ dispose: () => {} }),
	executeCommand: async () => {}
};

export const debug = {
	activeDebugSession: undefined as any,
	breakpoints: [] as any[],
	registerDebugConfigurationProvider: () => ({ dispose: () => {} }),
	registerDebugAdapterDescriptorFactory: () => ({ dispose: () => {} }),
	registerDebugAdapterTrackerFactory: () => ({ dispose: () => {} }),
	onDidStartDebugSession: () => ({ dispose: () => {} }),
	onDidTerminateDebugSession: () => ({ dispose: () => {} }),
	onDidChangeActiveDebugSession: () => ({ dispose: () => {} }),
	onDidChangeBreakpoints: () => ({ dispose: () => {} }),
	onDidReceiveDebugSessionCustomEvent: () => ({ dispose: () => {} }),
	startDebugging: async () => true
};

export const languages = {
	registerEvaluatableExpressionProvider: () => ({ dispose: () => {} }),
	registerInlineValuesProvider: () => ({ dispose: () => {} })
};

export class Uri {
	constructor(readonly scheme: string, readonly path: string) {}
	get fsPath() { return this.path; }
	static file(path: string) { return new Uri('file', path); }
	static from(c: { scheme: string; path?: string }) { return new Uri(c.scheme, c.path ?? ''); }
	static parse(s: string) {
		const m = /^([a-z][a-z0-9+.-]*):(?:\/\/[^/]*)?(.*)$/i.exec(s);
		return m ? new Uri(m[1], m[2]) : Uri.file(s);
	}
	static joinPath(base: Uri, ...parts: string[]) {
		return new Uri(base.scheme, [base.path, ...parts].join('/'));
	}
	with(change: { scheme?: string; path?: string }) {
		return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
	}
	toString() { return `${this.scheme}:${this.scheme === 'file' ? '//' : ''}${this.path}`; }
}

export class Position {
	constructor(public readonly line: number, public readonly character: number) {}
	translate(lineDelta: number = 0, charDelta: number = 0) {
		return new Position(this.line + lineDelta, this.character + charDelta);
	}
}

export class Range {
	constructor(
		public readonly start: Position,
		public readonly end: Position
	) {}
}

export class Selection extends Range {
	public readonly active: Position;
	constructor(anchor: Position, active: Position) {
		super(anchor, active);
		this.active = active;
	}
}

export enum TextEditorRevealType {
	Default = 0,
	InCenter = 1,
	InCenterIfOutsideViewport = 2,
	AtTop = 3
}

export class EvaluatableExpression {
	constructor(public readonly range: Range) {}
}

export class InlineValueVariableLookup {
	constructor(
		public readonly range: Range,
		public readonly variableName: string,
		public readonly caseSensitiveLookup: boolean
	) {}
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2
}

export class Disposable {
	constructor(private _callOnDispose: () => void) {}
	dispose() { this._callOnDispose(); }
}

export class EventEmitter<T> {
	private _listeners: Array<(e: T) => void> = [];
	event = (listener: (e: T) => void) => {
		this._listeners.push(listener);
		return new Disposable(() => { this._listeners = this._listeners.filter(l => l !== listener); });
	};
	fire(e: T) { for (const l of this._listeners) { l(e); } }
	dispose() { this._listeners = []; }
}

export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum FileChangeType { Changed = 1, Created = 2, Deleted = 3 }

export class FileSystemError extends Error {
	constructor(message?: string | Uri) { super(typeof message === 'string' ? message : message?.toString()); }
	static FileNotFound(uri?: Uri) { return new FileSystemError(uri ?? 'FileNotFound'); }
	static NoPermissions(uri?: Uri) { return new FileSystemError(uri ?? 'NoPermissions'); }
}

export class TabInputText {
	constructor(readonly uri: Uri) {}
}

export class SourceBreakpoint {
	constructor(
		public readonly location: { uri: Uri; range: Range },
		public readonly enabled: boolean = true
	) {}
}

export enum ViewColumn {
	Active = -1,
	Beside = -2,
	One = 1,
	Two = 2
}

export enum DebugConfigurationProviderTriggerKind {
	Initial = 1,
	Dynamic = 2
}
