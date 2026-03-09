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

suite('AplRuntime — breakpoint handling', () => {
	let server: MockRideServer;
	let session: AplSession;
	let runtime: AplRuntime;

	setup(async () => {
		server = new MockRideServer();
		await server.start();
		session = new AplSession();

		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		runtime = new AplRuntime(mockFileAccessor);
		(runtime as any)._session = session;

		// Wire up the debug handler so EchoInput flows back to runtime
		session.setDebugHandler((command: string, args: any) => {
			(runtime as any).handleMessage([command, args]);
		});
	});

	teardown(() => {
		session.clearDebugHandler();
		session.disconnect();
		server.stop();
	});

	// --- Control test: breakpoint AFTER header line works fine ---

	test('breakpoint after header line is matched and verified', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'MyFunc', filePath: '/test/file.aplf', startLine: 5 }
		];

		const bp = await runtime.setBreakPoint('/test/file.aplf', 6);

		assert.strictEqual(bp.verified, true, 'breakpoint after header should be verified');

		const execMsgs = server.getReceived('Execute');
		const stopCmd = execMsgs.find((m: any) => m.text.includes('⎕STOP'));
		assert.ok(stopCmd, 'should have sent ⎕STOP to interpreter');
	});

	// --- This test exposes the off-by-one bug (startLine < bp.line should be <=) ---

	test('breakpoint on function header line is matched', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'MyFunc', filePath: '/test/file.aplf', startLine: 5 }
		];

		// Breakpoint on the header line itself
		const bp = await runtime.setBreakPoint('/test/file.aplf', 5);

		assert.strictEqual(bp.verified, true,
			'breakpoint on header line should be verified (bug: startLine < bp.line should be <=)');
	});

	// --- clearBreakpoints sends ⎕STOP clear commands ---

	test('clearBreakpoints sends clear commands for all functions in file', async () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/test/file.aplf', startLine: 0 },
			{ aplName: 'Fn2', filePath: '/test/file.aplf', startLine: 20 },
		];

		// Set breakpoints first so there's something to clear
		await runtime.setBreakPoint('/test/file.aplf', 5);
		await runtime.setBreakPoint('/test/file.aplf', 25);

		// Record messages from this point
		const countBefore = server.received.length;

		await runtime.clearBreakpoints('/test/file.aplf');

		const newMsgs = server.received.slice(countBefore);
		const clearCmds = newMsgs
			.filter(([cmd]: [string, any]) => cmd === 'Execute')
			.filter(([, args]: [string, any]) => args.text.includes('⍬ ⎕STOP'));

		assert.strictEqual(clearCmds.length, 2,
			`should send clear ⎕STOP for both functions, got ${clearCmds.length}`);
	});

	// --- clearBreakpoints is fire-and-forget (demonstrates the design issue) ---

	test('clearBreakpoints returns void not Promise', () => {
		(runtime as any)._linkInfo = [
			{ aplName: 'Fn1', filePath: '/test/file.aplf', startLine: 0 },
		];

		const result: any = runtime.clearBreakpoints('/test/file.aplf');
		// This is the bug: callers can't await the clear
		assert.ok(result && typeof result.then === 'function',
			'clearBreakpoints should return a thenable so callers can await it');
	});
});
