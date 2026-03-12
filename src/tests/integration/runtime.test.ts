import assert = require('assert');
import { AplRuntime, FileAccessor } from '../../aplRuntime';
import { AplSession } from '../../aplSession';
import { MockRideServer } from '../helpers/mockRideServer';

const mockFileAccessor: FileAccessor = {
	isWindows: false,
	checkExists: async () => false,
	deleteFile: async () => {},
	readFile: async () => new Uint8Array(),
	writeFile: async () => {},
};

/** Helper: create a wired-up server + session + runtime, ready for tests. */
async function createTestRuntime(): Promise<{
	server: MockRideServer;
	session: AplSession;
	runtime: AplRuntime;
}> {
	const server = new MockRideServer();
	await server.start();
	const session = new AplSession();

	const readyPromise = new Promise<void>(resolve => {
		session.once('ready', resolve);
	});
	await session.connect('127.0.0.1', server.port);
	await readyPromise;

	const runtime = new AplRuntime(mockFileAccessor);
	(runtime as any)._session = session;
	session.setDebugHandler((command: string, args: any) => {
		(runtime as any).handleMessage([command, args]);
	});

	return { server, session, runtime };
}

function teardownTestRuntime(session: AplSession, server: MockRideServer) {
	session.clearDebugHandler();
	session.disconnect();
	server.stop();
}

// ─── Breakpoint handling ────────────────────────────────────────────

suite('AplRuntime — breakpoint handling', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('breakpoint after header line is matched and verified', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'MyFunc', filePath: '/test/file.aplf', startLine: 5 }
		];

		const bp = await runtime.setBreakPoint('/test/file.aplf', 6);

		assert.strictEqual(bp.verified, true);
		const stopCmd = server.getReceived('Execute').find((m: any) => m.text.includes('⎕STOP'));
		assert.ok(stopCmd, 'should have sent ⎕STOP');
	});

	test('breakpoint on function header line is matched', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'MyFunc', filePath: '/test/file.aplf', startLine: 5 }
		];

		const bp = await runtime.setBreakPoint('/test/file.aplf', 5);
		assert.strictEqual(bp.verified, true,
			'breakpoint on header line should be verified (startLine <= bp.line)');
	});

	test('breakpoint line offset is calculated from startLine', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'MyFunc', filePath: '/test/file.aplf', startLine: 10 }
		];

		await runtime.setBreakPoint('/test/file.aplf', 13);

		const stopCmd = server.getReceived('Execute').find((m: any) => m.text.includes('⎕STOP'));
		assert.ok(stopCmd);
		// line 13 - startLine 10 = offset 3
		assert.ok(stopCmd.text.includes('3 ⎕STOP'), `expected offset 3, got: ${stopCmd.text}`);
	});

	test('multiple breakpoints in same function are batched into one ⎕STOP', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'MyFunc', filePath: '/test/file.aplf', startLine: 0 }
		];

		await runtime.setBreakPoint('/test/file.aplf', 2);
		// Second setBreakPoint re-sends for all bps in the file
		await runtime.setBreakPoint('/test/file.aplf', 5);

		// The last ⎕STOP should include both lines
		const stopCmds = server.getReceived('Execute').filter((m: any) => m.text.includes('⎕STOP'));
		const lastCmd = stopCmds[stopCmds.length - 1];
		assert.ok(lastCmd.text.includes('2') && lastCmd.text.includes('5'),
			`expected both offsets in last ⎕STOP, got: ${lastCmd.text}`);
	});

	test('breakpoints across multiple functions in one file', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/test/file.aplf', startLine: 0 },
			{ aplName: 'Fn2', filePath: '/test/file.aplf', startLine: 20 },
		];

		await runtime.setBreakPoint('/test/file.aplf', 5);
		await runtime.setBreakPoint('/test/file.aplf', 25);

		const stopCmds = server.getReceived('Execute')
			.filter((m: any) => m.text.includes('⎕STOP') && !m.text.includes('⍬'));
		const stopTexts = stopCmds.map((m: any) => m.text);
		assert.ok(stopTexts.some((t: string) => t.includes("'Fn1'")), 'should set ⎕STOP on Fn1');
		assert.ok(stopTexts.some((t: string) => t.includes("'Fn2'")), 'should set ⎕STOP on Fn2');
	});

	test('breakpoint in unlinked file stays unverified', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/other/file.aplf', startLine: 0 }
		];

		const bp = await runtime.setBreakPoint('/test/file.aplf', 5);
		assert.strictEqual(bp.verified, false, 'breakpoint in unlinked file should be unverified');
	});

	test('clearBreakpoints sends clear commands for all functions in file', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/test/file.aplf', startLine: 0 },
			{ aplName: 'Fn2', filePath: '/test/file.aplf', startLine: 20 },
		];

		await runtime.setBreakPoint('/test/file.aplf', 5);
		await runtime.setBreakPoint('/test/file.aplf', 25);

		const countBefore = server.received.length;
		await runtime.clearBreakpoints('/test/file.aplf');

		const newMsgs = server.received.slice(countBefore);
		const clearCmds = newMsgs
			.filter(([cmd]: [string, any]) => cmd === 'Execute')
			.filter(([, args]: [string, any]) => args.text.includes('⍬ ⎕STOP'));
		assert.strictEqual(clearCmds.length, 2, 'should clear both functions');
	});

	test('clearBreakpoints is awaitable', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/test/file.aplf', startLine: 0 },
		];
		const result: any = runtime.clearBreakpoints('/test/file.aplf');
		assert.ok(result && typeof result.then === 'function',
			'clearBreakpoints should return a thenable');
		await result;
	});

	test('setBreakPoint with empty linkInfo stays unverified', async () => {
		(runtime as any)._linkInfo = [];
		const bp = await runtime.setBreakPoint('/test/file.aplf', 5);
		assert.strictEqual(bp.verified, false);
	});

	test('setBreakPoint deduplicates by line', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/test/file.aplf', startLine: 0 }
		];
		const bp1 = await runtime.setBreakPoint('/test/file.aplf', 5);
		const bp2 = await runtime.setBreakPoint('/test/file.aplf', 5);
		assert.strictEqual(bp1.id, bp2.id, 'same line should return same breakpoint');
	});
});

// ─── Window management ──────────────────────────────────────────────

suite('AplRuntime — window management', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('OpenWindow sets current window and emits event', async () => {
		const events: any[] = [];
		runtime.on('openWindow', (e: any) => events.push(e));

		server.send('OpenWindow', {
			token: 42,
			name: 'TestFn',
			filename: 'TestFn.aplf',
			text: ['Z←TestFn X', 'Z←X+1'],
			stop: [],
			trace: [],
			monitor: [],
		});

		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual((runtime as any)._winId, 42);
		assert.ok(runtime.currentWindow);
		assert.strictEqual(runtime.currentWindow!.name, 'TestFn');
		assert.strictEqual(events.length, 1);
	});

	test('CloseWindow removes window and emits event', async () => {
		const closeEvents: any[] = [];
		runtime.on('closeWindow', (e: any) => closeEvents.push(e));

		// Open a window first
		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.ok(runtime.currentWindow);

		// Close it
		server.send('CloseWindow', { win: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual((runtime as any)._windows[1], undefined);
		assert.strictEqual(closeEvents.length, 1);
	});

	test('CloseWindow on missing window is a no-op', async () => {
		const events: any[] = [];
		runtime.on('closeWindow', (e: any) => events.push(e));

		server.send('CloseWindow', { win: 999 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual(events.length, 0, 'should not emit for missing window');
	});

	test('auto-debug ends when last tracer window closes', async () => {
		(runtime as any)._autoDebug = true;
		const endEvents: any[] = [];
		runtime.on('end', () => endEvents.push(true));

		// Open two windows
		server.send('OpenWindow', {
			token: 1, name: 'Fn1', filename: 'Fn1.aplf',
			text: ['Fn1'], stop: [], trace: [], monitor: [],
		});
		server.send('OpenWindow', {
			token: 2, name: 'Fn2', filename: 'Fn2.aplf',
			text: ['Fn2'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		// Close first — should not end
		server.send('CloseWindow', { win: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(endEvents.length, 0, 'should not end with windows still open');

		// Close second — should end
		server.send('CloseWindow', { win: 2 });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(endEvents.length, 1, 'should end when last window closes');
	});

	test('non-auto-debug does not end on last window close', async () => {
		(runtime as any)._autoDebug = false;
		const endEvents: any[] = [];
		runtime.on('end', () => endEvents.push(true));

		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('CloseWindow', { win: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(endEvents.length, 0, 'normal debug should not auto-terminate');
	});

	test('UpdateWindow updates existing window data', async () => {
		server.send('OpenWindow', {
			token: 5, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn', 'line1'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('UpdateWindow', {
			token: 5, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn', 'line1', 'line2'], stop: [2], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		const win = (runtime as any)._windows[5];
		assert.strictEqual(win.text.length, 3, 'window text should be updated');
	});

	test('gotoWindow with missing window is a no-op', async () => {
		const events: any[] = [];
		runtime.on('openWindow', (e: any) => events.push(e));

		server.send('GotoWindow', { win: 999 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual(events.length, 0, 'should not emit for missing window');
	});

	test('gotoWindow with valid window emits openWindow', async () => {
		// Open a window first
		server.send('OpenWindow', {
			token: 3, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		const events: any[] = [];
		runtime.on('openWindow', (e: any) => events.push(e));

		server.send('GotoWindow', { win: 3 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual(events.length, 1);
	});
});

// ─── Debug events ───────────────────────────────────────────────────

suite('AplRuntime — debug events', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('SetHighlightLine emits stopOnStep', async () => {
		const events: string[] = [];
		runtime.on('stopOnStep', () => events.push('step'));
		runtime.on('stopOnBreakpoint', () => events.push('breakpoint'));

		// Open a window first so SetHighlightLine has something to update
		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn', 'line1', 'line2'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('SetHighlightLine', { win: 1, line: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(events, ['step']);
		assert.strictEqual((runtime as any)._windows[1].currentRow, 1);
	});

	test('HadError 1001 + SetHighlightLine emits stopOnBreakpoint', async () => {
		const events: string[] = [];
		runtime.on('stopOnStep', () => events.push('step'));
		runtime.on('stopOnBreakpoint', () => events.push('breakpoint'));

		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn', 'line1'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		// HadError 1001 means "hit breakpoint"
		server.send('HadError', { error: 1001 });
		server.send('SetHighlightLine', { win: 1, line: 0 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(events, ['breakpoint']);
	});

	test('HadError flag resets after being consumed', async () => {
		const events: string[] = [];
		runtime.on('stopOnStep', () => events.push('step'));
		runtime.on('stopOnBreakpoint', () => events.push('breakpoint'));

		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: 'Fn.aplf',
			text: ['Fn', 'line1', 'line2'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('HadError', { error: 1001 });
		server.send('SetHighlightLine', { win: 1, line: 0 });
		await new Promise(resolve => setTimeout(resolve, 50));

		// Next highlight without HadError should be a step, not breakpoint
		server.send('SetHighlightLine', { win: 1, line: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(events, ['breakpoint', 'step']);
	});

	test('Disconnect emits end', async () => {
		const events: string[] = [];
		runtime.on('end', () => events.push('end'));

		server.send('Disconnect', { message: 'test disconnect' });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(events, ['end']);
	});

	test('SysError emits end', async () => {
		const events: string[] = [];
		runtime.on('end', () => events.push('end'));

		server.send('SysError', { text: 'fatal error', stack: '' });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(events, ['end']);
	});

	test('AppendSessionOutput emits output', async () => {
		const outputs: string[] = [];
		runtime.on('output', (text: string) => outputs.push(text));

		server.send('AppendSessionOutput', { result: 'hello world\n' });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.ok(outputs.some(o => o.includes('hello world')));
	});

	test('StatusOutput emits output as stderr', async () => {
		const outputs: Array<{ text: string; type: string }> = [];
		runtime.on('output', (text: string, _file: string, type: string) => {
			outputs.push({ text, type });
		});

		server.send('StatusOutput', { text: 'warning message' });
		await new Promise(resolve => setTimeout(resolve, 50));

		const found = outputs.find(o => o.text.includes('warning message'));
		assert.ok(found, 'should emit status output');
		assert.strictEqual(found!.type, 'stderr');
	});
});

// ─── Debug commands ─────────────────────────────────────────────────

suite('AplRuntime — debug commands', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
		(runtime as any)._winId = 7;
	});

	teardown(() => teardownTestRuntime(session, server));

	test('continue sends Continue with current window', async () => {
		runtime.continue();
		await new Promise(resolve => setTimeout(resolve, 50));
		const msgs = server.getReceived('Continue');
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(msgs[0].win, 7);
	});

	test('stepOver sends RunCurrentLine', async () => {
		runtime.stepOver();
		await new Promise(resolve => setTimeout(resolve, 50));
		const msgs = server.getReceived('RunCurrentLine');
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(msgs[0].win, 7);
	});

	test('stepIn sends StepInto', async () => {
		runtime.stepIn(undefined);
		await new Promise(resolve => setTimeout(resolve, 50));
		const msgs = server.getReceived('StepInto');
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(msgs[0].win, 7);
	});

	test('stepOut sends ContinueTrace', async () => {
		runtime.stepOut();
		await new Promise(resolve => setTimeout(resolve, 50));
		const msgs = server.getReceived('ContinueTrace');
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(msgs[0].win, 7);
	});

	test('cutback sends Cutback', async () => {
		runtime.cutback();
		await new Promise(resolve => setTimeout(resolve, 50));
		const msgs = server.getReceived('Cutback');
		assert.strictEqual(msgs.length, 1);
		assert.strictEqual(msgs[0].win, 7);
	});

	test('traceForward sends TraceForward', async () => {
		runtime.traceForward();
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(server.getReceived('TraceForward').length, 1);
	});

	test('traceBackward sends TraceBackward', async () => {
		runtime.traceBackward();
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual(server.getReceived('TraceBackward').length, 1);
	});
});

// ─── Stack frames & autocomplete ────────────────────────────────────

suite('AplRuntime — stack frames', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
		// Set up mock GetSIStack response
		server.onCommand('GetSIStack', () => {
			server.send('ReplyGetSIStack', {
				stack: [
					{ description: 'foo[3]', filename: '/src/foo.aplf', fileline: 10 },
					{ description: '#.NS.bar[1]', filename: '', fileline: 0 },
				]
			});
		});
	});

	teardown(() => teardownTestRuntime(session, server));

	test('getSIStack resolves with parsed frames', async () => {
		const stack = await runtime.getSIStack();

		assert.strictEqual(stack.count, 2);
		assert.strictEqual(stack.frames[0].name, 'foo');
		assert.strictEqual(stack.frames[0].line, 13); // fileline 10 + lineOffset 3
		assert.strictEqual(stack.frames[0].file, '/src/foo.aplf');
		assert.strictEqual(stack.frames[1].name, '#.NS.bar');
		assert.strictEqual(stack.frames[1].line, 1); // fileline 0 + lineOffset 1
	});

	test('getSIStack uses linkMap for file resolution when filename is empty', async () => {
		(runtime as any)._linkMap = { '#.NS.bar': '/src/bar.aplf' };

		const stack = await runtime.getSIStack();

		// bar has empty filename in the stack, so linkMap should provide it
		assert.strictEqual(stack.frames[1].file, '/src/bar.aplf');
	});

	test('getSIStack deduplicates concurrent calls', async () => {
		let callCount = 0;
		server.onCommand('GetSIStack', () => {
			callCount++;
			server.send('ReplyGetSIStack', {
				stack: [{ description: 'foo[1]', filename: 'f', fileline: 0 }]
			});
		});

		// Fire two concurrent getSIStack calls
		const [s1, s2] = await Promise.all([
			runtime.getSIStack(),
			runtime.getSIStack(),
		]);

		// Both should resolve to the same result, but only one GetSIStack sent
		assert.strictEqual(callCount, 1, 'should only send one GetSIStack');
		assert.strictEqual(s1.count, 1);
		assert.strictEqual(s2.count, 1);
	});
});

suite('AplRuntime — autocomplete', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('getAutocomplete round-trip', async () => {
		server.onCommand('GetAutocomplete', (args: any) => {
			server.send('ReplyGetAutocomplete', {
				options: ['⎕IO', '⎕CT', '⎕PP'],
				token: args.token,
				skip: 0,
			});
		});

		const result = await runtime.getAutocomplete('⎕', 1, 42);
		assert.deepStrictEqual(result.options, ['⎕IO', '⎕CT', '⎕PP']);
	});
});

// ─── Lifecycle ──────────────────────────────────────────────────────

suite('AplRuntime — lifecycle', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('terminate clears autoDebug and detaches', () => {
		(runtime as any)._autoDebug = true;
		runtime.terminate();
		assert.strictEqual((runtime as any)._autoDebug, false);
		assert.strictEqual((runtime as any)._session, undefined);
		assert.strictEqual(session.hasDebugHandler, false);
	});

	test('detachFromSession clears session and debug handler', () => {
		assert.ok((runtime as any)._session);
		assert.ok(session.hasDebugHandler);

		runtime.detachFromSession();

		assert.strictEqual((runtime as any)._session, undefined);
		assert.strictEqual(session.hasDebugHandler, false);
	});

	test('noDebug mode suppresses breakpoint verification', async () => {
		(runtime as any)._noDebug = true;
		(runtime as any)._breakPoints.set('/test.aplf', [
			{ id: 1, line: 3, verified: false }
		]);

		// OpenWindow would normally trigger verifyBreakpoints
		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: '/test.aplf',
			text: ['Fn', 'line1', 'line2', 'line3'], stop: [3], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		const bps = (runtime as any)._breakPoints.get('/test.aplf');
		assert.strictEqual(bps[0].verified, false, 'noDebug should suppress verification');
	});
});

// ─── Breakpoint verification ────────────────────────────────────────

suite('AplRuntime — breakpoint verification via OpenWindow', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('OpenWindow stop lines verify matching breakpoints', async () => {
		// Pre-register a breakpoint with line matching a stop line
		const path = '/abs/test.aplf';
		(runtime as any)._breakPoints.set(path, [
			{ id: 1, line: 3, verified: false },
			{ id: 2, line: 7, verified: false },
		]);

		const verified: number[] = [];
		runtime.on('breakpointValidated', (bp: any) => verified.push(bp.id));

		// OpenWindow with stop=[3] should verify bp at line 3 but not line 7
		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: '/abs/test.aplf',
			text: ['Fn', 'line1', 'line2', 'line3'], stop: [3], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		const bps = (runtime as any)._breakPoints.get(path);
		assert.strictEqual(bps[0].verified, true, 'bp at line 3 should be verified');
		assert.strictEqual(bps[1].verified, false, 'bp at line 7 should remain unverified');
		assert.deepStrictEqual(verified, [1]);
	});

	test('already-verified breakpoints are not re-emitted', async () => {
		const path = '/abs/test.aplf';
		(runtime as any)._breakPoints.set(path, [
			{ id: 1, line: 3, verified: true }, // already verified
		]);

		const events: any[] = [];
		runtime.on('breakpointValidated', (bp: any) => events.push(bp));

		server.send('OpenWindow', {
			token: 1, name: 'Fn', filename: '/abs/test.aplf',
			text: ['Fn', 'line1', 'line2', 'line3'], stop: [3], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual(events.length, 0, 'should not re-emit for already-verified bp');
	});
});

// ─── Value tips ─────────────────────────────────────────────────────

suite('AplRuntime — value tips', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('getValueTip round-trip', async () => {
		server.onCommand('GetValueTip', (args: any) => {
			server.send('ValueTip', {
				token: args.token,
				tip: ['42'],
				class: 0,
				startCol: 0,
				endCol: 3,
			});
		});

		const tip = await runtime.getValueTip('X←42', 0, 100);
		assert.strictEqual(tip.token, 100);
	});

	test('getValueTip timeout resolves with undefined', async () => {
		// Don't respond — let the 500ms timeout expire
		server.onCommand('GetValueTip', () => {});

		const tip = await runtime.getValueTip('X←42', 0, 200);
		assert.strictEqual(tip, undefined);
	}).timeout(2000);
});

// ─── Tree list ──────────────────────────────────────────────────────

suite('AplRuntime — tree list', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('getTreeList round-trip', async () => {
		server.onCommand('TreeList', (args: any) => {
			server.send('ReplyTreeList', {
				nodeId: args.nodeId,
				names: ['var1', 'var2'],
				classes: [2, 3],
			});
		});

		const result = await runtime.getTreeList(0);
		assert.strictEqual(result.nodeId, 0);
		assert.deepStrictEqual(result.names, ['var1', 'var2']);
	});
});

// ─── Multiple windows (sparse array) ───────────────────────────────

suite('AplRuntime — multiple windows', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('windows are indexed by token, not sequential', async () => {
		server.send('OpenWindow', {
			token: 100, name: 'A', filename: 'A.aplf',
			text: ['A'], stop: [], trace: [], monitor: [],
		});
		server.send('OpenWindow', {
			token: 500, name: 'B', filename: 'B.aplf',
			text: ['B'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual((runtime as any)._windows[100].name, 'A');
		assert.strictEqual((runtime as any)._windows[500].name, 'B');
		assert.strictEqual((runtime as any)._windows[200], undefined);
		// Current window is the last one opened
		assert.strictEqual(runtime.currentWindow!.name, 'B');
		assert.strictEqual(runtime.winId, 500);
	});

	test('closing one window does not affect others', async () => {
		server.send('OpenWindow', {
			token: 1, name: 'A', filename: 'A.aplf',
			text: ['A'], stop: [], trace: [], monitor: [],
		});
		server.send('OpenWindow', {
			token: 2, name: 'B', filename: 'B.aplf',
			text: ['B'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('CloseWindow', { win: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual((runtime as any)._windows[1], undefined);
		assert.strictEqual((runtime as any)._windows[2].name, 'B');
	});

	test('SetHighlightLine updates correct window', async () => {
		server.send('OpenWindow', {
			token: 10, name: 'A', filename: 'A.aplf',
			text: ['A', 'line1', 'line2'], stop: [], trace: [], monitor: [],
		});
		server.send('OpenWindow', {
			token: 20, name: 'B', filename: 'B.aplf',
			text: ['B', 'line1'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('SetHighlightLine', { win: 10, line: 2 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.strictEqual((runtime as any)._windows[10].currentRow, 2);
		assert.strictEqual((runtime as any)._windows[20].currentRow, undefined);
	});

	test('SetHighlightLine for missing window does not crash', async () => {
		// No windows open — should silently skip the currentRow update
		server.send('SetHighlightLine', { win: 999, line: 5 });
		await new Promise(resolve => setTimeout(resolve, 50));
		// No crash = pass
	});

	test('_hasOpenWindows tracks window count', async () => {
		assert.strictEqual((runtime as any)._hasOpenWindows(), false);

		server.send('OpenWindow', {
			token: 1, name: 'A', filename: 'A.aplf',
			text: ['A'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual((runtime as any)._hasOpenWindows(), true);

		server.send('CloseWindow', { win: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.strictEqual((runtime as any)._hasOpenWindows(), false);
	});
});

// ─── Exception info ─────────────────────────────────────────────────

suite('AplRuntime — exception info', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('HadError stores last error info', async () => {
		assert.strictEqual(runtime.lastError, undefined);

		server.send('HadError', { dmx: 11, error: 1001 });
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepStrictEqual(runtime.lastError, { dmx: 11, error: 1001 });
	});

	test('HadError stores last error info with different error codes', async () => {
		server.send('HadError', { dmx: 5, error: 500 });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual(runtime.lastError, { dmx: 5, error: 500 });

		// Overwrite with new error
		server.send('HadError', { dmx: 99, error: 2000 });
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual(runtime.lastError, { dmx: 99, error: 2000 });
	});

	test('lastError persists after SetHighlightLine consumes _hadError', async () => {
		server.send('OpenWindow', {
			token: 1, name: 'Func', filename: 'func.aplf',
			text: ['Func', '1÷0'], stop: [], trace: [], monitor: [],
		});
		await new Promise(resolve => setTimeout(resolve, 50));

		server.send('HadError', { dmx: 11, error: 1001 });
		server.send('SetHighlightLine', { win: 1, line: 1 });
		await new Promise(resolve => setTimeout(resolve, 50));

		// _hadError is consumed (reset to 0) but lastError persists
		assert.strictEqual((runtime as any)._hadError, 0);
		assert.deepStrictEqual(runtime.lastError, { dmx: 11, error: 1001 });
	});
});

// ─── exec() timeout ─────────────────────────────────────────────────

suite('AplRuntime — exec timeout', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		({ server, session, runtime } = await createTestRuntime());
	});

	teardown(() => teardownTestRuntime(session, server));

	test('exec with awaitEcho resolves normally when echo is received', async () => {
		// Default mock auto-responds with EchoInput — this should resolve quickly
		await (runtime as any).exec(0, '1+1', 1);
		// No hang = pass
	});

	test('exec with awaitEcho resolves on timeout when echo is suppressed', async () => {
		// Use a short timeout so this test is fast
		(runtime as any)._execTimeoutMs = 200;

		// Suppress the echo so timeout kicks in
		server.onCommand('Execute', () => {
			// Don't send EchoInput — simulate interpreter not responding
		});

		const start = Date.now();
		await (runtime as any).exec(0, 'hung_command', 1);
		const elapsed = Date.now() - start;

		// Should have timed out (~200ms) rather than hung forever
		assert.ok(elapsed >= 150, `should have waited for timeout, took ${elapsed}ms`);
		assert.ok(elapsed < 2000, `should not have hung, took ${elapsed}ms`);
	});

	test('exec without awaitEcho resolves immediately', async () => {
		// Suppress echo to prove we don't wait
		server.onCommand('Execute', () => {});

		const start = Date.now();
		await (runtime as any).exec(0, '1+1');
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 100, `should resolve immediately, took ${elapsed}ms`);
	});
});
