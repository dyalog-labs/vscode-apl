import * as assert from 'assert';
import * as Net from 'net';
import * as vscode from 'vscode';
import { ReplManager } from '../../replManager';

/**
 * Tests for the command-driven eval-server lifecycle on `ReplManager`.
 *
 * `evalServer.test.ts` covers the server itself; this file covers the
 * wiring that the `APL: Start/Stop Eval Server` commands will delegate to:
 *
 *  - the server does NOT bind a port on extension activation
 *  - `startEvalServer()` binds the port from settings and returns it
 *  - `stopEvalServer()` releases the port
 *  - both methods are idempotent
 *  - bind failures (EADDRINUSE) surface as rejections, not silent logs
 *  - `isEvalServerRunning()` reflects the bound/unbound state
 */

const origGetConfiguration = (vscode.workspace as any).getConfiguration;

function setConfiguredPort(port: number): void {
	(vscode.workspace as any).getConfiguration = (section: string) => ({
		get: <T>(key: string, _defaultValue?: T) => {
			if (section === 'apl' && key === 'evalServer.port') {
				return port as unknown as T;
			}
			return undefined;
		},
	});
}

function canConnect(port: number, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		if (port <= 0) { resolve(false); return; }
		const sock = Net.createConnection({ port, host: '127.0.0.1' });
		let done = false;
		const finish = (ok: boolean) => {
			if (done) { return; }
			done = true;
			sock.destroy();
			resolve(ok);
		};
		sock.once('connect', () => finish(true));
		sock.once('error', () => finish(false));
		setTimeout(() => finish(false), timeoutMs);
	});
}

/** Bind an ephemeral port and return it still-held, plus a release fn. */
async function holdFreePort(): Promise<{ port: number; release: () => Promise<void> }> {
	const server = Net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const port = (server.address() as Net.AddressInfo).port;
	const release = () => new Promise<void>((resolve) => server.close(() => resolve()));
	return { port, release };
}

/** Probe for a free ephemeral port and release it before returning. Has a small
 *  TOCTOU window — acceptable for tests that just need "some port that works". */
async function pickFreePort(): Promise<number> {
	const { port, release } = await holdFreePort();
	await release();
	return port;
}

function makeStubContext(): any {
	return {
		globalState: {
			get: <T>(_key: string, fallback: T) => fallback,
			update: async () => { /* */ },
		},
		subscriptions: [],
	};
}

suite('EvalServer lifecycle (command-driven)', () => {
	let manager: ReplManager;

	setup(() => {
		// Reset singleton so each test starts from a clean state.
		(ReplManager as any)._instance = undefined;
		manager = ReplManager.getInstance();
		manager.initialize(makeStubContext());
	});

	teardown(async () => {
		try { await manager.stopEvalServer(); } catch { /* */ }
		(vscode.workspace as any).getConfiguration = origGetConfiguration;
	});

	// ─────────────────────────────────────────────────────────────────────
	// NO AUTO-START
	// ─────────────────────────────────────────────────────────────────────

	suite('no auto-start', () => {
		test('initialize() alone does not start the server', () => {
			setConfiguredPort(4502);
			// Singleton was constructed + initialize() called in setup.
			// Even with a non-zero port in settings, nothing should be bound.
			assert.strictEqual(manager.isEvalServerRunning(), false);
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// START
	// ─────────────────────────────────────────────────────────────────────

	suite('startEvalServer', () => {
		test('refuses to start when the configured port is 0 (disabled)', async () => {
			setConfiguredPort(0);
			await assert.rejects(
				() => manager.startEvalServer(),
				/disabled|0/i,
			);
			assert.strictEqual(manager.isEvalServerRunning(), false);
		});

		test('binds the exact port configured in settings', async () => {
			const freePort = await pickFreePort();
			setConfiguredPort(freePort);
			const bound = await manager.startEvalServer();
			assert.strictEqual(bound, freePort);
			assert.strictEqual(await canConnect(bound), true);
		});

		test('is idempotent: second call returns the same port', async () => {
			setConfiguredPort(await pickFreePort());
			const first = await manager.startEvalServer();
			const second = await manager.startEvalServer();
			assert.strictEqual(second, first);
			assert.strictEqual(manager.isEvalServerRunning(), true);
		});

		test('rejects when the configured port is already in use', async () => {
			const { port: blockedPort, release } = await holdFreePort();
			try {
				setConfiguredPort(blockedPort);
				await assert.rejects(
					() => manager.startEvalServer(),
					/EADDRINUSE|address (already )?in use/i,
				);
				assert.strictEqual(manager.isEvalServerRunning(), false,
					'failed start must not leave the manager in a running state');
			} finally {
				await release();
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────
	// STOP
	// ─────────────────────────────────────────────────────────────────────

	suite('stopEvalServer', () => {
		test('releases the port so connections are refused', async () => {
			setConfiguredPort(await pickFreePort());
			const port = await manager.startEvalServer();
			assert.strictEqual(await canConnect(port), true);

			await manager.stopEvalServer();
			assert.strictEqual(manager.isEvalServerRunning(), false);
			assert.strictEqual(await canConnect(port), false,
				'port should not accept connections after stop');
		});

		test('is a no-op when the server is not running', async () => {
			assert.strictEqual(manager.isEvalServerRunning(), false);
			await manager.stopEvalServer(); // must not throw
			assert.strictEqual(manager.isEvalServerRunning(), false);
		});

		test('stop then start cycles cleanly', async () => {
			setConfiguredPort(await pickFreePort());
			await manager.startEvalServer();
			await manager.stopEvalServer();
			assert.strictEqual(manager.isEvalServerRunning(), false);

			// Use a fresh free port for the second start; the first one may be
			// in TIME_WAIT on some platforms.
			setConfiguredPort(await pickFreePort());
			const port2 = await manager.startEvalServer();
			assert.ok(port2 > 0);
			assert.strictEqual(manager.isEvalServerRunning(), true);
			assert.strictEqual(await canConnect(port2), true);
		});
	});
});
