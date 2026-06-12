import * as vscode from 'vscode';

/**
 * The extension's single status bar item, shared by the REPL and debug
 * planes. Lives in its own leaf module so consumers (replManager,
 * replTab, activateExtension) don't have to import the composition
 * root — keeping the import graph cycle-free.
 */
let aplStatusBarItem: vscode.StatusBarItem | undefined;

/** Create and show the status bar item. Called once on activation. */
export function createStatusBar(context: vscode.ExtensionContext): void {
	aplStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	aplStatusBarItem.show();
	context.subscriptions.push(aplStatusBarItem);
}

export function updateStatusBar(text: string): void {
	if (aplStatusBarItem) {
		aplStatusBarItem.text = text;
	}
}
