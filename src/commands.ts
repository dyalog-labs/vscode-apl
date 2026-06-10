import * as vscode from 'vscode';
import { ReplManager } from './replManager';
import { handleHelp } from './aplHelp';

/**
 * Register every command this extension contributes. Pure side-effect:
 * each `registerCommand` / `registerTextEditorCommand` is pushed onto
 * `context.subscriptions`. Split out of `activateAplDebug.ts` so the
 * entry-point file reads as wiring, not command bodies.
 *
 * The only state shared across commands is `lastStepTime`, captured by
 * the closure so `smartStepOver` can distinguish a genuine step from a
 * stray Enter inside the tracer.
 */
export function registerCommands(
	context: vscode.ExtensionContext,
	replManager: ReplManager,
): void {
	let lastStepTime = 0;

	// --- REPL commands ---
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
		vscode.commands.registerTextEditorCommand('apl.goToDefinition', (editor) => {
			const position = editor.selection.active;
			let wordRange = editor.document.getWordRangeAtPosition(position);
			// When cursor is right after a word, step back one character
			if (!wordRange && position.character > 0) {
				wordRange = editor.document.getWordRangeAtPosition(position.translate(0, -1));
			}
			if (!wordRange) { return; }
			const word = editor.document.getText(wordRange);
			if (word) {
				replManager.editDefinition(word);
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

	// --- Debug / editor commands ---
	context.subscriptions.push(
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
}
