/*---------------------------------------------------------
 * Copyright (C) Tiamatica, martanit. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { AplDebugSession } from './aplDebug';
import { FileAccessor } from './aplRuntime';
import { DyalogConnection, findConnectionsFile } from './findDyalog';
import { ReplManager } from './replManager';
import { ReplViewProvider } from './replPanel';
import { AplBacktickHandler } from './aplBacktick';
import { openAplDefinition } from './utils';
import { handleHelp } from './aplHelp';

let aplStatusBarItem: vscode.StatusBarItem;

export function updateStatusBar(text: string): void {
	aplStatusBarItem.text = text;
}

/**
 * Read Dyalog connections and map them to VS Code debug configurations.
 */
function getDyalogDebugConfigs(): DebugConfiguration[] {
	const connFile = findConnectionsFile();
	if (!connFile) {
		return [];
	}

	try {
		const raw = fs.readFileSync(connFile, 'utf8');
		const connections: DyalogConnection[] = JSON.parse(raw);
		const configs: DebugConfiguration[] = [];

		for (const conn of connections) {
			if (!conn.name) { continue; }

			if (conn.type === 'start' && conn.exe) {
				configs.push({
					type: 'apl',
					request: 'launch',
					name: conn.name.trim(),
					exe: conn.exe,
					cwd: '${workspaceFolder}',
					stopOnEntry: true,
				});
			} else if (conn.port) {
				configs.push({
					type: 'apl',
					request: 'launch',
					name: conn.name.trim(),
					host: conn.host || '127.0.0.1',
					port: parseInt(conn.port, 10),
					cwd: '${workspaceFolder}',
					stopOnEntry: true,
				});
			}
		}
		return configs;
	} catch {
		return [];
	}
}

export function activateAplDebug(context: vscode.ExtensionContext) {

	let lastStepTime = 0;

	// create a new status bar item that we can now manage
	aplStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	aplStatusBarItem.show();
	// aplStatusBarItem.command = myCommandId;

	// Initialize the REPL manager (multi-tab REPL support)
	const replManager = ReplManager.getInstance();
	replManager.initialize(context);
	context.subscriptions.push(replManager);

	// Register the REPL view provider for bottom panel
	const replProvider = new ReplViewProvider(context.extensionUri, replManager, context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ReplViewProvider.viewType, replProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		replProvider
	);

	// Register APL backtick input handler for editor-side APL files
	context.subscriptions.push(new AplBacktickHandler());

	// Register REPL commands
	context.subscriptions.push(
		vscode.commands.registerCommand('apl.focusRepl', () => {
			// Focus the panel, then ensure a tab exists
			vscode.commands.executeCommand('aplRepl.focus');
			if (!replManager.hasTabs) {
				replManager.createTab();
			}
		}),
		vscode.commands.registerCommand('apl.newRepl', () => {
			replManager.createTab();
			// Also focus the panel so the user sees the new tab
			vscode.commands.executeCommand('aplRepl.focus');
		}),
		vscode.commands.registerCommand('apl.repl.clear', () => {
			replManager.clearActiveTab();
		}),
		vscode.commands.registerCommand('apl.repl.interrupt', () => {
			replManager.interruptActiveTab();
		}),
		vscode.commands.registerTextEditorCommand('apl.goToDefinition', async (editor) => {
			const position = editor.selection.active;
			let wordRange = editor.document.getWordRangeAtPosition(position);
			// When cursor is right after a word, step back one character
			if (!wordRange && position.character > 0) {
				wordRange = editor.document.getWordRangeAtPosition(position.translate(0, -1));
			}
			if (!wordRange) { return; }
			const word = editor.document.getText(wordRange);
			if (word) {
				await openAplDefinition(word);
			}
		}),
		vscode.commands.registerTextEditorCommand('apl.localizeVariable', (editor) => {
			const doc = editor.document;
			const position = editor.selection.active;

			// Get word at cursor, including ⎕-prefixed system names
			const aplNamePattern = /⎕?\w+/;
			let wordRange = doc.getWordRangeAtPosition(position, aplNamePattern);
			if (!wordRange && position.character > 0) {
				wordRange = doc.getWordRangeAtPosition(position.translate(0, -1), aplNamePattern);
			}
			if (!wordRange) { return; }
			const word = doc.getText(wordRange);
			if (!word) { return; }

			// Find the function header line:
			// - In multi-function files, search upward for a ∇ line with content
			// - In single-function .aplf files, use line 0
			let headerLineIdx = -1;
			for (let i = position.line; i >= 0; i--) {
				const m = doc.lineAt(i).text.match(/^\s*∇(.+)/);
				if (m && m[1].trim()) {
					headerLineIdx = i;
					break;
				}
			}
			if (headerLineIdx < 0) {
				headerLineIdx = 0; // single-function file
			}

			const headerLine = doc.lineAt(headerLineIdx);
			const headerText = headerLine.text;

			// Strip leading ∇ if present to get pure header content
			const nablaMatch = headerText.match(/^\s*∇\s*(.*)/);
			const headerContent = nablaMatch ? nablaMatch[1] : headerText;

			// Split by ; — first part is signature, rest are locals
			const parts = headerContent.split(';');
			const signature = parts[0];
			const locals = parts.slice(1).map(s => s.trim());

			// Don't toggle if the name is part of the function signature
			const sigNames: string[] = signature.match(/[⎕]?\w+/g) || [];
			if (sigNames.includes(word)) { return; }

			const localIdx = locals.indexOf(word);
			if (localIdx >= 0) {
				// Already localized — remove it
				// Find the ";word" occurrence in the header to remove
				const beforeSemicolons = parts.slice(0, localIdx + 1).join(';').length;
				const removedPart = parts[localIdx + 1];
				const startOffset = beforeSemicolons; // position of the ";"
				const endOffset = beforeSemicolons + 1 + removedPart.length; // ";" + content

				// Calculate absolute positions in the line
				const lineStart = headerLine.range.start;
				const contentStart = headerText.length - headerContent.length;
				const removeStart = lineStart.translate(0, contentStart + startOffset);
				const removeEnd = lineStart.translate(0, contentStart + endOffset);
				editor.edit(editBuilder => {
					editBuilder.delete(new vscode.Range(removeStart, removeEnd));
				});
			} else {
				// Not yet localized — append ;name to the header line
				editor.edit(editBuilder => {
					editBuilder.insert(headerLine.range.end, ';' + word);
				});
			}
		})
	);

	context.subscriptions.push(
		aplStatusBarItem,
		vscode.commands.registerCommand('extension.apl-debug.runEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
						type: 'apl',
						name: 'Run File',
						request: 'launch',
						program: targetResource.fsPath
					},
					{ noDebug: true }
				);
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.debugEditorContents', (resource: vscode.Uri) => {
			let targetResource = resource;
			if (!targetResource && vscode.window.activeTextEditor) {
				targetResource = vscode.window.activeTextEditor.document.uri;
			}
			if (targetResource) {
				vscode.debug.startDebugging(undefined, {
					type: 'apl',
					name: 'Debug File',
					request: 'launch',
					program: targetResource.fsPath,
					stopOnEntry: true
				});
			}
		}),
		vscode.commands.registerTextEditorCommand('extension.apl-debug.help', (editor: vscode.TextEditor) => {
			const globalStoragePath = context.globalStorageUri.fsPath;
			handleHelp(editor, globalStoragePath);
		}),
		vscode.commands.registerCommand('extension.apl-debug.toggleFormatting', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('toggleFormatting');
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.traceBackward', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('traceBackward');
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.traceForward', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('traceForward');
			}
		}),
		vscode.commands.registerCommand('extension.apl-debug.cutback', (variable) => {
			const ds = vscode.debug.activeDebugSession;
			if (ds) {
				ds.customRequest('cutback');
			}
		}),
		vscode.commands.registerCommand('apl.escapeAction', async () => {
			const ds = vscode.debug.activeDebugSession;
			const editor = vscode.window.activeTextEditor;
			if (ds && editor) {
				try {
					const st = await ds.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
					const topFrame = st.stackFrames?.[0];
					if (topFrame?.source?.path && editor.document.uri.fsPath === topFrame.source.path) {
						ds.customRequest('cutback');
						return;
					}
				} catch { /* fall through to close */ }
			}
			vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}),
		vscode.commands.registerCommand('apl.smartStepOver', async () => {
			const ds = vscode.debug.activeDebugSession;
			const editor = vscode.window.activeTextEditor;
			if (!ds || !editor) {
				vscode.commands.executeCommand('type', { text: '\n' });
				return;
			}
			try {
				const st = await ds.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
				const topFrame = st.stackFrames?.[0];
				if (topFrame?.source?.path && editor.document.uri.fsPath === topFrame.source.path && editor.selection.active.line === topFrame.line - 1) {
					lastStepTime = Date.now();
					vscode.commands.executeCommand('workbench.action.debug.stepOver');
				} else if (Date.now() - lastStepTime > 300) {
					vscode.commands.executeCommand('type', { text: '\n' });
				}
			} catch {
				// Debugger is running (step in flight) — swallow Enter to prevent
				// accidental newline insertion in the tracer
			}
		})
	);

	context.subscriptions.push(vscode.commands.registerCommand('extension.apl-debug.getProgramName', config => {
		return vscode.window.showInputBox({
			placeHolder: "Please enter the name of an APL file in the workspace folder",
			value: "foo.aplf"
		});
	}));

	// register a configuration provider for 'apl' debug type
	const provider = new AplConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('apl', provider));

	// register a dynamic configuration provider for 'apl' debug type
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('apl', {
		provideDebugConfigurations(_folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			const dyalogConfigs = getDyalogDebugConfigs();
			if (dyalogConfigs.length > 0) {
				return dyalogConfigs;
			}
			// Fallback when no Dyalog connections.json found
			return [
				{
					name: "APL Launch",
					request: "launch",
					type: "apl",
					cwd: "${workspaceFolder}"
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('apl', new InlineDebugAdapterFactory()));
	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
		if (customEvent.event === 'statusInformation') {
			aplStatusBarItem.text = customEvent.body.text;
		}
	}));

	// When the user switches active debug session, also switch the REPL tab
	context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession((session) => {
		if (session?.type === 'apl') {
			const replId = (session.configuration as any).replId;
			if (replId) {
				replManager.switchToTab(replId);
			}
		}
	}));

	// override VS Code's default implementation of the debug hover
	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('apl', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			const wordRange = document.getWordRangeAtPosition(position);
			return wordRange ? new vscode.EvaluatableExpression(wordRange) : undefined;
		}
	}));

	// override VS Code's default implementation of the "inline values" feature"
	context.subscriptions.push(vscode.languages.registerInlineValuesProvider('apl', {

		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext) : vscode.ProviderResult<vscode.InlineValue[]> {

			const allValues: vscode.InlineValue[] = [];

			for (let l = viewport.start.line; l <= context.stoppedLocation.end.line; l++) {
				const line = document.lineAt(l);
				const regExp = /[⍺⍵]|⎕[A-Za-z]+|[A-Za-z_∆⍙][A-Za-z0-9_∆⍙]*/g;
				let m: RegExpExecArray | null;
				while ((m = regExp.exec(line.text)) !== null) {
					const varName = m[0];
					const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);
					allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));
				}
			}

			return allValues;
		}
	}));
}

class AplConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): Promise<DebugConfiguration | undefined> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			config.type = 'apl';
			config.name = 'Launch';
			config.request = 'launch';
			config.cwd = folder?.uri.fsPath;
			config.stopOnEntry = true;
		}

		// Set program from active editor if available
		if (!config.program) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'apl') {
				config.program = editor.document.uri.fsPath;
			}
		}

		// Attach to the focused session
		const manager = ReplManager.getInstance();
		config.internalConsoleOptions = 'neverOpen';

		if (!config.replId) {
			const activeTab = manager.activeTab;
			if (!activeTab || !activeTab.session.isConnected) {
				vscode.window.showInformationMessage("Please connect to a Dyalog interpreter first.");
				return undefined;
			}
			config.replId = manager.activeReplId;
		}

		// Update session name to show the REPL number in the debug toolbar
		const tab = manager.getTab(config.replId);
		if (tab) {
			config.name = tab.label;
		}

		if (!config.program) {
			vscode.window.showInformationMessage("Please open an APL file to debug.");
			return undefined;
		}

		return config;
	}


}

export const workspaceFileAccessor: FileAccessor = {
	isWindows: false,
	async checkExists(filePath: string, timeout: number) {
		return new Promise(function (resolve, reject) {
			const startTS = +new Date();
			const interval = Math.min(timeout, 100);
			const uri = pathToUri(filePath);
			const check = async () => {
				try {
					await vscode.workspace.fs.stat(uri);
					resolve(true);
				} catch (e) {
					if (timeout < +new Date() - startTS) {
						reject(new Error('File did not exist and was not created during the timeout.'));
					} else {
						setTimeout(check, interval);
					}
				}
			};
			setTimeout(check, interval);
		});
	},
	async deleteFile(filePath: string): Promise<void> {
		const uri = pathToUri(filePath);
		try {
			await vscode.workspace.fs.delete(uri);
		} catch (e: any) {
			if (e?.code !== 'FileNotFound') { throw e; }
		}
	},
	async readFile(path: string): Promise<Uint8Array> {
		let uri: vscode.Uri;
		try {
			uri = pathToUri(path);
		} catch (e) {
			return new TextEncoder().encode(`cannot read '${path}'`);
		}

		return await vscode.workspace.fs.readFile(uri);
	},
	async writeFile(path: string, contents: Uint8Array) {
		await vscode.workspace.fs.writeFile(pathToUri(path), contents);
	}
};

function pathToUri(path: string) {
	try {
		return vscode.Uri.file(path);
	} catch (e) {
		return vscode.Uri.parse(path);
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new AplDebugSession(workspaceFileAccessor));
	}
}
