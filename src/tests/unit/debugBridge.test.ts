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
