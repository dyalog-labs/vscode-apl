import * as fs from 'fs';
import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { AplDebugSession } from './aplDebug';
import { FileAccessor } from './aplRuntime';
import { ReplManager } from '../repl/replManager';
import { DyalogConnection, findConnectionsFile } from './dyalogConnections';

/**
 * Debug configuration plumbing for the `apl` debug type:
 *
 *  - `AplConfigurationProvider` fills in defaults on `launch.json` entries
 *    before the debug session starts.
 *  - `DyalogConnectionConfigProvider` surfaces the user's saved
 *    `connections.json` interpreter entries as initial / dynamic
 *    debug configurations in the F5 picker.
 *  - `workspaceFileAccessor` adapts `vscode.workspace.fs` to the
 *    runtime's `FileAccessor` shape so `AplDebugSession` doesn't import
 *    `node:fs` directly.
 *  - `InlineDebugAdapterFactory` constructs an in-process debug adapter
 *    so the debug session runs inside the extension host (no separate
 *    adapter executable).
 */
export class AplConfigurationProvider implements vscode.DebugConfigurationProvider {

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
			config.stopOnEntry = true;
		}

		// Ensure cwd is always set — commands like "Run and Debug" don't include it
		if (!config.cwd) {
			config.cwd = folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		}

		// Set program from active editor when not specified at all (F5 with
		// no launch.json).  Skip when program is explicitly "" (workspace
		// debug) or when traceExpression is set (REPL Ctrl+Enter).
		if (config.program == null && !config.traceExpression) {
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

		if (config.program == null && !config.traceExpression) {
			vscode.window.showInformationMessage("Please open an APL file to debug.");
			return undefined;
		}

		return config;
	}
}

/**
 * Read Dyalog connections.json and map each entry to a VS Code
 * `DebugConfiguration`. Returns an empty array if the file is missing
 * or unparseable — callers fall back to a default config in that case.
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
 * Provides the initial / dynamic list of debug configurations in the F5
 * picker, sourced from the user's Dyalog `connections.json`. Falls back
 * to a single generic "APL Launch" entry when no connections are
 * discoverable.
 */
export class DyalogConnectionConfigProvider implements vscode.DebugConfigurationProvider {
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
				cwd: "${workspaceFolder}",
			},
		];
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

export class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new AplDebugSession(workspaceFileAccessor));
	}
}
