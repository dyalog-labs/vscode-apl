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

	const setOpenDocs = (docs: unknown[]) => { (vscode.workspace as any).textDocuments = docs; };

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
		setOpenDocs([]);
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

	test('a breakpoint in an APL file the table does not know fetches the table again first', async () => {
		let refreshes = 0;
		session.refreshLinkInfo = async () => {
			refreshes++;
			seedLinkInfo(session, [...session.linkInfo, { aplName: '#.C', filePath: '/ws/C.aplf', startLine: 0 }]);
		};
		setOpenDocs([{ uri: vscode.Uri.file('/ws/C.aplf'), languageId: 'apl' }]);
		const added = bp('/ws/C.aplf', 1);
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.strictEqual(refreshes, 1);
		assert.deepStrictEqual(await sent(), [CLEAR_ALL_STOPS, "{}{0::0 ⋄ 1 ⎕STOP ⍵}'#.C'"]);
	});

	test('a fetch that changes the table syncs every file, not only the one that changed', async () => {
		seedLinkInfo(session, []);   // connected before anything was linked
		const rows = [...session.linkInfo, { aplName: '#.A.goo', filePath: A, startLine: 10 }, { aplName: '#.B', filePath: B, startLine: 0 }];
		session.refreshLinkInfo = async () => { seedLinkInfo(session, rows); };
		setOpenDocs([{ uri: vscode.Uri.file(A), languageId: 'apl' }]);
		const added = bp(A, 12);
		setBreakpoints([added, bp(B, 1)]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		const lines = await sent();
		assert.strictEqual(lines[0], CLEAR_ALL_STOPS);
		assert.ok(lines.includes("{}{0::0 ⋄ 2 ⎕STOP ⍵}'#.A.goo'"), 'the changed file is set');
		assert.ok(lines.includes("{}{0::0 ⋄ 1 ⎕STOP ⍵}'#.B'"), 'so is the file whose breakpoint was already there');
	});

	test('a fetch that finds nothing new syncs only the file that changed', async () => {
		session.refreshLinkInfo = async () => { seedLinkInfo(session, [...session.linkInfo]); };
		setOpenDocs([{ uri: vscode.Uri.file('/ws/scratch.apl'), languageId: 'apl' }]);
		const added = bp('/ws/scratch.apl', 1);
		setBreakpoints([added, bp(B, 1)]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.deepStrictEqual(await sent(), [], 'an unlinked file has nothing to set, and the rest is left alone');
	});

	test('the session going away during the fetch ends the change quietly', async () => {
		session.refreshLinkInfo = async () => { sync.detachFromSession(); };
		setOpenDocs([{ uri: vscode.Uri.file('/ws/C.aplf'), languageId: 'apl' }]);
		const added = bp('/ws/C.aplf', 1);
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.deepStrictEqual(await sent(), []);
	});

	test('a debug session that starts during the fetch keeps the sync out of its way', async () => {
		session.refreshLinkInfo = async () => {
			seedLinkInfo(session, [...session.linkInfo, { aplName: '#.C', filePath: '/ws/C.aplf', startLine: 0 }]);
			(sync as any)._debugSessionActive = true;
		};
		setOpenDocs([{ uri: vscode.Uri.file('/ws/C.aplf'), languageId: 'apl' }]);
		const added = bp('/ws/C.aplf', 1);
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.deepStrictEqual(await sent(), []);
	});

	test('a breakpoint in a file of another language neither fetches the table nor sends anything', async () => {
		let refreshes = 0;
		session.refreshLinkInfo = async () => { refreshes++; };
		setOpenDocs([{ uri: vscode.Uri.file('/ws/notes.ts'), languageId: 'typescript' }]);
		const added = bp('/ws/notes.ts', 1);
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.strictEqual(refreshes, 0);
		assert.deepStrictEqual(await sent(), []);
	});

	test('a breakpoint in a known file uses the table as it is', async () => {
		let refreshes = 0;
		session.refreshLinkInfo = async () => { refreshes++; };
		const added = bp(B, 1);
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.strictEqual(refreshes, 0);
		assert.deepStrictEqual(await sent(), ["{}{0::0 ⋄ 1 ⎕STOP ⍵}'#.B'"]);
	});

	test('while a query that got no reply waits for its retry, an unknown file does not fetch the table again', async () => {
		let refreshes = 0;
		session.refreshLinkInfo = async () => { refreshes++; };
		(session as any)._linkInfoRetryAt = Date.now() + 60000;
		const added = bp('/ws/C.aplf', 1);
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });

		assert.strictEqual(refreshes, 0);
	});

	test('breakpoints in apl: documents are not the file sync\'s business', async () => {
		let refreshes = 0;
		session.refreshLinkInfo = async () => { refreshes++; };
		const added = new vscode.SourceBreakpoint({
			uri: vscode.Uri.from({ scheme: 'apl', path: '/Session 1/foo.apl' }),
			range: new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 0)),
		});
		setBreakpoints([added]);

		await (sync as any)._onBreakpointsChanged({ added: [added], removed: [], changed: [] });
		(sync as any)._syncAllBreakpoints();

		assert.strictEqual(refreshes, 0);
		assert.deepStrictEqual(await sent(), [CLEAR_ALL_STOPS], 'the full sync sends only its clear line');
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
