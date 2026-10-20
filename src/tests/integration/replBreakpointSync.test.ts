import assert = require('assert');
import * as vscode from 'vscode';
import { AplSession } from '../../session/aplSession';
import { CLEAR_ALL_STOPS, MAX_INPUT_LINE } from '../../session/linkBreakpoints';
import { ReplBreakpointSync } from '../../repl/replBreakpointSync';
import { MockRideServer } from '../helpers/mockRideServer';
import { seedLinkInfo } from '../helpers/sessionTestUtils';

/**
 * ReplBreakpointSync against a mock RIDE server: the input lines it sends.
 * The stub's `debug.breakpoints` is a plain array filled directly and its
 * events are no-ops, so the private sync methods are called by hand.
 */
suite('ReplBreakpointSync — ⎕STOP lines sent to the interpreter', () => {
	const A = '/ws/A.apln';
	const B = '/ws/B.aplf';
	let server: MockRideServer;
	let session: AplSession;
	let sync: ReplBreakpointSync;

	function bp(file: string, line: number, enabled = true): vscode.SourceBreakpoint {
		return new vscode.SourceBreakpoint({
			uri: vscode.Uri.file(file),
			range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0)),
		}, enabled);
	}

	function setBreakpoints(bps: vscode.SourceBreakpoint[]) {
		(vscode.debug as unknown as { breakpoints: vscode.Breakpoint[] }).breakpoints = bps;
	}

	/** The texts of the Execute messages received, once the mock has been quiet for 150 ms. */
	async function sent(): Promise<string[]> {
		const count = () => server.getReceived('Execute').length;
		let last = -1;
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			const before = count();
			await new Promise(r => setTimeout(r, 150));
			if (count() === before && before === last) { break; }
			last = count();
		}
		return server.getReceived('Execute').map((m: { text: string }) => m.text.replace(/\n$/, ''));
	}

	setup(async () => {
		server = new MockRideServer();
		await server.start();
		session = new AplSession();
		const ready = new Promise<void>(r => session.once('ready', r));
		await session.connect('127.0.0.1', server.port);
		await ready;
		sync = new ReplBreakpointSync();
		(sync as unknown as { _session: AplSession })._session = session;
		seedLinkInfo(session, [
			{ aplName: '#.A', filePath: A, startLine: 0 },        // the namespace itself
			{ aplName: '#.A.foo', filePath: A, startLine: 2 },
			{ aplName: '#.A.goo', filePath: A, startLine: 10 },
			{ aplName: '#.B', filePath: B, startLine: 0 },
		]);
	});

	teardown(() => {
		setBreakpoints([]);
		sync.dispose();
		session.disconnect();
		server.stop();
	});

	test('full sync: one interpreter-side clear line, then one line per file with breakpoints', async () => {
		setBreakpoints([bp(A, 12), bp(B, 1)]);

		(sync as any)._syncAllBreakpoints();

		const lines = await sent();
		assert.strictEqual(lines.length, 3, `expected clear-all + 2 set lines, got:\n${lines.join('\n')}`);
		assert.strictEqual(lines[0], CLEAR_ALL_STOPS);
		assert.ok(lines.includes("{}{0::0 ⋄ 2 ⎕STOP ⍵}'#.A.goo'"), 'goo gets line 12-10');
		assert.ok(lines.includes("{}{0::0 ⋄ 1 ⎕STOP ⍵}'#.B'"), 'B gets line 1');
		assert.ok(!lines.slice(1).some(l => l.includes('⍬ ⎕STOP')), 'no per-function clears after the clear-all');
	});

	test('full sync with no breakpoints is just the clear-all line', async () => {
		setBreakpoints([]);

		(sync as any)._syncAllBreakpoints();

		assert.deepStrictEqual(await sent(), [CLEAR_ALL_STOPS]);
	});

	test('full sync sends nothing when the link table is empty', async () => {
		seedLinkInfo(session, []);
		setBreakpoints([bp(A, 12)]);

		(sync as any)._syncAllBreakpoints();

		assert.deepStrictEqual(await sent(), []);
	});

	test('single-file change: clears and sets for that file in one line', async () => {
		setBreakpoints([bp(A, 12)]);

		(sync as any)._syncBreakpointsForFile(A);

		const lines = await sent();
		assert.strictEqual(lines.length, 1, `expected one packed line, got:\n${lines.join('\n')}`);
		assert.ok(lines[0].includes("⍬ ⎕STOP ⍵}'#.A' ⋄ ") && lines[0].includes("⍬ ⎕STOP ⍵}'#.A.foo'"), 'clears the namespace row and foo');
		assert.ok(lines[0].includes("2 ⎕STOP ⍵}'#.A.goo'"), 'sets goo');
		assert.ok(!lines[0].includes("'#.B'"), 'does not touch other files');
	});

	test('single-file change with all breakpoints removed only clears', async () => {
		setBreakpoints([]);

		(sync as any)._syncBreakpointsForFile(A);

		assert.deepStrictEqual(await sent(), [
			"{}{0::0 ⋄ ⍬ ⎕STOP ⍵}'#.A' ⋄ {}{0::0 ⋄ ⍬ ⎕STOP ⍵}'#.A.foo' ⋄ {}{0::0 ⋄ ⍬ ⎕STOP ⍵}'#.A.goo'",
		]);
	});

	test('disabled breakpoints count as absent', async () => {
		setBreakpoints([bp(B, 1, false)]);

		(sync as any)._syncBreakpointsForFile(B);

		assert.deepStrictEqual(await sent(), ["{}{0::0 ⋄ ⍬ ⎕STOP ⍵}'#.B'"]);
	});

	test('a file with hundreds of functions needs far fewer lines than functions, each within the limit', async () => {
		const rows = Array.from({ length: 300 }, (_, i) => ({ aplName: `#.Big.fn${i}`, filePath: '/ws/Big.apln', startLine: i * 5 }));
		seedLinkInfo(session, rows);
		setBreakpoints([bp('/ws/Big.apln', 7)]);   // inside fn1

		(sync as any)._syncBreakpointsForFile('/ws/Big.apln');

		const lines = await sent();
		assert.ok(lines.length <= 30, `300 functions should take a few dozen lines, not ${lines.length}`);
		for (const l of lines) { assert.ok(l.length <= MAX_INPUT_LINE, `line of ${l.length} chars exceeds the limit`); }
		const all = lines.join(' ');
		assert.ok(all.includes("2 ⎕STOP ⍵}'#.Big.fn1'"), 'fn1 gets line 7-5');
		assert.ok(all.includes("'#.Big.fn299'"), 'every function appears');
		assert.ok(!all.includes("⍬ ⎕STOP ⍵}'#.Big.fn1'"), 'fn1 is set, not cleared');
	});
});
