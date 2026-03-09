/**
 * Minimal vscode module stub for running tests outside VS Code.
 * Only stubs what's needed to allow module loading — tests that
 * exercise vscode API should run in the Extension Host instead.
 */

export const workspace = {
	workspaceFolders: undefined as any,
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
	onDidChangeBreakpoints: () => ({ dispose: () => {} })
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
	registerWebviewViewProvider: () => ({ dispose: () => {} })
};

export const commands = {
	registerCommand: () => ({ dispose: () => {} }),
	registerTextEditorCommand: () => ({ dispose: () => {} }),
	executeCommand: async () => {}
};

export const debug = {
	activeDebugSession: undefined as any,
	breakpoints: [],
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
	readonly fsPath: string;
	readonly scheme: string;
	constructor(fsPath: string, scheme = 'file') {
		this.fsPath = fsPath;
		this.scheme = scheme;
	}
	static file(path: string) { return new Uri(path); }
	static parse(path: string) { return new Uri(path); }
	static joinPath(base: Uri, ...parts: string[]) {
		return new Uri([base.fsPath, ...parts].join('/'));
	}
	with(change: { scheme?: string }) {
		return new Uri(this.fsPath, change.scheme || this.scheme);
	}
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
