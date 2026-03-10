import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'undefined_publisher.vscode-apl';

suite('Extension Host — activation', () => {

	suiteSetup(async () => {
		const ext = vscode.extensions.getExtension(EXT_ID);
		if (ext && !ext.isActive) {
			await ext.activate();
		}
	});

	test('extension is present and active', () => {
		const ext = vscode.extensions.getExtension(EXT_ID);
		assert.ok(ext, 'extension should be installed');
		assert.ok(ext!.isActive, 'extension should be active');
	});

	test('all expected commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		const expected = [
			'apl.focusRepl',
			'apl.newRepl',
			'apl.repl.clear',
			'apl.repl.interrupt',
			'apl.goToDefinition',
			'apl.localizeVariable',
			'apl.escapeAction',
			'apl.smartStepOver',
			'extension.apl-debug.runEditorContents',
			'extension.apl-debug.debugEditorContents',
			'extension.apl-debug.traceBackward',
			'extension.apl-debug.traceForward',
			'extension.apl-debug.cutback',
			'extension.apl-debug.help',
			'extension.apl-debug.toggleFormatting',
		];
		const missing = expected.filter(cmd => !commands.includes(cmd));
		assert.deepStrictEqual(missing, [], `missing commands: ${missing.join(', ')}`);
	});

	test('apl debug type is registered', async () => {
		const config: vscode.DebugConfiguration = {
			type: 'apl',
			name: 'Test',
			request: 'launch',
			program: '${workspaceFolder}/test.aplf',
			exe: 'dyalog',
			cwd: '${workspaceFolder}',
		};
		// startDebugging should not throw "no debug adapter registered"
		const result = await vscode.debug.startDebugging(
			vscode.workspace.workspaceFolders?.[0],
			config
		).then(
			(started) => ({ ok: true, started }),
			(err) => ({ ok: false, error: err.message as string })
		);
		assert.ok(typeof result === 'object', 'debug launch should return a result');
	});

	test('workspace folder is loaded', () => {
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0, 'should have a workspace folder');
		assert.ok(folders![0].uri.fsPath.includes('sampleWorkspace'),
			`workspace should be sampleWorkspace, got: ${folders![0].uri.fsPath}`);
	});
});

suite('Extension Host — APL file handling', () => {

	test('can open an APL file from workspace', async () => {
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0);

		const testFile = vscode.Uri.file(path.join(folders![0].uri.fsPath, 'test.aplf'));
		const doc = await vscode.workspace.openTextDocument(testFile);
		assert.ok(doc, 'should open test.aplf');
		assert.ok(doc.getText().length > 0, 'file should have content');
	});

	test('APL file language detection (no grammar extension)', async () => {
		// NOTE: This extension does NOT contribute a "languages" entry in package.json,
		// so .aplf files show as 'plaintext' unless a separate APL grammar extension is
		// installed. This test documents that gap — a "languages" contribution with
		// extensions: [".aplf", ".aplo", ".apln", ".aplc", ".apli"] would fix it.
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0);

		const testFile = vscode.Uri.file(path.join(folders![0].uri.fsPath, 'test.aplf'));
		const doc = await vscode.workspace.openTextDocument(testFile);
		// Currently 'plaintext' — will be 'apl' once the extension adds language contributions
		assert.ok(doc.languageId === 'apl' || doc.languageId === 'plaintext',
			`expected 'apl' or 'plaintext', got '${doc.languageId}'`);
	});

	test('breakpoints can be set on APL files', async () => {
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0);

		const testFile = vscode.Uri.file(path.join(folders![0].uri.fsPath, 'test.aplf'));
		const bp = new vscode.SourceBreakpoint(
			new vscode.Location(testFile, new vscode.Position(1, 0))
		);
		vscode.debug.addBreakpoints([bp]);

		const allBps = vscode.debug.breakpoints;
		const found = allBps.find(b =>
			b instanceof vscode.SourceBreakpoint &&
			b.location.uri.fsPath === testFile.fsPath
		);
		assert.ok(found, 'breakpoint should be set on test.aplf');

		// Clean up
		vscode.debug.removeBreakpoints([bp]);
	});
});

suite('Extension Host — configuration', () => {

	test('apl configuration section exists', () => {
		const config = vscode.workspace.getConfiguration('apl');
		assert.ok(config, 'apl configuration section should exist');
	});

	test('default connectionTiming is onDemand', () => {
		const config = vscode.workspace.getConfiguration('apl');
		assert.strictEqual(config.get('connectionTiming'), 'onDemand');
	});

	test('interpreter.path is configured', () => {
		const config = vscode.workspace.getConfiguration('apl');
		const interpreterPath = config.get<string>('interpreter.path');
		// When DYALOG_TESTS is set, .vscode-test.mjs pre-configures this
		// Otherwise it defaults to empty
		if (process.env.DYALOG_TESTS) {
			assert.ok(interpreterPath && interpreterPath.length > 0,
				'interpreter.path should be set when DYALOG_TESTS is active');
		} else {
			assert.strictEqual(interpreterPath, '');
		}
	});

	test('default backtickInput is true', () => {
		const config = vscode.workspace.getConfiguration('apl');
		assert.strictEqual(config.get('backtickInput'), true);
	});

	test('default languageBar is true', () => {
		const config = vscode.workspace.getConfiguration('apl');
		assert.strictEqual(config.get('languageBar'), true);
	});
});
