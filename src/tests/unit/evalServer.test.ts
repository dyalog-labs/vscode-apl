import * as assert from 'assert';
import * as Net from 'net';
import { EventEmitter } from 'events';
import { EvalServer } from '../../repl/evalServer';

/**
 * Tests for the TCP eval server.
 *
 * The headline defence is the HTTP-prefix sniffer that blocks browser
 * drive-by attacks; the rest of the suite covers the eval + meta-command
 * contract and the queueing behaviour, which had no tests at all when
 * the server was first added.
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

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

suite('EvalServer', () => {
	let manager: FakeReplManager;
	let session: FakeSession;
	let server: EvalServer;
	let port: number;

	setup(async () => {
		manager = new FakeReplManager();
		session = new FakeSession();
		manager.session = session;
		server = new EvalServer(manager as any);
		port = await server.start(0); // 0 → OS-assigned ephemeral port
	});

	teardown(async () => {
		try { await server.stop(); } catch { /* already stopped */ }
	});

	// ─────────────────────────────────────────────────────────────────────
	// HTTP / TLS REJECTION
	//
	// Browsers can't put arbitrary bytes on a TCP socket — every cross-origin
	// fetch starts with an HTTP request line (or, for `https://`, a TLS
	// ClientHello). We close the socket the moment we see one, before any
	// payload reaches the APL session.
	// ─────────────────────────────────────────────────────────────────────

	suite('rejects HTTP-shaped traffic', () => {
		const httpVariants: Array<[string, string]> = [
			['GET',
				`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`],
			['POST',
				`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n\r\n⎕CMD 'pwned'\n`],
			['OPTIONS (CORS preflight)',
				`OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccess-Control-Request-Method: POST\r\n\r\n`],
			['HEAD',
				`HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`],
			['CONNECT',
				`CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`],
		];

		for (const [name, payload] of httpVariants) {
			test(`drops ${name} request`, async () => {
				const sock = await connect(port);
				sock.write(payload);
				const { closed } = await readUntilClose(sock);
				assert.ok(closed, 'socket should be closed by server');
				assert.deepStrictEqual(session.executed, [], 'no APL should reach the session');
			});
		}

		test('drops TLS ClientHello (https://… drive-by)', async () => {
			const sock = await connect(port);
			// A real ClientHello starts with byte 0x16 (handshake), then version, length.
			sock.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x10]));
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('drops HTTP request even when the body contains a valid APL expression', async () => {
			// The body never gets parsed as APL because the request line itself
			// is the rejection signal.
			const sock = await connect(port);
			sock.write(
				`POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n\r\n⎕CMD 'pwned'\n`,
			);
			const { closed } = await readUntilClose(sock);
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('drops HTTP request that arrives byte-by-byte', async () => {
			// Even an attacker that drip-feeds the request line to dodge a
			// naive first-packet check still gets rejected once we have enough
			// bytes to disambiguate. Attach the close listener up-front so a
			// fast server-side destroy doesn't race past the test.
			const sock = await connect(port);
			const closePromise = readUntilClose(sock, 2000);
			const payload = `GET / HTTP/1.1\r\n\r\n`;
			for (const ch of payload) {
				try { sock.write(ch); } catch { /* server may have destroyed mid-write */ }
				await sleep(5);
			}
			const { closed } = await closePromise;
			assert.ok(closed);
			assert.deepStrictEqual(session.executed, []);
		});

		test('closes idle connections that send no data', async function () {
			// Half-open scans / zombie sockets must not accumulate. The pre-data
			// timeout in evalServer.ts is 2000ms; we give it a healthy margin
			// and bump the mocha timeout past it.
			this.timeout(5000);
			const sock = await connect(port);
			const { closed } = await readUntilClose(sock, 3500);
			assert.ok(closed, 'socket should be closed by server after idle timeout');
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// ACCEPTS RAW TRAFFIC
	//
	// Non-HTTP clients can connect and start sending expressions
	// immediately — there is no handshake.
	// ─────────────────────────────────────────────────────────────────────

	suite('accepts non-HTTP traffic', () => {
		test('accepts a plain APL expression with no handshake', async () => {
			session.outputs['+/⍳10'] = '55\n';
			const sock = await connect(port);
			sock.write('+/⍳10\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '55\n');
			assert.deepStrictEqual(session.executed, ['+/⍳10']);
			sock.destroy();
		});

		test('accepts APL function calls whose names collide with HTTP methods', async () => {
			// `GET`, `POST`, `DELETE` etc. are perfectly valid APL identifiers.
			// The classifier must only reject lines that match the full HTTP
			// request-line shape (`METHOD SP target SP HTTP/<digit>`), not bare
			// method-shaped prefixes.
			const calls: Array<[string, string]> = [
				['GET 1 2 3', '1 2 3 (got)'],
				['POST x', 'posted'],
				['DELETE foo', 'deleted'],
				['OPTIONS', 'opts'],
				['HEAD ⍳3', '1 2 3'],
			];
			for (const [expr, out] of calls) {
				session.outputs[expr] = out;
			}
			const sock = await connect(port);
			sock.write(calls.map(([expr]) => expr + '\n').join(''));
			const responses = await readMessages(sock, calls.length);
			assert.deepStrictEqual(responses, calls.map(([, out]) => out));
			assert.deepStrictEqual(session.executed, calls.map(([expr]) => expr));
			sock.destroy();
		});

		test('accepts a meta-command sent immediately', async () => {
			manager.tabList = [{ replId: 't', label: 'Tab', isActive: true }];
			const sock = await connect(port);
			sock.write('/tabs\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '* t Tab');
			sock.destroy();
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// EVAL MECHANICS
	// ─────────────────────────────────────────────────────────────────────

	suite('eval mechanics', () => {
		test('executes multiple sequential expressions on the same socket', async () => {
			session.outputs['A'] = 'A_out';
			session.outputs['B'] = 'B_out';
			session.outputs['C'] = 'C_out';
			const sock = await connect(port);
			sock.write('A\nB\nC\n');
			const responses = await readMessages(sock, 3);
			assert.deepStrictEqual(responses, ['A_out', 'B_out', 'C_out']);
			assert.deepStrictEqual(session.executed, ['A', 'B', 'C']);
			sock.destroy();
		});

		test('replies [No active session] when no session is attached', async () => {
			manager.session = undefined;
			const sock = await connect(port);
			sock.write('+/⍳10\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No active session]');
			sock.destroy();
		});

		test('replies [No active session] when session is disconnected', async () => {
			session.isConnected = false;
			const sock = await connect(port);
			sock.write('+/⍳10\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No active session]');
			assert.deepStrictEqual(session.executed, []);
			sock.destroy();
		});

		test('strips trailing \\r from CRLF-terminated lines', async () => {
			session.outputs['+/⍳3'] = '6';
			const sock = await connect(port);
			sock.write('+/⍳3\r\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '6');
			assert.deepStrictEqual(session.executed, ['+/⍳3']);
			sock.destroy();
		});

		test('skips empty lines between expressions', async () => {
			session.outputs['A'] = 'A_out';
			const sock = await connect(port);
			sock.write('\n\n\nA\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], 'A_out');
			assert.deepStrictEqual(session.executed, ['A']);
			sock.destroy();
		});

		test('handles multiple lines arriving in one TCP packet', async () => {
			session.outputs['X'] = 'X_out';
			session.outputs['Y'] = 'Y_out';
			const sock = await connect(port);
			sock.write('X\nY\n'); // single write → likely single packet
			const responses = await readMessages(sock, 2);
			assert.deepStrictEqual(responses, ['X_out', 'Y_out']);
			sock.destroy();
		});

		test('handles a single expression delivered across many TCP packets', async () => {
			session.outputs['+/⍳100'] = '5050';
			const sock = await connect(port);
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
	// META COMMANDS
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

		test('/history returns the active tab\'s output history', async () => {
			manager.activeTabValue = {
				label: 'A',
				outputHistory: [
					{ type: 'in', text: 'foo\n' },
					{ type: 'out', text: 'bar\n' },
				],
			};
			const sock = await connect(port);
			sock.write('/history\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[in] foo\n[out] bar\n');
			sock.destroy();
		});

		test('/history returns [Empty history] when the tab has no output', async () => {
			manager.activeTabValue = { label: 'A', outputHistory: [] };
			const sock = await connect(port);
			sock.write('/history\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[Empty history]');
			sock.destroy();
		});

		test('/history returns [No active tab] when there is no active tab', async () => {
			manager.activeTabValue = undefined;
			const sock = await connect(port);
			sock.write('/history\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No active tab]');
			sock.destroy();
		});

		test('/tabs lists tabs with active marker', async () => {
			populateTabs();
			const sock = await connect(port);
			sock.write('/tabs\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '* tab-1 Workspace A\n  tab-2 Workspace B');
			sock.destroy();
		});

		test('/tabs returns [No tabs] when there are no tabs', async () => {
			manager.tabList = [];
			const sock = await connect(port);
			sock.write('/tabs\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], '[No tabs]');
			sock.destroy();
		});

		test('/switch <exact-id> switches to that tab', async () => {
			populateTabs();
			const sock = await connect(port);
			sock.write('/switch tab-2\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], 'Switched to Workspace B');
			assert.deepStrictEqual(manager.switchCalls, ['tab-2']);
			sock.destroy();
		});

		test('/switch <substring of label> matches and switches', async () => {
			populateTabs();
			const sock = await connect(port);
			sock.write('/switch workspace b\n');
			const responses = await readMessages(sock, 1);
			assert.strictEqual(responses[0], 'Switched to Workspace B');
			assert.deepStrictEqual(manager.switchCalls, ['tab-2']);
			sock.destroy();
		});

		test('/switch <unknown> returns not-found error', async () => {
			populateTabs();
			const sock = await connect(port);
			sock.write('/switch nope\n');
			const responses = await readMessages(sock, 1);
			assert.match(responses[0], /Tab not found.*nope/);
			assert.deepStrictEqual(manager.switchCalls, []);
			sock.destroy();
		});

		test('/switch without arg returns usage', async () => {
			const sock = await connect(port);
			sock.write('/switch\n');
			const responses = await readMessages(sock, 1);
			assert.match(responses[0], /Usage.*switch/);
			sock.destroy();
		});

		test('unknown meta-command returns help text', async () => {
			const sock = await connect(port);
			sock.write('/bogus\n');
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
		test('two concurrent connections receive their own outputs', async () => {
			session.outputs['A'] = 'A_out';
			session.outputs['B'] = 'B_out';

			const sockA = await connect(port);
			const sockB = await connect(port);

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
			// Regression test for an earlier listener-stacking bug: without
			// per-request isolation, the second response got the first's
			// output (or both concatenated).
			session.outputs['A'] = 'A_out';
			session.outputs['B'] = 'B_out';
			const sock = await connect(port);
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
			session.outputs['ok'] = 'ok_out';

			const sockBad = await connect(port);
			sockBad.destroy(new Error('simulated client error'));
			await sleep(50);

			const sockGood = await connect(port);
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
	// SHUTDOWN
	//
	// Node's `server.close()` waits for existing connections to finish.
	// An idle live client would otherwise keep stop() pending forever.
	// ─────────────────────────────────────────────────────────────────────

	suite('shutdown with live connections', () => {
		test('stop() resolves promptly even with multiple idle sockets', async () => {
			const socks: Net.Socket[] = [];
			for (let i = 0; i < 3; i++) {
				const sock = await connect(port);
				sock.write('+/⍳1\n'); // sends a byte so the HTTP-sniff clears
				socks.push(sock);
			}
			await sleep(50);
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

		test('stop() closes live connections from the server side', async () => {
			session.outputs['x'] = 'x_out';
			const sock = await connect(port);
			sock.write('x\n');
			await readMessages(sock, 1); // wait until the eval is fully settled
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
	// LIVENESS UNDER MID-EVAL DISCONNECT
	//
	// If the in-flight socket dies before `ready` fires, the queue would
	// otherwise stay wedged. We don't add per-request *timeouts* (legitimate
	// APL can run long), but we must detect a dead in-flight socket and drain.
	// ─────────────────────────────────────────────────────────────────────

	suite('liveness under mid-eval disconnect', () => {
		test('in-flight socket closing before ready does not wedge the server', async () => {
			session.autoReady = false; // 'slow' will never complete

			const sockA = await connect(port);
			sockA.write('slow\n');
			await sleep(50);
			assert.deepStrictEqual(
				session.executed, ['slow'],
				'first request should have been dispatched',
			);

			sockA.destroy();
			await sleep(50);

			session.autoReady = true;
			session.outputs['ok'] = 'ok_out';
			const sockB = await connect(port);
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
