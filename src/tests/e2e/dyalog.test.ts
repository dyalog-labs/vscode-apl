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
		this.timeout(20000);
		const folders = vscode.workspace.workspaceFolders;
		assert.ok(folders && folders.length > 0);
		workspaceFolder = folders![0];

		const ext = vscode.extensions.getExtension('undefined_publisher.vscode-apl');
		if (ext && !ext.isActive) { await ext.activate(); }
	});

	suiteTeardown(async () => {
		if (vscode.debug.activeDebugSession) {
			await vscode.debug.stopDebugging();
		}
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
