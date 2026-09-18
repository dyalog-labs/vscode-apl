import * as assert from 'assert';
import * as Net from 'net';
import { EventEmitter } from 'events';
import { EvalServer } from '../../repl/evalServer';

/**
 * Tests for the eval server's `/debug` meta-commands — the channel that
 * lets an external client (aple, agents) drive a REAL VS Code debug
 * session, so the user sees the debugger fire in the UI while the client
 * steps it.
 *
 * The EvalServer never talks to vscode.debug directly; it goes through a
 * `DebugBridge` injected at construction. These tests exercise the wire
 * protocol against a fake bridge:
 *
 *   /debug                      → usage text
 *   /debug start [json]         → bridge.start(merged launch config)
 *   /debug stop                 → bridge.stop()
 *   /debug status               → active / no session
 *   /debug listen               → subscribe socket to DAP events (pushed
 *                                 as JSON, one \0-terminated message each)
 *   /debug <dapCommand> [json]  → bridge.request(command, args); reply is
 *                                 the response body as JSON. Step/flow
 *                                 commands default to {"threadId":1}.
 *
 * Every reply is \0-terminated like the rest of the protocol. `/debug`
 * commands take the meta-command path, so they must work even while an
 * eval is in flight — that's what makes `pause` useful.
 */

class FakeSession extends EventEmitter {
	public executed: string[] = [];
	public isConnected = true;
	public outputs: Record<string, string> = {};
	public defaultOutput = '';
	public autoReady = true;

	public execute(expr: string): void {
		this.executed.push(expr);
		if (!this.autoReady) { return; }
		const output = expr in this.outputs ? this.outputs[expr] : this.defaultOutput;
		setImmediate(() => {
			this.emit('output', output);
			this.emit('ready');
		});
	}
}

class FakeReplManager {
	public session: FakeSession | undefined;
	public get activeSession(): FakeSession | undefined { return this.session; }
	public get activeTab(): undefined { return undefined; }
	public getTabList(): [] { return []; }
	public getTab(_id: string): undefined { return undefined; }
	public switchToTab(_id: string): void { /* */ }
}

/** In-memory stand-in for the vscode.debug-backed bridge. */
class FakeDebugBridge extends EventEmitter {
	public active = false;
	public startCalls: Array<Record<string, unknown>> = [];
	public stopCalls = 0;
	public requests: Array<{ command: string; args: unknown }> = [];
	/** What start() resolves to; false simulates vscode refusing to launch. */
	public startResult = true;
	/** Delay before start() resolves — lets tests race concurrent starts. */
	public startDelayMs = 0;
	/** Per-command canned responses for request(). */
	public responses: Record<string, unknown> = {};
	/** When set, request() rejects with this message. */
	public failWith?: string;

	public isActive(): boolean { return this.active; }

	public async start(config: Record<string, unknown>): Promise<boolean> {
		this.startCalls.push(config);
		if (this.startDelayMs) { await new Promise(r => setTimeout(r, this.startDelayMs)); }
		if (this.startResult) { this.active = true; }
		return this.startResult;
	}

	public async stop(): Promise<void> {
		this.stopCalls++;
		this.active = false;
	}

	public async request(command: string, args?: unknown): Promise<unknown> {
		this.requests.push({ command, args });
		if (this.failWith) { throw new Error(this.failWith); }
		return command in this.responses ? this.responses[command] : {};
	}
}

function connect(port: number): Promise<Net.Socket> {
	return new Promise((resolve, reject) => {
		const sock = Net.createConnection({ port, host: '127.0.0.1' });
		sock.once('connect', () => resolve(sock));
		sock.once('error', reject);
	});
}

/** Collect NUL-delimited messages until `count` of them arrive, or timeout. */
function readMessages(sock: Net.Socket, count: number, timeoutMs = 1500): Promise<string[]> {
	return new Promise((resolve) => {
		const messages: string[] = [];
		let buf = '';
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			let nul: number;
			while ((nul = buf.indexOf('\0')) !== -1) {
				messages.push(buf.slice(0, nul));
				buf = buf.slice(nul + 1);
				if (messages.length >= count) { resolve(messages); return; }
			}
		};
		sock.on('data', onData);
		sock.once('close', () => resolve(messages));
		setTimeout(() => resolve(messages), timeoutMs);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

suite('EvalServer /debug', () => {
	let manager: FakeReplManager;
	let session: FakeSession;
	let bridge: FakeDebugBridge;
	let server: EvalServer;
	let port: number;

	setup(async () => {
		manager = new FakeReplManager();
		session = new FakeSession();
		manager.session = session;
		bridge = new FakeDebugBridge();
		server = new EvalServer(manager as any, bridge as any);
		port = await server.start(0);
	});

	teardown(async () => {
		try { await server.stop(); } catch { /* already stopped */ }
	});

	/** One-shot: send a line, read one reply. */
	async function send(line: string): Promise<string> {
		const sock = await connect(port);
		sock.write(line + '\n');
		const [reply] = await readMessages(sock, 1);
		sock.destroy();
		return reply;
	}

	// ─────────────────────────────────────────────────────────────────────
	// AVAILABILITY / USAGE
	// ─────────────────────────────────────────────────────────────────────

	suite('availability', () => {
		test('/debug alone returns usage', async () => {
			const reply = await send('/debug');
			assert.match(reply, /Usage/i);
			assert.match(reply, /start/);
			assert.match(reply, /listen/);
		});

		test('replies [Debug unavailable] when no bridge is configured', async () => {
			// A server constructed the old way (no bridge) must not crash.
			const bare = new EvalServer(manager as any);
			const barePort = await bare.start(0);
			try {
				const sock = await connect(barePort);
				sock.write('/debug status\n');
				const [reply] = await readMessages(sock, 1);
				assert.strictEqual(reply, '[Debug unavailable]');
				sock.destroy();
			} finally {
				await bare.stop();
			}
		});

		test('unknown meta-command help text mentions /debug', async () => {
			const reply = await send('/bogus');
			assert.match(reply, /debug/);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// START / STOP / STATUS
	// ─────────────────────────────────────────────────────────────────────

	suite('start/stop/status', () => {
		test('/debug start launches with an apl launch config by default', async () => {
			const reply = await send('/debug start');
			assert.strictEqual(reply, '[Debug started]');
			assert.strictEqual(bridge.startCalls.length, 1);
			const config = bridge.startCalls[0];
			assert.strictEqual(config.type, 'apl');
			assert.strictEqual(config.request, 'launch');
			assert.ok(config.name, 'config must carry a name for the debug toolbar');
			assert.strictEqual(
				config.program, '',
				'program must default to "" (live-workspace debug) — otherwise the ' +
				'config provider picks whatever APL file happens to be open in the editor',
			);
		});

		test('/debug start overrides can still set an explicit program', async () => {
			await send('/debug start {"program":"/x/run.aplf"}');
			assert.strictEqual(bridge.startCalls[0].program, '/x/run.aplf');
		});

		test('/debug start merges JSON overrides into the config', async () => {
			const reply = await send('/debug start {"traceExpression":"foo","stopOnEntry":true}');
			assert.strictEqual(reply, '[Debug started]');
			const config = bridge.startCalls[0];
			assert.strictEqual(config.traceExpression, 'foo');
			assert.strictEqual(config.stopOnEntry, true);
			assert.strictEqual(config.type, 'apl', 'defaults must survive the merge');
		});

		test('/debug start refuses when a session is already active', async () => {
			bridge.active = true;
			const reply = await send('/debug start');
			assert.match(reply, /^\[Debug error:.*already/);
			assert.strictEqual(bridge.startCalls.length, 0);
		});

		test('two rapid /debug start lines launch exactly one session', async () => {
			// isActive() only flips once startDebugging resolves; without a
			// launch-in-progress guard both starts would pass the check and
			// two adapters would attach to a session that supports one.
			bridge.startDelayMs = 50;
			const sock = await connect(port);
			sock.write('/debug start\n/debug start\n');
			const replies = await readMessages(sock, 2);
			sock.destroy();

			assert.strictEqual(bridge.startCalls.length, 1, 'only one launch may reach vscode');
			const started = replies.filter(r => r === '[Debug started]');
			const refused = replies.filter(r => /^\[Debug error:.*(already|starting)/.test(r));
			assert.strictEqual(started.length, 1, `expected one success, got: ${replies}`);
			assert.strictEqual(refused.length, 1, `expected one refusal, got: ${replies}`);
		});

		test('a failed start releases the launch-in-progress guard', async () => {
			bridge.startResult = false;
			await send('/debug start');
			bridge.startResult = true;
			const reply = await send('/debug start');
			assert.strictEqual(reply, '[Debug started]', 'guard must not stay stuck after failure');
		});

		test('/debug start reports failure when vscode refuses to launch', async () => {
			bridge.startResult = false;
			const reply = await send('/debug start');
			assert.strictEqual(reply, '[Debug start failed]');
		});

		test('/debug start with invalid JSON returns an error without launching', async () => {
			const reply = await send('/debug start {not json');
			assert.match(reply, /^\[Debug error:/);
			assert.strictEqual(bridge.startCalls.length, 0);
		});

		test('/debug stop stops the active session', async () => {
			bridge.active = true;
			const reply = await send('/debug stop');
			assert.strictEqual(reply, '[Debug stopped]');
			assert.strictEqual(bridge.stopCalls, 1);
		});

		test('/debug stop without a session replies [No debug session]', async () => {
			const reply = await send('/debug stop');
			assert.strictEqual(reply, '[No debug session]');
			assert.strictEqual(bridge.stopCalls, 0);
		});

		test('/debug status reflects session state', async () => {
			assert.strictEqual(await send('/debug status'), '[No debug session]');
			bridge.active = true;
			assert.strictEqual(await send('/debug status'), '[Debug session active]');
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// DAP REQUEST FORWARDING
	// ─────────────────────────────────────────────────────────────────────

	suite('request forwarding', () => {
		setup(() => { bridge.active = true; });

		test('/debug next defaults args to threadId 1', async () => {
			const reply = await send('/debug next');
			assert.deepStrictEqual(JSON.parse(reply), {});
			assert.deepStrictEqual(bridge.requests, [{ command: 'next', args: { threadId: 1 } }]);
		});

		test('flow commands (continue, stepIn, stepOut, pause, stackTrace) default threadId', async () => {
			for (const cmd of ['continue', 'stepIn', 'stepOut', 'pause', 'stackTrace']) {
				await send(`/debug ${cmd}`);
			}
			for (const req of bridge.requests) {
				assert.deepStrictEqual(req.args, { threadId: 1 }, `${req.command} must default threadId`);
			}
		});

		test('explicit JSON args are forwarded verbatim', async () => {
			await send('/debug evaluate {"expression":"1+1","context":"repl"}');
			assert.deepStrictEqual(bridge.requests, [
				{ command: 'evaluate', args: { expression: '1+1', context: 'repl' } },
			]);
		});

		test('response bodies round-trip as JSON', async () => {
			bridge.responses['stackTrace'] = {
				stackFrames: [{ id: 0, name: 'foo[2]', line: 2 }],
				totalFrames: 1,
			};
			const reply = await send('/debug stackTrace');
			assert.deepStrictEqual(JSON.parse(reply), bridge.responses['stackTrace']);
		});

		test('request without an active session replies [No debug session]', async () => {
			bridge.active = false;
			const reply = await send('/debug next');
			assert.strictEqual(reply, '[No debug session]');
			assert.deepStrictEqual(bridge.requests, []);
		});

		test('request errors are reported, not thrown', async () => {
			bridge.failWith = 'not in a trace';
			const reply = await send('/debug next');
			assert.strictEqual(reply, '[Debug error: not in a trace]');
		});

		test('invalid JSON args return an error without forwarding', async () => {
			const reply = await send('/debug evaluate {oops');
			assert.match(reply, /^\[Debug error:/);
			assert.deepStrictEqual(bridge.requests, []);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// EVENT STREAMING (/debug listen)
	// ─────────────────────────────────────────────────────────────────────

	suite('listen', () => {
		test('listener receives DAP events as JSON messages after [Listening]', async () => {
			const sock = await connect(port);
			sock.write('/debug listen\n');
			const [ack] = await readMessages(sock, 1);
			assert.strictEqual(ack, '[Listening]');

			const stopped = { type: 'event', event: 'stopped', body: { reason: 'step', threadId: 1 } };
			const pending = readMessages(sock, 1);
			bridge.emit('dap', stopped);
			const [msg] = await pending;
			assert.deepStrictEqual(JSON.parse(msg), stopped);
			sock.destroy();
		});

		test('events arrive in order', async () => {
			const sock = await connect(port);
			sock.write('/debug listen\n');
			await readMessages(sock, 1);

			const pending = readMessages(sock, 3);
			bridge.emit('dap', { type: 'event', event: 'stopped', body: { reason: 'entry' } });
			bridge.emit('dap', { type: 'event', event: 'continued', body: {} });
			bridge.emit('dap', { type: 'event', event: 'stopped', body: { reason: 'step' } });
			const msgs = (await pending).map(m => JSON.parse(m).event);
			assert.deepStrictEqual(msgs, ['stopped', 'continued', 'stopped']);
			sock.destroy();
		});

		test('multiple listeners each receive events; plain sockets receive none', async () => {
			session.outputs['1+1'] = '2';

			const listenerA = await connect(port);
			const listenerB = await connect(port);
			listenerA.write('/debug listen\n');
			listenerB.write('/debug listen\n');
			await Promise.all([readMessages(listenerA, 1), readMessages(listenerB, 1)]);

			const plain = await connect(port);
			plain.write('1+1\n');
			const plainMessages = readMessages(plain, 2, 300); // expect only 1

			const pendingA = readMessages(listenerA, 1);
			const pendingB = readMessages(listenerB, 1);
			bridge.emit('dap', { type: 'event', event: 'stopped', body: {} });

			const [msgsA, msgsB] = await Promise.all([pendingA, pendingB]);
			assert.strictEqual(JSON.parse(msgsA[0]).event, 'stopped');
			assert.strictEqual(JSON.parse(msgsB[0]).event, 'stopped');

			const plainGot = await plainMessages;
			assert.deepStrictEqual(plainGot, ['2'], 'eval socket must only see its own reply');

			listenerA.destroy();
			listenerB.destroy();
			plain.destroy();
		});

		test('a closed listener is dropped; surviving listeners still receive', async () => {
			const listenerA = await connect(port);
			const listenerB = await connect(port);
			listenerA.write('/debug listen\n');
			listenerB.write('/debug listen\n');
			await Promise.all([readMessages(listenerA, 1), readMessages(listenerB, 1)]);

			listenerA.destroy();
			await sleep(50);

			const pendingB = readMessages(listenerB, 1);
			bridge.emit('dap', { type: 'event', event: 'terminated', body: {} });
			const [msg] = await pendingB;
			assert.strictEqual(JSON.parse(msg).event, 'terminated');
			listenerB.destroy();
		});

		test('server.stop() detaches from the bridge', async () => {
			const sock = await connect(port);
			sock.write('/debug listen\n');
			await readMessages(sock, 1);
			await server.stop();
			assert.strictEqual(
				bridge.listenerCount('dap'), 0,
				'stopped server must not leak bridge listeners',
			);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// QUEUE BYPASS
	//
	// Meta-commands never enter the eval FIFO. For /debug this is not a
	// nicety but the point: `pause` must reach the interpreter while an
	// eval is stuck in an infinite loop.
	// ─────────────────────────────────────────────────────────────────────

	suite('queue bypass', () => {
		test('/debug pause works while an eval is in flight', async () => {
			bridge.active = true;
			session.autoReady = false; // eval never completes

			const evalSock = await connect(port);
			evalSock.write('slow\n');
			await sleep(50);
			assert.deepStrictEqual(session.executed, ['slow']);

			const debugSock = await connect(port);
			debugSock.write('/debug pause\n');
			const [reply] = await readMessages(debugSock, 1, 500);
			assert.deepStrictEqual(JSON.parse(reply), {});
			assert.deepStrictEqual(bridge.requests, [{ command: 'pause', args: { threadId: 1 } }]);

			evalSock.destroy();
			debugSock.destroy();
		});
	});
});
