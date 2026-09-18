import * as assert from 'assert';
import { AplDebugSession } from '../../debug/aplDebug';
import type { FileAccessor } from '../../debug/aplRuntime';

/**
 * Unit tests for AplDebugSession request handlers that were found broken
 * or incomplete in review:
 *
 *  - `pause` inherited the base class's no-op, so external clients (and
 *    the UI pause button) got a success response while the interpreter
 *    kept running. It must call the runtime's interrupt.
 *  - step/continue requests sent no `continued` event, so any observer
 *    other than the requester (e.g. VS Code's UI when a /debug client
 *    steps, or vice versa) kept showing stale paused state.
 *
 * The session is exercised directly: we swap in a fake runtime and
 * capture sendEvent/sendResponse on the instance, so no DAP stream or
 * interpreter is needed.
 */

const mockFileAccessor: FileAccessor = {
	isWindows: false,
	checkExists: async () => false,
	deleteFile: async () => { /* */ },
	readFile: async () => new Uint8Array(),
	writeFile: async () => { /* */ },
};

class FakeRuntime {
	public calls: string[] = [];
	public interrupt(): void { this.calls.push('interrupt'); }
	public continue(): void { this.calls.push('continue'); }
	public step(): void { this.calls.push('step'); }
	public stepIn(_targetId?: number): void { this.calls.push('stepIn'); }
	public stepOut(): void { this.calls.push('stepOut'); }
}

function createHarness() {
	const dbg = new AplDebugSession(mockFileAccessor) as any;
	const runtime = new FakeRuntime();
	dbg._runtime = runtime;
	const events: any[] = [];
	const responses: any[] = [];
	dbg.sendEvent = (e: any) => events.push(e);
	dbg.sendResponse = (r: any) => responses.push(r);
	return { dbg, runtime, events, responses };
}

suite('AplDebugSession — pause and continued events', () => {

	test('pauseRequest interrupts the runtime and responds', () => {
		const { dbg, runtime, responses } = createHarness();
		dbg.pauseRequest({ seq: 1, command: 'pause' }, { threadId: 1 });
		assert.deepStrictEqual(runtime.calls, ['interrupt']);
		assert.strictEqual(responses.length, 1, 'must acknowledge the request');
	});

	const flows: Array<[string, string, any]> = [
		['continueRequest', 'continue', { threadId: 1 }],
		['nextRequest', 'step', { threadId: 1 }],
		['stepInRequest', 'stepIn', { threadId: 1 }],
		['stepOutRequest', 'stepOut', { threadId: 1 }],
	];

	for (const [handler, runtimeCall, args] of flows) {
		test(`${handler} emits a continued event`, () => {
			const { dbg, runtime, events, responses } = createHarness();
			dbg[handler]({ seq: 1, command: handler.replace('Request', '') }, args);
			assert.deepStrictEqual(runtime.calls, [runtimeCall]);
			assert.strictEqual(responses.length, 1);
			const continued = events.filter(e => e.event === 'continued');
			assert.strictEqual(
				continued.length, 1,
				`${handler} must emit exactly one continued event so other ` +
				'attached clients (UI or external) leave the paused state',
			);
			assert.strictEqual(continued[0].body.threadId, 1);
		});
	}

	test('pauseRequest does NOT emit continued (execution is stopping, not resuming)', () => {
		const { dbg, events } = createHarness();
		dbg.pauseRequest({ seq: 1, command: 'pause' }, { threadId: 1 });
		assert.deepStrictEqual(events.filter(e => e.event === 'continued'), []);
	});
});
