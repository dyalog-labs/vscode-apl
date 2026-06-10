import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { AplDebugSession } from './aplDebug';
import { FileAccessor } from './aplRuntime';
import { ReplManager } from './replManager';

/**
 * Debug configuration plumbing for the `apl` debug type:
 *
 *  - `AplConfigurationProvider` fills in defaults on `launch.json` entries
 *    before the debug session starts.
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
