/*---------------------------------------------------------
 * Copyright (C) Tiamatica, martanit. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as fs from 'fs';
import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult } from 'vscode';
import { DyalogConnection, findConnectionsFile } from './debug/dyalogConnections';
import { ReplManager } from './repl/replManager';
import { ReplViewProvider } from './repl/replPanel';
import { AplBacktickHandler } from './editor/aplBacktick';
import { cleanTempDir } from './editor/editWindowManager';
import { AplConfigurationProvider, InlineDebugAdapterFactory } from './debug/debugConfigProvider';
import { registerCommands } from './commands';

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

/**
 * The extension's activation entry point — registers every long-lived
 * provider (status bar, REPL manager, webview, backtick handler,
 * commands, debug configurations, language providers) on
 * `context.subscriptions` and returns the singletons that other
 * extensions can pick up via `vscode.extensions.getExtension(...).exports`.
 */
export function activateExtension(context: vscode.ExtensionContext): { replManager: ReplManager } {
	cleanTempDir();

	// create a new status bar item that we can now manage
	aplStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	aplStatusBarItem.show();
	context.subscriptions.push(aplStatusBarItem);

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

	// Register every command this extension contributes
	registerCommands(context, replManager);

	// register a configuration provider for 'apl' debug type
	const provider = new AplConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('apl', provider));

	// Register a configuration provider that discovers Dyalog connections.
	// Initial: used when there's no launch.json (F5 shows a picker).
	// Dynamic: configs appear in the debug dropdown alongside launch.json entries.
	const dyalogConfigProvider = {
		provideDebugConfigurations(_folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			const dyalogConfigs = getDyalogDebugConfigs();
			if (dyalogConfigs.length > 0) {
				return dyalogConfigs;
			}
			return [
				{
					name: "APL Launch",
					request: "launch",
					type: "apl",
					cwd: "${workspaceFolder}"
				}
			];
		}
	};
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('apl', dyalogConfigProvider, vscode.DebugConfigurationProviderTriggerKind.Initial),
		vscode.debug.registerDebugConfigurationProvider('apl', dyalogConfigProvider, vscode.DebugConfigurationProviderTriggerKind.Dynamic),
	);

	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('apl', new InlineDebugAdapterFactory()));
	context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((customEvent) => {
		if (customEvent.event === 'statusInformation') {
			aplStatusBarItem.text = customEvent.body.text;
		} else if (customEvent.event === 'closeTempTab') {
			const replId = (customEvent.session.configuration as any).replId;
			if (replId) {
				replManager.closeTempTab(replId, customEvent.body.filename);
			}
		} else if (customEvent.event === 'openTempTab') {
			const replId = (customEvent.session.configuration as any).replId;
			if (replId) {
				replManager.openTempTab(
					replId,
					customEvent.body.filename,
					customEvent.body.token,
					customEvent.body.stops,
				);
			}
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

	return { replManager };
}

