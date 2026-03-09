import assert = require('assert');
import { AplSession } from '../../aplSession';
import { MockRideServer } from '../helpers/mockRideServer';

suite('AplSession — connection lifecycle', () => {
	let server: MockRideServer;
	let session: AplSession;

	setup(async () => {
		server = new MockRideServer();
		await server.start();
		session = new AplSession();
	});

	teardown(() => {
		session.disconnect();
		server.stop();
	});

	test('connect transitions through states correctly', async () => {
		const states: string[] = [];
		session.on('stateChanged', (s: string) => states.push(s));

		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});

		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		// Should have gone connecting → connected (after SetPromptType)
		assert.ok(states.includes('connecting'), 'should have been connecting');
		assert.ok(states.includes('connected'), 'should have been connected');
		assert.strictEqual(session.isConnected, true);
	});

	test('ready event fires after handshake', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});

		await session.connect('127.0.0.1', server.port);
		await readyPromise;
		assert.strictEqual(session.state, 'connected');
	});

	test('disconnect clears state', async () => {
		await session.connect('127.0.0.1', server.port);
		await server.clientConnected;

		session.disconnect();
		assert.strictEqual(session.state, 'disconnected');
		assert.strictEqual(session.isConnected, false);
	});

	test('connect to non-existent port fails', async () => {
		await assert.rejects(
			session.connect('127.0.0.1', 1), // port 1 should be refused
			() => {
				assert.strictEqual(session.state, 'disconnected');
				return true;
			}
		);
	});

	test('execute sends message and receives output', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});

		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		const outputPromise = new Promise<string>(resolve => {
			session.once('output', (text: string) => resolve(text));
		});

		session.execute('1+1');
		const output = await outputPromise;
		assert.ok(output.includes('mock result'));
	});

	test('multiple connects are idempotent', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		// Second connect should return immediately (already connected)
		await session.connect('127.0.0.1', server.port);
		assert.strictEqual(session.isConnected, true);
	});
});

suite('AplSession — debug handler delegation', () => {
	let server: MockRideServer;
	let session: AplSession;

	setup(async () => {
		server = new MockRideServer();
		await server.start();
		session = new AplSession();
	});

	teardown(() => {
		session.disconnect();
		server.stop();
	});

	test('debug handler receives forwarded messages', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		const receivedCommands: string[] = [];
		session.setDebugHandler((command) => {
			receivedCommands.push(command);
		});

		session.execute('test');

		// Wait for messages to propagate
		await new Promise(resolve => setTimeout(resolve, 100));

		assert.ok(receivedCommands.length > 0, 'debug handler should have received messages');
		assert.ok(receivedCommands.includes('EchoInput'), 'should forward EchoInput');
	});

	test('clearDebugHandler stops forwarding', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		let handlerCalled = false;
		session.setDebugHandler(() => { handlerCalled = true; });
		session.clearDebugHandler();

		session.execute('test');
		await new Promise(resolve => setTimeout(resolve, 100));

		assert.strictEqual(handlerCalled, false);
	});

	test('hasDebugHandler reflects state', () => {
		assert.strictEqual(session.hasDebugHandler, false);
		session.setDebugHandler(() => {});
		assert.strictEqual(session.hasDebugHandler, true);
		session.clearDebugHandler();
		assert.strictEqual(session.hasDebugHandler, false);
	});

	test('pending debug messages are buffered without handler', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		// Send messages that would be buffered (debug-specific)
		server.send('OpenWindow', { token: 1, name: 'test', filename: 'test.aplf', text: ['header'], stop: [], trace: [], monitor: [] });
		server.send('SetHighlightLine', { win: 1, line: 0 });

		await new Promise(resolve => setTimeout(resolve, 100));

		assert.ok(session.isSuspended, 'should be in suspended state');
		assert.ok(session.pendingDebugMessageCount >= 2, `expected at least 2 pending messages, got ${session.pendingDebugMessageCount}`);
	});

	test('replayPendingMessages forwards to handler', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		// Buffer some debug messages
		server.send('HadError', { error: 1001 });
		server.send('OpenWindow', { token: 1, name: 'test', filename: 'test.aplf', text: ['header'], stop: [], trace: [], monitor: [] });
		server.send('SetHighlightLine', { win: 1, line: 0 });

		await new Promise(resolve => setTimeout(resolve, 100));

		const replayed: string[] = [];
		session.setDebugHandler((command) => {
			replayed.push(command);
		});

		session.replayPendingMessages();

		assert.ok(replayed.length >= 2, `expected at least 2 replayed messages, got ${replayed.length}`);
		assert.ok(replayed.includes('OpenWindow'));
		assert.ok(replayed.includes('SetHighlightLine'));
	});
});

suite('AplSession — message framing', () => {
	let server: MockRideServer;
	let session: AplSession;

	setup(async () => {
		server = new MockRideServer();
		await server.start();
		session = new AplSession();
	});

	teardown(() => {
		session.disconnect();
		server.stop();
	});

	test('handles multiple messages in one TCP chunk', async () => {
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		const outputs: string[] = [];
		session.on('output', (text: string) => outputs.push(text));

		// Send two output messages rapidly
		server.send('AppendSessionOutput', { result: 'line1\n' });
		server.send('AppendSessionOutput', { result: 'line2\n' });

		await new Promise(resolve => setTimeout(resolve, 150));

		// Output may be batched or separate — verify all content received
		const allOutput = outputs.join('');
		assert.ok(allOutput.includes('line1'), 'should receive line1');
		assert.ok(allOutput.includes('line2'), 'should receive line2');
	});
});
