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
