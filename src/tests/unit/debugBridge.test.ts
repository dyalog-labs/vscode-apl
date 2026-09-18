import * as assert from 'assert';
import * as vscode from 'vscode';
import { VsCodeDebugBridge } from '../../debug/debugBridge';

/**
 * Unit tests for VsCodeDebugBridge against the vscode stub.
 *
 * The headline behaviour is `setBreakpoints` interception: sending it
 * straight to the adapter would change the adapter's breakpoints while
 * VS Code's breakpoint model (gutter dots, Breakpoints panel, the
 * post-debug ⎕STOP sync in replBreakpointSync) kept the old ones — the
 * next gutter click or sync would silently revert the external change.
 * The bridge must instead update VS Code's model and let VS Code
 * propagate to the adapter, keeping one source of truth.
 */

suite('VsCodeDebugBridge', () => {
	let bridge: VsCodeDebugBridge;

	setup(() => {
		(vscode.debug as any).breakpoints = [];
		(vscode.debug as any).activeDebugSession = undefined;
		bridge = new VsCodeDebugBridge();
	});

	teardown(() => {
		bridge.dispose();
	});

	suite('setBreakpoints goes through the VS Code model', () => {
		const FILE = '/ws/src/Foo.aplf';
		const OTHER_FILE = '/ws/src/Bar.aplf';
		// These model-only tests have no adapter to acknowledge propagation.
		setup(() => { bridge.propagationTimeoutMs = 10; });

		function modelLines(path: string): number[] {
			return (vscode.debug.breakpoints as any[])
				.filter(bp => bp.location?.uri?.fsPath === path)
				.map(bp => bp.location.range.start.line + 1); // back to 1-based
		}

		test('adds model breakpoints for the requested lines', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 2 }, { line: 5 }],
			});
			assert.deepStrictEqual(modelLines(FILE), [2, 5]);
		});

		test('replaces existing model breakpoints for that file only', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			const uri = (vscode as any).Uri.file(FILE);
			const otherUri = (vscode as any).Uri.file(OTHER_FILE);
			const mk = (u: any, line0: number) => new (vscode as any).SourceBreakpoint(
				new (vscode as any).Location(u, new (vscode as any).Position(line0, 0)));
			vscode.debug.addBreakpoints([mk(uri, 1), mk(otherUri, 7)]);

			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 3 }],
			});

			assert.deepStrictEqual(modelLines(FILE), [3], 'target file replaced');
			assert.deepStrictEqual(modelLines(OTHER_FILE), [8], 'other files untouched');
		});

		test('never sends setBreakpoints to the adapter directly', async () => {
			const forwarded: string[] = [];
			(bridge as any)._session = {
				customRequest: async (cmd: string) => { forwarded.push(cmd); return {}; },
			};
			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 1 }],
			});
			assert.deepStrictEqual(
				forwarded, [],
				'VS Code propagates model changes itself; a direct send would desync',
			);
		});

		test('empty breakpoints array clears the file', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 4 }],
			});
			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [],
			});
			assert.deepStrictEqual(modelLines(FILE), []);
		});

		test('reply reports the accepted lines (verification is async via events)', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			const result: any = await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 2 }, { line: 9 }],
			});
			assert.deepStrictEqual(result.breakpoints.map((b: any) => b.line), [2, 9]);
		});

		test('missing source.path is an error', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			await assert.rejects(
				bridge.request('setBreakpoints', { breakpoints: [{ line: 1 }] }),
				/source\.path/,
			);
		});

		// A malformed request must fail BEFORE the existing breakpoints are
		// removed — clear-then-validate turns a client typo into silent
		// destruction of the user's gutter breakpoints.

		test('non-array breakpoints payload leaves existing breakpoints intact', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 2 }],
			});
			await assert.rejects(bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: {} as any,
			}));
			assert.deepStrictEqual(modelLines(FILE), [2], 'existing breakpoints must survive');
		});

		test('invalid line numbers are rejected without clearing', async () => {
			(bridge as any)._session = { customRequest: async () => ({}) };
			await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 4 }],
			});
			for (const bad of [{ line: 0 }, { line: -3 }, { line: 1.5 }, { line: 'x' as any }, {}]) {
				await assert.rejects(
					bridge.request('setBreakpoints', { source: { path: FILE }, breakpoints: [bad as any] }),
					/line/i,
					`line ${JSON.stringify(bad)} must be rejected`,
				);
			}
			assert.deepStrictEqual(modelLines(FILE), [4], 'existing breakpoints must survive');
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// SETBREAKPOINTS COMPLETION BARRIER
	//
	// Updating VS Code's model returns before VS Code has forwarded the
	// change to the adapter — a client that fires `setBreakpoints` then
	// `continue` can resume on the OLD stops. The bridge must hold the
	// reply until it observes the adapter's own setBreakpoints response
	// for that file (the tracker sees both directions), and return that
	// real body — verified flags and breakpoint ids included. If nothing
	// arrives (adapter gone, VS Code coalesced the change away), fall
	// back to the old optimistic reply after a timeout rather than hang.
	// ─────────────────────────────────────────────────────────────────────

	suite('setBreakpoints completion barrier', () => {
		const FILE = '/ws/src/Foo.aplf';

		function aplTracker(session: any) {
			const entry = (vscode.debug as any).trackerFactories
				.filter((f: any) => f.type === 'apl').pop();
			return entry.factory.createDebugAdapterTracker(session);
		}

		function setup_(sessionOverrides: any = {}) {
			const session = { type: 'apl', customRequest: async () => ({}), ...sessionOverrides };
			(bridge as any)._session = session;
			const tracker = aplTracker(session);
			return { session, tracker };
		}

		test('reply is held until the adapter responds, then carries the real body', async () => {
			const { tracker } = setup_();
			const pending = bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 2 }, { line: 5 }],
			});

			let settled = false;
			void pending.then(() => { settled = true; });
			await new Promise(r => setImmediate(r));
			assert.strictEqual(settled, false, 'must not reply before the adapter has the stops');

			// VS Code propagates the model change to the adapter…
			tracker.onWillReceiveMessage({
				type: 'request', seq: 7, command: 'setBreakpoints',
				arguments: { source: { path: FILE }, breakpoints: [{ line: 2 }, { line: 5 }] },
			});
			// …and the adapter answers with the authoritative result.
			const body = { breakpoints: [
				{ id: 1, line: 2, verified: true },
				{ id: 2, line: 5, verified: false },
			] };
			tracker.onDidSendMessage({
				type: 'response', request_seq: 7, command: 'setBreakpoints', success: true, body,
			});

			assert.deepStrictEqual(await pending, body, 'client must get the adapter result, not a guess');
		});

		test('replacement ignores intermediate clear and partial-removal responses', async () => {
			const { tracker } = setup_();
			const uri = vscode.Uri.file(FILE);
			vscode.debug.addBreakpoints([2, 4].map(line => new vscode.SourceBreakpoint(
				new vscode.Location(uri, new vscode.Position(line - 1, 0)))));
			const pending = bridge.request('setBreakpoints', {
				source: { path: FILE }, breakpoints: [{ line: 9 }, { line: 5 }],
			});
			let settled = false;
			void pending.then(() => { settled = true; });

			for (const [seq, lines] of [[1, [4]], [2, []]] as Array<[number, number[]]>) {
				tracker.onWillReceiveMessage({
					type: 'request', seq, command: 'setBreakpoints',
					arguments: { source: { path: FILE }, breakpoints: lines.map(line => ({ line })) },
				});
				tracker.onDidSendMessage({
					type: 'response', request_seq: seq, command: 'setBreakpoints', success: true,
					body: { breakpoints: lines.map(line => ({ line, verified: true })) },
				});
				await new Promise(r => setImmediate(r));
				assert.strictEqual(settled, false, 'removal must not complete the replacement');
			}

			// VS Code may sort the requested lines before forwarding them.
			tracker.onWillReceiveMessage({
				type: 'request', seq: 3, command: 'setBreakpoints',
				arguments: { source: { path: FILE }, breakpoints: [{ line: 5 }, { line: 9 }] },
			});
			await new Promise(r => setImmediate(r));
			assert.strictEqual(settled, false, 'the replacement must also be acknowledged');
			const body = { breakpoints: [{ id: 5, line: 5, verified: true }, { id: 9, line: 9, verified: true }] };
			tracker.onDidSendMessage({
				type: 'response', request_seq: 3, command: 'setBreakpoints', success: true, body,
			});
			assert.deepStrictEqual(await pending, body);
		});

		test('clearing waits for the final empty set, not an intermediate removal', async () => {
			const { tracker } = setup_();
			const uri = vscode.Uri.file(FILE);
			vscode.debug.addBreakpoints([2, 4].map(line => new vscode.SourceBreakpoint(
				new vscode.Location(uri, new vscode.Position(line - 1, 0)))));
			const pending = bridge.request('setBreakpoints', { source: { path: FILE }, breakpoints: [] });
			let settled = false;
			void pending.then(() => { settled = true; });
			tracker.onWillReceiveMessage({
				type: 'request', seq: 1, command: 'setBreakpoints',
				arguments: { source: { path: FILE }, breakpoints: [{ line: 4 }] },
			});
			tracker.onDidSendMessage({
				type: 'response', request_seq: 1, command: 'setBreakpoints', success: true,
				body: { breakpoints: [{ line: 4, verified: true }] },
			});
			await new Promise(r => setImmediate(r));
			assert.strictEqual(settled, false);
			tracker.onWillReceiveMessage({
				type: 'request', seq: 2, command: 'setBreakpoints',
				arguments: { source: { path: FILE }, breakpoints: [] },
			});
			tracker.onDidSendMessage({
				type: 'response', request_seq: 2, command: 'setBreakpoints', success: true,
				body: { breakpoints: [] },
			});
			assert.deepStrictEqual(await pending, { breakpoints: [] });
		});

		test('retains requested stops while removing other lines', async () => {
			const { tracker } = setup_();
			const uri = vscode.Uri.file(FILE);
			const retained = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(3, 0)));
			vscode.debug.addBreakpoints([
				new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(1, 0))), retained,
			]);
			const pending = bridge.request('setBreakpoints', { source: { path: FILE }, breakpoints: [{ line: 4 }] });
			assert.deepStrictEqual(vscode.debug.breakpoints, [retained], 'the requested stop must not be removed and re-added');
			tracker.onWillReceiveMessage({
				type: 'request', seq: 1, command: 'setBreakpoints',
				arguments: { source: { path: FILE }, breakpoints: [{ line: 4 }] },
			});
			const body = { breakpoints: [{ id: 4, line: 4, verified: true }] };
			tracker.onDidSendMessage({ type: 'response', request_seq: 1, command: 'setBreakpoints', success: true, body });
			assert.deepStrictEqual(await pending, body);
		});

		test('an identical request shares the pending propagation', async () => {
			const { tracker } = setup_();
			const args = { source: { path: FILE }, breakpoints: [{ line: 2 }] };
			const first = bridge.request('setBreakpoints', args);
			const second = bridge.request('setBreakpoints', args);
			let settled = false;
			void second.then(() => { settled = true; });
			await new Promise(r => setImmediate(r));
			assert.strictEqual(settled, false, 'the model is updated but the adapter still has the old stops');
			tracker.onWillReceiveMessage({ type: 'request', seq: 1, command: 'setBreakpoints', arguments: args });
			const body = { breakpoints: [{ id: 1, line: 2, verified: true }] };
			tracker.onDidSendMessage({ type: 'response', request_seq: 1, command: 'setBreakpoints', success: true, body });
			assert.deepStrictEqual(await Promise.all([first, second]), [body, body]);
		});

		test('unrelated adapter traffic does not release the reply', async () => {
			const { tracker } = setup_();
			(bridge as any).propagationTimeoutMs = 200;
			const pending = bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 3 }],
			});

			// A request for a DIFFERENT file, and a response to a DIFFERENT seq.
			tracker.onWillReceiveMessage({
				type: 'request', seq: 8, command: 'setBreakpoints',
				arguments: { source: { path: '/ws/src/Bar.aplf' } },
			});
			tracker.onDidSendMessage({
				type: 'response', request_seq: 99, command: 'setBreakpoints', success: true,
				body: { breakpoints: [{ id: 9, line: 1, verified: true }] },
			});
			tracker.onDidSendMessage({
				type: 'response', request_seq: 8, command: 'setBreakpoints', success: true,
				body: { breakpoints: [{ id: 9, line: 1, verified: true }] },
			});

			// None of the above match our file → the timeout fallback fires.
			const reply: any = await pending;
			assert.deepStrictEqual(reply.breakpoints, [{ line: 3, verified: false }]);
		});

		test('falls back to the optimistic reply when the adapter never answers', async () => {
			setup_();
			(bridge as any).propagationTimeoutMs = 50;
			const reply: any = await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 2 }],
			});
			assert.deepStrictEqual(reply.breakpoints, [{ line: 2, verified: false }]);
		});

		test("another session's setBreakpoints response does not settle the waiter", async () => {
			const { tracker } = setup_();
			(bridge as any).propagationTimeoutMs = 100;
			const otherTracker = aplTracker({ type: 'apl' }); // NOT the tracked session
			const pending = bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [{ line: 2 }],
			});

			otherTracker.onWillReceiveMessage({
				type: 'request', seq: 3, command: 'setBreakpoints',
				arguments: { source: { path: FILE } },
			});
			otherTracker.onDidSendMessage({
				type: 'response', request_seq: 3, command: 'setBreakpoints', success: true,
				body: { breakpoints: [{ id: 5, line: 2, verified: true }] },
			});

			const reply: any = await pending;
			assert.deepStrictEqual(
				reply.breakpoints, [{ line: 2, verified: false }],
				'must time out rather than accept a foreign session\'s response',
			);
			// keep the real tracker referenced so linters don't flag it
			void tracker;
		});

		test('clearing when nothing exists replies immediately (no VS Code traffic to wait for)', async () => {
			setup_();
			(bridge as any).propagationTimeoutMs = 5000; // would hang the test if waited on
			const start = Date.now();
			const reply: any = await bridge.request('setBreakpoints', {
				source: { path: FILE },
				breakpoints: [],
			});
			assert.deepStrictEqual(reply, { breakpoints: [] });
			assert.ok(Date.now() - start < 1000, 'no-op must not wait for a propagation that will never come');
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// EVENT FILTERING BY SESSION
	//
	// The tracker factory sees every `apl` session. Events must only be
	// re-emitted for the session the bridge tracks — otherwise a second
	// concurrent debug session's stopped/terminated events leak to
	// listeners who then step the wrong session.
	// ─────────────────────────────────────────────────────────────────────

	suite('event filtering by session', () => {
		function createTracker(session: any) {
			const entry = (vscode.debug as any).trackerFactories
				.filter((f: any) => f.type === 'apl').pop();
			assert.ok(entry, 'bridge must register a tracker factory for apl');
			return entry.factory.createDebugAdapterTracker(session);
		}

		test("re-emits events only from the bridge's own session", () => {
			const sessionA = { type: 'apl' };
			const sessionB = { type: 'apl' };
			(bridge as any)._session = sessionA;

			const events: any[] = [];
			bridge.on('dap', (e: any) => events.push(e));

			createTracker(sessionA).onDidSendMessage({ type: 'event', event: 'stopped' });
			createTracker(sessionB).onDidSendMessage({ type: 'event', event: 'terminated' });

			assert.deepStrictEqual(
				events.map(e => e.event), ['stopped'],
				"another session's events must not reach listeners",
			);
		});

		test('tracker creation adopts the session when none is tracked', () => {
			// Covers /debug listen before any /debug start: the first apl
			// session VS Code spins up becomes the tracked one, and its
			// events flow — previously they were dropped.
			const s = { type: 'apl' };
			const events: any[] = [];
			bridge.on('dap', (e: any) => events.push(e));

			const tracker = createTracker(s);
			assert.strictEqual((bridge as any)._session, s, 'tracker must adopt the session');
			tracker.onDidSendMessage({ type: 'event', event: 'initialized' });
			assert.deepStrictEqual(events.map(e => e.event), ['initialized']);
		});

		test('non-event messages are not re-emitted', () => {
			const s = { type: 'apl' };
			(bridge as any)._session = s;
			const events: any[] = [];
			bridge.on('dap', (e: any) => events.push(e));
			createTracker(s).onDidSendMessage({ type: 'response', command: 'next' });
			assert.deepStrictEqual(events, []);
		});
	});

	suite('other requests', () => {
		test('forwarded to the tracked session via customRequest', async () => {
			const calls: Array<{ cmd: string; args: unknown }> = [];
			(bridge as any)._session = {
				customRequest: async (cmd: string, args: unknown) => {
					calls.push({ cmd, args });
					return { ok: 1 };
				},
			};
			const result = await bridge.request('stackTrace', { threadId: 1 });
			assert.deepStrictEqual(calls, [{ cmd: 'stackTrace', args: { threadId: 1 } }]);
			assert.deepStrictEqual(result, { ok: 1 });
		});

		test('rejects when no session is tracked', async () => {
			await assert.rejects(bridge.request('next', { threadId: 1 }), /no active/i);
		});
	});
});
