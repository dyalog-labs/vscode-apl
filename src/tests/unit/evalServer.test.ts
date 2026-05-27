import * as assert from 'assert';
import * as Net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { EvalServer } from '../../evalServer';

/**
 * Tests for the TCP eval server.
 *
 * The auth gate is the headline feature, but these tests also cover the
 * pre-existing eval and meta-command behaviour — which had no tests at
 * all when the server was first added — so that we have a regression
 * baseline for the wider eval-server contract.
 *
 * The tests use real TCP sockets against a fake ReplManager/Session.
 * They do NOT cover the AplSession ↔ interpreter wire; for that, see the
 * integration tests.
 */

class FakeSession extends EventEmitter {
	public executed: string[] = [];
	public isConnected = true;
	/** Per-expression output; falls back to defaultOutput. */
	public outputs: Record<string, string> = {};
	public defaultOutput = '';
	/** When false, execute() records the call but does not emit output/ready —
	 *  lets tests simulate an in-flight request that never completes. */
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

interface FakeTab {
	label: string;
	outputHistory: Array<{ type: string; text: string }>;
}

class FakeReplManager {
	public session: FakeSession | undefined;
	public activeTabValue: FakeTab | undefined;
	public tabs: Map<string, FakeTab> = new Map();
	public tabList: Array<{ replId: string; label: string; isActive: boolean }> = [];
	public switchCalls: string[] = [];

	public get activeSession(): FakeSession | undefined { return this.session; }
	public get activeTab(): FakeTab | undefined { return this.activeTabValue; }

	public getTabList(): Array<{ replId: string; label: string; isActive: boolean }> {
		return this.tabList;
	}

	public getTab(id: string): FakeTab | undefined { return this.tabs.get(id); }

	public switchToTab(id: string): void { this.switchCalls.push(id); }
}

function connect(port: number): Promise<Net.Socket> {
	return new Promise((resolve, reject) => {
		const sock = Net.createConnection({ port, host: '127.0.0.1' });
		sock.once('connect', () => resolve(sock));
		sock.once('error', reject);
	});
}

/** Collect NUL-delimited messages until `count` of them arrive, or socket closes. */
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

/** Wait for the socket to close, returning whatever bytes were received. */
function readUntilClose(sock: Net.Socket, timeoutMs = 500): Promise<{ data: string; closed: boolean }> {
	return new Promise((resolve) => {
		let buf = '';
		let closed = false;
		sock.on('data', (c) => { buf += c.toString(); });
		sock.once('close', () => { closed = true; resolve({ data: buf, closed }); });
		setTimeout(() => resolve({ data: buf, closed }), timeoutMs);
	});
}

function readToken(dir: string): string {
	return fs.readFileSync(path.join(dir, 'eval-token'), 'utf8').trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

/** Convenience: open a socket and complete the auth handshake. */
async function connectAndAuth(port: number, token: string): Promise<Net.Socket> {
	const sock = await connect(port);
	sock.write(`]auth ${token}\n`);
	await readMessages(sock, 1); // discard (ok)
	return sock;
}

suite('EvalServer', () => {
	let tmpDir: string;
	let manager: FakeReplManager;
	let session: FakeSession;
	let server: EvalServer;
	let port: number;

	setup(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalserver-'));
		manager = new FakeReplManager();
		session = new FakeSession();
		manager.session = session;
		server = new EvalServer(manager as any, tmpDir);
		port = await server.start(0); // 0 → OS-assigned ephemeral port
	});

	teardown(async () => {
		try { await server.stop(); } catch { /* already stopped */ }
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
	});

	// ─────────────────────────────────────────────────────────────────────
	// AUTH GATE
	// ─────────────────────────────────────────────────────────────────────

	suite('token file lifecycle', () => {
		test('writes a 64-char hex token file on start', () => {
			const token = readToken(tmpDir);
			assert.match(token, /^[0-9a-f]{64}$/);
		});

		test('removes the token file on stop', async () => {
			const tokenPath = path.join(tmpDir, 'eval-token');
			assert.ok(fs.existsSync(tokenPath), 'token file should exist while server is running');
			await server.stop();
			assert.ok(!fs.existsSync(tokenPath), 'token file should be removed after stop');
		});

		test('regenerates the token on each start', async () => {
			const t1 = readToken(tmpDir);
			await server.stop();
			port = await server.start(0);
			const t2 = readToken(tmpDir);
			assert.notStrictEqual(t1, t2);
		});
	});

	suite('rejects unauthenticated traffic', () => {
		test('drops connection that sends APL without auth', async () => {
			const sock = await connect(port);
			sock.write('+/⍳10\n');
			const { closed } = await readUntilClose(sock);
			assert.ok(closed, 'socket should be closed by server');
			assert.deepStrictEqual(session.executed, [], 'no APL should reach the session');
		});

		test('drops connection with wrong token', async () => {
			const sock = await connect(port);
			sock.write(']auth deadbeef\n+/⍳10\n');
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('drops connection where auth line is malformed', async () => {
			const sock = await connect(port);
			sock.write(']auth\n');
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('drops HTTP-shaped drive-by request', async () => {
			const sock = await connect(port);
			sock.write(
				`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n\r\n⎕CMD 'pwned'\n`,
			);
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('drops HTTP-shaped request even if body contains correct token', async () => {
			// Browser CANNOT make the FIRST line be `]auth …`, so even if the
			// attacker has somehow learned the token, smuggling it in the
			// request body must not authenticate them.
			const token = readToken(tmpDir);
			const sock = await connect(port);
			sock.write(
				`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n\r\n]auth ${token}\n⎕CMD 'pwned'\n`,
			);
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('drops meta-command sent before auth', async () => {
			const sock = await connect(port);
			sock.write(']tabs\n');
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
		});
	});

	suite('accepts authenticated traffic', () => {
		test('replies with (ok) on correct auth', async () => {
			const token = readToken(tmpDir);
			const sock = await connect(port);
			sock.write(`]auth ${token}\n`);
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '(ok)');
			sock.destroy();
		});

		test('auth line split across multiple writes still works', async () => {
			const token = readToken(tmpDir);
			const sock = await connect(port);
			sock.write(']auth ');
			await sleep(20);
			sock.write(token.slice(0, 30));
			await sleep(20);
			sock.write(token.slice(30) + '\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '(ok)');
			sock.destroy();
		});

		test('auth on one connection does not authenticate another', async () => {
			const token = readToken(tmpDir);
			const sockA = await connect(port);
			sockA.write(`]auth ${token}\n`);
			await readMessages(sockA, 1);

			const sockB = await connect(port);
			sockB.write('+/⍳10\n');
			const { closed } = await readUntilClose(sockB);
			assert.ok(closed, 'unauthenticated connection should be dropped');
			assert.deepStrictEqual(session.executed, []);

			sockA.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// EVAL MECHANICS (post-auth)
	// ─────────────────────────────────────────────────────────────────────

	suite('eval mechanics', () => {
		test('executes a single expression and returns its output', async () => {
			const token = readToken(tmpDir);
			session.outputs['+/⍳10'] = '55\n';
			const sock = await connectAndAuth(port, token);
			sock.write('+/⍳10\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '55\n');
			assert.deepStrictEqual(session.executed, ['+/⍳10']);
			sock.destroy();
		});

		test('executes multiple sequential expressions on the same socket', async () => {
			const token = readToken(tmpDir);
			session.outputs['A'] = 'A_out';
			session.outputs['B'] = 'B_out';
			session.outputs['C'] = 'C_out';
			const sock = await connectAndAuth(port, token);
			sock.write('A\nB\nC\n');
			const responses = await readMessages(sock, 3);
			assert.deepStrictEqual(responses, ['A_out', 'B_out', 'C_out']);
			assert.deepStrictEqual(session.executed, ['A', 'B', 'C']);
			sock.destroy();
		});

		test('replies [No active session] when no session is attached', async () => {
			const token = readToken(tmpDir);
			manager.session = undefined;
			const sock = await connectAndAuth(port, token);
			sock.write('+/⍳10\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No active session]');
			sock.destroy();
		});

		test('replies [No active session] when session is disconnected', async () => {
			const token = readToken(tmpDir);
			session.isConnected = false;
			const sock = await connectAndAuth(port, token);
			sock.write('+/⍳10\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No active session]');
			assert.deepStrictEqual(session.executed, []);
			sock.destroy();
		});

		test('strips trailing \\r from CRLF-terminated lines', async () => {
			const token = readToken(tmpDir);
			session.outputs['+/⍳3'] = '6';
			const sock = await connectAndAuth(port, token);
			sock.write('+/⍳3\r\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '6');
			assert.deepStrictEqual(session.executed, ['+/⍳3']);
			sock.destroy();
		});

		test('skips empty lines between expressions', async () => {
			const token = readToken(tmpDir);
			session.outputs['A'] = 'A_out';
			const sock = await connectAndAuth(port, token);
			sock.write('\n\n\nA\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], 'A_out');
			assert.deepStrictEqual(session.executed, ['A']);
			sock.destroy();
		});

		test('handles multiple lines arriving in one TCP packet', async () => {
			const token = readToken(tmpDir);
			session.outputs['X'] = 'X_out';
			session.outputs['Y'] = 'Y_out';
			const sock = await connectAndAuth(port, token);
			sock.write('X\nY\n'); // single write → likely single packet
			const responses = await readMessages(sock, 2);
			assert.deepStrictEqual(responses, ['X_out', 'Y_out']);
			sock.destroy();
		});

		test('handles a single expression delivered across many TCP packets', async () => {
			const token = readToken(tmpDir);
			session.outputs['+/⍳100'] = '5050';
			const sock = await connectAndAuth(port, token);
			sock.write('+/');
			await sleep(20);
			sock.write('⍳1');
			await sleep(20);
			sock.write('00\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '5050');
			assert.deepStrictEqual(session.executed, ['+/⍳100']);
			sock.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// META COMMANDS (post-auth)
	// ─────────────────────────────────────────────────────────────────────

	suite('meta commands', () => {
		const populateTabs = () => {
			const tab1: FakeTab = { label: 'Workspace A', outputHistory: [] };
			const tab2: FakeTab = { label: 'Workspace B', outputHistory: [] };
			manager.tabs.set('tab-1', tab1);
			manager.tabs.set('tab-2', tab2);
			manager.tabList = [
				{ replId: 'tab-1', label: 'Workspace A', isActive: true },
				{ replId: 'tab-2', label: 'Workspace B', isActive: false },
			];
			manager.activeTabValue = tab1;
		};

		test(']history returns the active tab\'s output history', async () => {
			const token = readToken(tmpDir);
			manager.activeTabValue = {
				label: 'A',
				outputHistory: [
					{ type: 'in', text: 'foo\n' },
					{ type: 'out', text: 'bar\n' },
				],
			};
			const sock = await connectAndAuth(port, token);
			sock.write(']history\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[in] foo\n[out] bar\n');
			sock.destroy();
		});

		test(']history returns [Empty history] when the tab has no output', async () => {
			const token = readToken(tmpDir);
			manager.activeTabValue = { label: 'A', outputHistory: [] };
			const sock = await connectAndAuth(port, token);
			sock.write(']history\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[Empty history]');
			sock.destroy();
		});

		test(']history returns [No active tab] when there is no active tab', async () => {
			const token = readToken(tmpDir);
			manager.activeTabValue = undefined;
			const sock = await connectAndAuth(port, token);
			sock.write(']history\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No active tab]');
			sock.destroy();
		});

		test(']tabs lists tabs with active marker', async () => {
			const token = readToken(tmpDir);
			populateTabs();
			const sock = await connectAndAuth(port, token);
			sock.write(']tabs\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '* tab-1 Workspace A\n  tab-2 Workspace B');
			sock.destroy();
		});

		test(']tabs returns [No tabs] when there are no tabs', async () => {
			const token = readToken(tmpDir);
			manager.tabList = [];
			const sock = await connectAndAuth(port, token);
			sock.write(']tabs\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No tabs]');
			sock.destroy();
		});

		test(']switch <exact-id> switches to that tab', async () => {
			const token = readToken(tmpDir);
			populateTabs();
			const sock = await connectAndAuth(port, token);
			sock.write(']switch tab-2\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], 'Switched to Workspace B');
			assert.deepStrictEqual(manager.switchCalls, ['tab-2']);
			sock.destroy();
		});

		test(']switch <substring of label> matches and switches', async () => {
			const token = readToken(tmpDir);
			populateTabs();
			const sock = await connectAndAuth(port, token);
			sock.write(']switch workspace b\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], 'Switched to Workspace B');
			assert.deepStrictEqual(manager.switchCalls, ['tab-2']);
			sock.destroy();
		});

		test(']switch <unknown> returns not-found error', async () => {
			const token = readToken(tmpDir);
			populateTabs();
			const sock = await connectAndAuth(port, token);
			sock.write(']switch nope\n');
			const responses = await readMessages(sock, 1);
			assert.match(responses[0], /Tab not found.*nope/);
			assert.deepStrictEqual(manager.switchCalls, []);
			sock.destroy();
		});

		test(']switch without arg returns usage', async () => {
			const token = readToken(tmpDir);
			const sock = await connectAndAuth(port, token);
			sock.write(']switch\n');
			const responses = await readMessages(sock, 1);
			assert.match(responses[0], /Usage.*switch/);
			sock.destroy();
		});

		test('unknown meta-command returns help text', async () => {
			const token = readToken(tmpDir);
			const sock = await connectAndAuth(port, token);
			sock.write(']bogus\n');
			const responses = await readMessages(sock, 1);
			assert.match(responses[0], /Unknown command/);
			assert.match(responses[0], /history.*tabs.*switch/s);
			sock.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// CONCURRENCY / OUTPUT ISOLATION
	// ─────────────────────────────────────────────────────────────────────

	suite('concurrency', () => {
		test('two concurrent authed connections receive their own outputs', async () => {
			const token = readToken(tmpDir);
			session.outputs['A'] = 'A_out';
			session.outputs['B'] = 'B_out';

			const sockA = await connectAndAuth(port, token);
			const sockB = await connectAndAuth(port, token);

			// Fire both nearly simultaneously
			sockA.write('A\n');
			sockB.write('B\n');

			const [respA, respB] = await Promise.all([
				readMessages(sockA, 1),
				readMessages(sockB, 1),
			]);

			assert.strictEqual(respA[0], 'A_out', 'connection A should receive A_out');
			assert.strictEqual(respB[0], 'B_out', 'connection B should receive B_out');

			sockA.destroy();
			sockB.destroy();
		});

		test('two expressions sent rapidly on same socket get their own outputs', async () => {
			// Demonstrates the listener-stacking bug in the current code:
			// without per-request isolation, the second response gets the
			// first's output (or both concatenated).
			const token = readToken(tmpDir);
			session.outputs['A'] = 'A_out';
			session.outputs['B'] = 'B_out';
			const sock = await connectAndAuth(port, token);
			sock.write('A\nB\n');
			const responses = await readMessages(sock, 2);
			assert.deepStrictEqual(responses, ['A_out', 'B_out']);
			sock.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// ROBUSTNESS
	// ─────────────────────────────────────────────────────────────────────

	suite('robustness', () => {
		test('errored connection does not affect a subsequent connection', async () => {
			const token = readToken(tmpDir);
			session.outputs['ok'] = 'ok_out';

			const sockBad = await connect(port);
			sockBad.destroy(new Error('simulated client error'));
			await sleep(50);

			const sockGood = await connectAndAuth(port, token);
			sockGood.write('ok\n');
			const responses = await readMessages(sockGood, 1);
			assert.strictEqual(responses[0], 'ok_out');
			sockGood.destroy();
		});

		test('stop() refuses further connections', async () => {
			await server.stop();
			await assert.rejects(connect(port), /ECONNREFUSED|ECONNRESET/);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// SHUTDOWN (codex review follow-up)
	//
	// Node's `server.close()` waits for existing connections to finish.
	// An idle authed client would otherwise keep stop() pending forever,
	// and token cleanup (which sits after the await) would never run.
	// ─────────────────────────────────────────────────────────────────────

	suite('shutdown with live connections', () => {
		test('stop() removes the token file even when an idle authed socket is connected', async () => {
			const token = readToken(tmpDir);
			const sock = await connectAndAuth(port, token);
			// sock stays open and idle through stop()
			await server.stop();
			assert.ok(
				!fs.existsSync(path.join(tmpDir, 'eval-token')),
				'token file must be removed even with a live connection',
			);
			sock.destroy();
		});

		test('stop() resolves promptly even with multiple idle authed sockets', async () => {
			const token = readToken(tmpDir);
			const socks: Net.Socket[] = [];
			for (let i = 0; i < 3; i++) {
				socks.push(await connectAndAuth(port, token));
			}
			const t0 = Date.now();
			const result = await Promise.race([
				server.stop().then(() => 'stopped' as const),
				sleep(1000).then(() => 'timeout' as const),
			]);
			const elapsed = Date.now() - t0;
			assert.strictEqual(
				result, 'stopped',
				`stop() must not hang on idle clients (waited ${elapsed}ms)`,
			);
			for (const s of socks) { s.destroy(); }
		});

		test('stop() closes live authed connections from the server side', async () => {
			const token = readToken(tmpDir);
			const sock = await connectAndAuth(port, token);
			const observed = new Promise<boolean>((resolve) => {
				sock.once('close', () => resolve(true));
				setTimeout(() => resolve(false), 500);
			});
			await server.stop();
			const closed = await observed;
			assert.ok(closed, 'client must observe close after server.stop()');
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// LIVENESS UNDER MID-EVAL DISCONNECT (codex review follow-up)
	//
	// If the in-flight socket dies before `ready` fires, the current code
	// leaves `_busy = true` and the entire queue is wedged. We don't add
	// per-request *timeouts* (legitimate APL can run long), but we must
	// detect a dead in-flight socket and drain.
	// ─────────────────────────────────────────────────────────────────────

	suite('liveness under mid-eval disconnect', () => {
		test('in-flight socket closing before ready does not wedge the server', async () => {
			const token = readToken(tmpDir);
			session.autoReady = false; // 'slow' will never complete

			const sockA = await connectAndAuth(port, token);
			sockA.write('slow\n');
			await sleep(50);
			assert.deepStrictEqual(
				session.executed, ['slow'],
				'first request should have been dispatched',
			);

			// sockA dies before session emits ready
			sockA.destroy();
			await sleep(50);

			// A second client must still be able to get a response
			session.autoReady = true;
			session.outputs['ok'] = 'ok_out';
			const sockB = await connectAndAuth(port, token);
			sockB.write('ok\n');
			const responses = await readMessages(sockB, 1, 500);
			assert.deepStrictEqual(
				responses, ['ok_out'],
				'queue must drain after the in-flight socket dies',
			);
			sockB.destroy();
		});
	});
});
