import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const skip = !process.env.DYALOG_TESTS;
const slow = process.env.PAUSE_E2E;
const see = (ms: number) => new Promise(resolve => setTimeout(resolve, slow ? ms : 0));

/** Wait for the debug session to hit a stopped state by polling stackTrace. */
function waitForStop(timeoutMs = 10000): Promise<boolean> {
	return new Promise((resolve) => {
		const poll = setInterval(async () => {
			const s = vscode.debug.activeDebugSession;
			if (!s) return;
			try {
				await s.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
				clearInterval(poll); clearTimeout(t); resolve(true);
			} catch {}
		}, 300);
		const t = setTimeout(() => { clearInterval(poll); resolve(false); }, timeoutMs);
	});
}

/** Get variables for the top stack frame's local scope. */
async function getLocals(session: vscode.DebugSession): Promise<Record<string, string>> {
	const st = await session.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 1 });
	if (!st.stackFrames.length) return {};
	const scopes = await session.customRequest('scopes', { frameId: st.stackFrames[0].id });
	const vars: Record<string, string> = {};
	for (const scope of scopes.scopes) {
		const result = await session.customRequest('variables', { variablesReference: scope.variablesReference });
		for (const v of result.variables) {
			vars[v.name] = v.value;
		}
	}
	return vars;
}

/** Get the stack frame names. */
async function getStackNames(session: vscode.DebugSession): Promise<string[]> {
	const st = await session.customRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });
	return st.stackFrames.map((f: any) => f.name);
}

(skip ? suite.skip : suite)('Extension Host + Dyalog — debug session', () => {

	let workspaceFolder: vscode.WorkspaceFolder;

	suiteSetup(async function () {
		this.timeout(30000);
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0);
		workspaceFolder = folders![0];

		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl')!;
		if (!ext.isActive) { await ext.activate(); }
		const api = ext.exports;

		// Create a REPL tab and connect to the interpreter
		await vscode.commands.executeCommand('apl.newRepl');
		const tab = api.replManager.activeTab;
		assert.ok(tab, 'REPL tab should exist after apl.newRepl');
		await tab.handleConnect();

		// Wait for the session to be connected
		await new Promise<void>((resolve, reject) => {
			if (tab.session.isConnected) { resolve(); return; }
			const t = setTimeout(() => reject(new Error('REPL connect timeout')), 15000);
			tab.session.on('ready', () => { clearTimeout(t); resolve(); });
		});

		// Link the workspace so functions (test, foo, goo) are loaded
		const folderPath = workspaceFolder.uri.fsPath.replace(/\\/g, '/');
		tab.session.execute(`⎕SE.Link.Create '#' '${folderPath}'`);
		// Give Link time to scan and load the files
		await new Promise(resolve => setTimeout(resolve, 3000));
	});

	suiteTeardown(async () => {
		if (vscode.debug.activeDebugSession) {
			await vscode.debug.stopDebugging();
		}
		// Disconnect the REPL session
		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl');
		ext?.exports?.replManager?.activeTab?.disconnect();
	});

	teardown(async function () {
		this.timeout(30000);
		if (vscode.debug.activeDebugSession) {
			await vscode.debug.stopDebugging();
		}
		// Give the previous session time to fully tear down before starting a new one
		await new Promise(resolve => setTimeout(resolve, 2000));
	});

	test('step through test→foo→goo, inspect locals and stack', async function () {
		this.timeout(120000);

		const programPath = path.join(workspaceFolder.uri.fsPath, 'test.aplf');
		const uri = vscode.Uri.file(programPath);

		// Open test.aplf so user sees it
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
		await see(2000);

		// Breakpoint on first executable line (line 1: ⎕←a←1)
		const bp = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(1, 0)));
		vscode.debug.addBreakpoints([bp]);
		await see(2000);

		// Launch
		const started = await vscode.debug.startDebugging(workspaceFolder, {
			type: 'apl', name: 'Step Test', request: 'launch',
			program: programPath, cwd: workspaceFolder.uri.fsPath, stopOnEntry: true,
		});
		assert.ok(started, 'debug session should start');
		assert.ok(await waitForStop(), 'should stop on entry');
		await see(2000);

		const session = vscode.debug.activeDebugSession!;

		// -- Stopped at ⎕←a←1 --
		// F10: execute ⎕←a←1, now on ⎕←b←233
		await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		assert.ok(await waitForStop(), 'should stop after step');
		await see(2000);

		// 'a' is localized in header (test;a) so it should be in locals
		let vars = await getLocals(session);
		assert.ok('a' in vars, `'a' should be in locals, got: ${Object.keys(vars)}`);
		assert.strictEqual(vars['a'], '1');
		await see(2000);

		// F10: execute ⎕←b←233, now on ⎕←a+b
		await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		assert.ok(await waitForStop());
		await see(1000);

		// F10: execute ⎕←a+b, now on 'foo' call
		await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		assert.ok(await waitForStop());
		await see(2000);

		// F11: step INTO foo
		await vscode.commands.executeCommand('workbench.action.debug.stepInto');
		assert.ok(await waitForStop());
		await see(2000);

		// Stack should show foo and test
		let stack = await getStackNames(session);
		assert.ok(stack.some(n => n.includes('foo')), `stack should include foo, got: ${stack}`);
		assert.ok(stack.some(n => n.includes('test')), `stack should include test, got: ${stack}`);
		await see(3000);

		// F10 inside foo: execute ⎕←a←'foo'
		await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		assert.ok(await waitForStop());

		// foo;a — 'a' is localized, should be 'foo' (shadowing test's a)
		vars = await getLocals(session);
		assert.ok('a' in vars, `'a' should be in foo's locals`);
		assert.ok(vars['a'].includes('foo'), `foo's a should be 'foo', got: ${vars['a']}`);
		await see(2000);

		// Step through foo until we reach the goo call (line 4)
		// foo: ⎕←b←'42' → ⎕←a,b → goo
		await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		assert.ok(await waitForStop());
		await vscode.commands.executeCommand('workbench.action.debug.stepOver');
		assert.ok(await waitForStop());
		await see(1000);

		// F11: step INTO goo
		await vscode.commands.executeCommand('workbench.action.debug.stepInto');
		assert.ok(await waitForStop());
		await see(2000);

		// Stack should now show goo → foo → test (3 levels)
		stack = await getStackNames(session);
		assert.ok(stack.some(n => n.includes('goo')), `stack should include goo, got: ${stack}`);
		assert.ok(stack.length >= 3, `stack depth should be ≥3, got ${stack.length}: ${stack}`);
		await see(5000);

		// Clean up
		await vscode.debug.stopDebugging(session);
		vscode.debug.removeBreakpoints([bp]);
		await new Promise(resolve => setTimeout(resolve, 1000));
	});

	test('debug config provider assigns replId', async function () {
		this.timeout(60000);

		const sessionStarted = new Promise<vscode.DebugSession>(resolve => {
			const d = vscode.debug.onDidStartDebugSession(s => { if (s.type === 'apl') { d.dispose(); resolve(s); } });
		});

		const programPath = path.join(workspaceFolder.uri.fsPath, 'test.aplf');
		const started = await vscode.debug.startDebugging(workspaceFolder, {
			type: 'apl', name: 'E2E Config Test', request: 'launch',
			program: programPath, cwd: workspaceFolder.uri.fsPath,
		});
		assert.ok(started);

		const session = await Promise.race([
			sessionStarted,
			new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
		]);
		assert.ok(session.configuration.replId, 'should have replId');

		await vscode.debug.stopDebugging(session);
		await new Promise(resolve => setTimeout(resolve, 1000));
	});
});

/** Execute an expression and wait for the session to return to prompt. Rejects on error output. */
function execAndWait(session: any, code: string, timeoutMs = 5000): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let errorOutput = '';
		const onOutput = (text: string, type: string) => {
			if (type === 'error') { errorOutput += text; }
		};
		const cleanup = () => { session.removeListener('ready', onReady); session.removeListener('output', onOutput); clearTimeout(t); };
		const t = setTimeout(() => { cleanup(); reject(new Error(`exec timeout: ${code}`)); }, timeoutMs);
		const onReady = () => {
			cleanup();
			if (errorOutput) { reject(new Error(`APL error executing "${code}": ${errorOutput.trim()}`)); }
			else { resolve(); }
		};
		session.on('output', onOutput);
		session.once('ready', onReady);
		session.execute(code);
	});
}

/** Wait for an editor to open with the given URI scheme. */
function waitForEditor(scheme: string, timeoutMs = 5000): Promise<vscode.TextEditor> {
	return new Promise((resolve, reject) => {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === scheme) { resolve(editor); return; }
		const t = setTimeout(() => { d.dispose(); reject(new Error(`no ${scheme}: editor within ${timeoutMs}ms`)); }, timeoutMs);
		const d = vscode.window.onDidChangeActiveTextEditor(e => {
			if (e && e.document.uri.scheme === scheme) { clearTimeout(t); d.dispose(); resolve(e); }
		});
	});
}

(skip ? suite.skip : suite)('Extension Host + Dyalog — edit windows', () => {

	let tab: any;

	suiteSetup(async function () {
		this.timeout(30000);
		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl')!;
		if (!ext.isActive) { await ext.activate(); }

		// Always create a fresh REPL tab with its own interpreter
		await vscode.commands.executeCommand('apl.newRepl');
		tab = ext.exports.replManager.activeTab;
		assert.ok(tab, 'REPL tab should exist');
		await tab.handleConnect();

		await new Promise<void>((resolve, reject) => {
			if (tab.session.isConnected) { resolve(); return; }
			const t = setTimeout(() => reject(new Error('REPL connect timeout')), 15000);
			tab.session.on('ready', () => { clearTimeout(t); resolve(); });
		});
	});

	suiteTeardown(async () => {
		tab?.session?.disconnect();
	});

	teardown(async function () {
		this.timeout(10000);
		// Close all editor tabs
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test(')ed on a variable opens read-only virtual document', async function () {
		this.timeout(30000);

		await execAndWait(tab.session, 'e2e_var ← 3 3⍴⍳9');

		tab.editWindowManager.editDefinition('e2e_var');
		const editor = await waitForEditor('apl-view', 5000);

		assert.strictEqual(editor.document.uri.scheme, 'apl-view',
			`expected apl-view: scheme, got ${editor.document.uri.scheme}`);
		assert.ok(editor.document.getText().length > 0, 'document should have content');
	});

	test('edit button transitions variable to editable temp file', async function () {
		this.timeout(30000);

		await execAndWait(tab.session, 'e2e_var2 ← 2 2⍴100');

		tab.editWindowManager.editDefinition('e2e_var2');
		const viewEditor = await waitForEditor('apl-view', 5000);

		const token = parseInt(viewEditor.document.uri.authority, 10);
		assert.ok(!isNaN(token), 'token should be a number');

		// Request edit mode (sends ShowAsArrayNotation)
		tab.editWindowManager.requestEditMode(token);
		const fileEditor = await waitForEditor('file', 5000);

		assert.strictEqual(fileEditor.document.uri.scheme, 'file',
			`expected file: scheme after edit, got ${fileEditor.document.uri.scheme}`);

		const text = fileEditor.document.getText();
		assert.ok(text.includes('['), `expected array notation with brackets, got: ${text}`);
	});

	test(')ed on a function opens editable temp file directly', async function () {
		this.timeout(30000);

		await execAndWait(tab.session, '⎕FX \'r←e2e_fn x\' \'r←x+1\'');

		tab.editWindowManager.editDefinition('e2e_fn');
		const editor = await waitForEditor('file', 5000);

		assert.strictEqual(editor.document.uri.scheme, 'file',
			`expected file: scheme for function, got ${editor.document.uri.scheme}`);
		assert.ok(editor.document.getText().includes('e2e_fn'),
			`expected function name in content, got: ${editor.document.getText()}`);
	});

	test('SaveChanges is sent on save, CloseWindow on tab close', async function () {
		this.timeout(30000);

		await execAndWait(tab.session, '⎕FX \'r←e2e_save x\' \'r←x×2\'');

		tab.editWindowManager.editDefinition('e2e_save');
		const editor = await waitForEditor('file', 5000);

		// Collect messages sent to the interpreter
		const sent: string[] = [];
		const origSend = tab.session.sendMessage.bind(tab.session);
		tab.session.sendMessage = (cmd: string, args: any) => {
			sent.push(cmd);
			origSend(cmd, args);
		};

		try {
			// Make an edit and save
			await editor.edit((editBuilder: vscode.TextEditorEdit) => {
				const lastLine = editor.document.lineCount - 1;
				const lastChar = editor.document.lineAt(lastLine).text.length;
				editBuilder.insert(new vscode.Position(lastLine, lastChar), ' ');
			});
			await editor.document.save();
			await new Promise(resolve => setTimeout(resolve, 1000));

			assert.ok(sent.includes('SaveChanges'), `expected SaveChanges, sent: ${sent}`);

			// Close the tab
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			await new Promise(resolve => setTimeout(resolve, 1000));

			assert.ok(sent.includes('CloseWindow'), `expected CloseWindow, sent: ${sent}`);
		} finally {
			tab.session.sendMessage = origSend;
		}
	});
});

(skip ? suite.skip : suite)('Extension Host + Dyalog — REPL execution', () => {

	let tab: any;
	let api: any;

	suiteSetup(async function () {
		this.timeout(30000);
		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl')!;
		if (!ext.isActive) { await ext.activate(); }
		api = ext.exports;

		await vscode.commands.executeCommand('apl.newRepl');
		tab = api.replManager.activeTab;
		assert.ok(tab, 'REPL tab should exist');
		await tab.handleConnect();

		await new Promise<void>((resolve, reject) => {
			if (tab.session.isConnected) { resolve(); return; }
			const t = setTimeout(() => reject(new Error('REPL connect timeout')), 15000);
			tab.session.on('ready', () => { clearTimeout(t); resolve(); });
		});
	});

	suiteTeardown(async () => {
		tab?.session?.disconnect();
	});

	test('execute expression produces output', async function () {
		this.timeout(10000);

		const output: string[] = [];
		const onOutput = (text: string) => { output.push(text); };
		tab.session.on('output', onOutput);

		try {
			await execAndWait(tab.session, '2+3');
			assert.ok(output.some(o => o.includes('5')),
				`expected output containing '5', got: ${output}`);
		} finally {
			tab.session.removeListener('output', onOutput);
		}
	});

	test('assignment produces no session output', async function () {
		this.timeout(10000);

		const output: string[] = [];
		const onOutput = (text: string, type: string) => {
			if (type === 'result') { output.push(text); }
		};
		tab.session.on('output', onOutput);

		try {
			await execAndWait(tab.session, 'e2e_silent ← 42');
			// Assignment should produce no result output (only echo)
			const resultText = output.join('');
			assert.ok(!resultText.includes('42'),
				`assignment should not produce result output, got: ${resultText}`);
		} finally {
			tab.session.removeListener('output', onOutput);
		}
	});

	test('⎕FX defines a callable function', async function () {
		this.timeout(10000);

		await execAndWait(tab.session, '⎕FX \'r←e2e_add x\' \'r←x+100\'');

		const output: string[] = [];
		const onOutput = (text: string) => { output.push(text); };
		tab.session.on('output', onOutput);

		try {
			await execAndWait(tab.session, 'e2e_add 5');
			assert.ok(output.some(o => o.includes('105')),
				`expected output containing '105', got: ${output}`);
		} finally {
			tab.session.removeListener('output', onOutput);
		}
	});

	test('APL error is reported', async function () {
		this.timeout(10000);

		try {
			await execAndWait(tab.session, '1÷0');
			assert.fail('should have rejected with DOMAIN ERROR');
		} catch (err: any) {
			assert.ok(err.message.includes('DOMAIN ERROR'),
				`expected DOMAIN ERROR, got: ${err.message}`);
		}
	});
});

(skip ? suite.skip : suite)('Extension Host + Dyalog — go to definition', () => {

	let tab: any;

	suiteSetup(async function () {
		this.timeout(30000);
		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl')!;
		if (!ext.isActive) { await ext.activate(); }

		await vscode.commands.executeCommand('apl.newRepl');
		tab = ext.exports.replManager.activeTab;
		assert.ok(tab, 'REPL tab should exist');
		await tab.handleConnect();

		await new Promise<void>((resolve, reject) => {
			if (tab.session.isConnected) { resolve(); return; }
			const t = setTimeout(() => reject(new Error('REPL connect timeout')), 15000);
			tab.session.on('ready', () => { clearTimeout(t); resolve(); });
		});

		// Link the workspace
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0);
		const folderPath = folders![0].uri.fsPath.replace(/\\/g, '/');
		await execAndWait(tab.session, `⎕SE.Link.Create '#' '${folderPath}'`);
		await new Promise(resolve => setTimeout(resolve, 2000));
	});

	suiteTeardown(async () => {
		tab?.session?.disconnect();
	});

	teardown(async function () {
		this.timeout(10000);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test('Shift+Enter on function name opens edit window', async function () {
		this.timeout(30000);

		const folders = vscode.workspace.workspaceFolders!;
		const testFile = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'test.aplf'));
		const doc = await vscode.workspace.openTextDocument(testFile);
		await vscode.window.showTextDocument(doc);

		// Place cursor on function name 'foo' (it's called in test.aplf)
		const text = doc.getText();
		const fooIdx = text.indexOf('foo');
		assert.ok(fooIdx >= 0, `'foo' should appear in test.aplf`);
		const fooPos = doc.positionAt(fooIdx);

		const editor = vscode.window.activeTextEditor!;
		editor.selection = new vscode.Selection(fooPos, fooPos);

		// Execute go-to-definition
		await vscode.commands.executeCommand('apl.goToDefinition');
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Should have opened foo in an editor
		const activeEditor = vscode.window.activeTextEditor;
		assert.ok(activeEditor, 'should have an active editor after go-to-definition');
		const content = activeEditor!.document.getText();
		assert.ok(content.includes('foo'),
			`opened editor should contain 'foo', got: ${content}`);
	});
});

(skip ? suite.skip : suite)('Extension Host + Dyalog — REPL tab management', () => {

	let api: any;

	suiteSetup(async function () {
		this.timeout(10000);
		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl')!;
		if (!ext.isActive) { await ext.activate(); }
		api = ext.exports;
	});

	test('apl.newRepl creates a tab', async function () {
		this.timeout(10000);
		const countBefore = api.replManager.getTabList().length;
		await vscode.commands.executeCommand('apl.newRepl');
		assert.strictEqual(api.replManager.getTabList().length, countBefore + 1,
			'tab count should increase by 1');
	});

	test('apl.focusRepl creates tab if none exist', async function () {
		this.timeout(10000);
		// Close all tabs first
		const tabs = api.replManager.getTabList();
		for (const t of tabs) {
			api.replManager.closeTab(t.replId);
		}
		assert.ok(!api.replManager.hasTabs, 'should have no tabs');

		await vscode.commands.executeCommand('apl.focusRepl');
		assert.ok(api.replManager.hasTabs, 'should have a tab after focusRepl');
	});
});

if (process.env.PAUSE_E2E) {
	suite('Pause for exploration', () => {
		test('waiting — press Enter in the terminal to finish', async function () {
			this.timeout(0);
			await new Promise<void>(resolve => {
				process.stdin.resume();
				process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
			});
		});
	});
}
