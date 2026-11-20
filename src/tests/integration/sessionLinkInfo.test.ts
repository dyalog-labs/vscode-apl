import assert = require('assert');
import { AplSession, LINK_INFO_MARKER } from '../../session/aplSession';
import { MockRideServer } from '../helpers/mockRideServer';
import { seedLinkInfo } from '../helpers/sessionTestUtils';

/** Workspace folder the tests pretend to be linked to (only its shape matters). */
const WS = '/ws';

/** A row as the interpreter sends it: [name, parent, file, startLine]. */
function row(name: string, parent: string, file: string, startLine = 0): string[] {
	return [name, parent, file, String(startLine)];
}

/**
 * Split the JSON table into ShowHTML payloads the way linkInfoQuery does:
 * `<marker><query id>:<count>:<piece>`. chunkSize 0 means one chunk.
 */
function chunkReply(rows: string[][], id: string, chunkSize: number): string[] {
	const json = JSON.stringify(rows);
	const size = chunkSize > 0 ? chunkSize : Math.max(1, json.length);
	const count = Math.max(1, Math.ceil(json.length / size));
	const chunks: string[] = [];
	for (let i = 0; i < count; i++) {
		chunks.push(`${LINK_INFO_MARKER}${id}:${count}:${json.slice(i * size, (i + 1) * size)}`);
	}
	return chunks;
}

interface ReplyOptions {
	/** characters per chunk; 0 (default) sends the whole table in one message */
	chunkSize?: number;
	/** withhold the final chunk, simulating a lost message */
	dropLast?: boolean;
	/** delay between consecutive chunks */
	spacingMs?: number;
	/** delay before the interpreter echoes (starts on) the query, as if busy with earlier input */
	echoDelayMs?: number;
	/** delay between the echo and the first chunk */
	replyDelayMs?: number;
	/** never echo or answer the query, as if it had been swallowed */
	swallow?: boolean;
}

/**
 * Configure a mock Execute handler that answers the 5177⌶ link-info query the
 * way a real interpreter does: it echoes the input when it "starts" on it,
 * then sends ShowHTML messages (3500⌶) whose payloads carry LINK_INFO_MARKER,
 * the query's id, the chunk count and a slice of the JSON table, then
 * SetPromptType so awaiting code resolves.
 *
 * @param server  the mock RIDE server
 * @param rows    rows to reply with, or null to echo but never answer
 *                (simulating an interpreter without 3500⌶, or a lost message)
 */
function setupLinkQueryHandler(server: MockRideServer, rows: string[][] | null, opts: ReplyOptions = {}) {
	server.onCommand('Execute', (args: { text: string }) => {
		const text = args.text;
		if (opts.swallow) { return; }
		const id = /vscode-apl:link-info:(\d+):/.exec(text)?.[1] ?? '0';

		const respond = () => {
			server.send('EchoInput', { input: text });
			if (text.includes('5177⌶') && rows !== null) {
				const chunks = chunkReply(rows, id, opts.chunkSize ?? 0);
				if (opts.dropLast) { chunks.pop(); }
				const first = opts.replyDelayMs ?? 0;
				const spacing = opts.spacingMs ?? 0;
				chunks.forEach((html, i) => {
					const send = () => server.send('ShowHTML', { title: '3500⌶', html });
					const at = first + i * spacing;
					if (at > 0) { setTimeout(send, at); } else { send(); }
				});
			}
			server.send('SetPromptType', { type: 1 });
		};

		const delay = opts.echoDelayMs ?? 0;
		if (delay > 0) { setTimeout(respond, delay); } else { respond(); }
	});
}

/** Texts of the Execute messages that carried the link-info query. */
function linkQueries(server: MockRideServer): string[] {
	return server.getReceived('Execute')
		.map((m: { text: string }) => m.text)
		.filter((t: string) => t.includes('5177⌶'));
}

/** Poll until `cond()` holds or `ms` elapse. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (cond()) { return true; }
		await new Promise(r => setTimeout(r, 10));
	}
	return cond();
}

suite('AplSession — link info loading', () => {
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

	async function connect(): Promise<void> {
		const ready = new Promise<void>(r => session.once('ready', r));
		await session.connect('127.0.0.1', server.port);
		await ready;
	}

	test('loadLinkInfo populates linkInfo from successful query', async () => {
		setupLinkQueryHandler(server, [
			row('Foo', '#', `${WS}/Foo.aplf`),
			row('Bar', '#', `${WS}/Bar.aplf`, 5),
		]);
		await connect();

		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 2);
		assert.ok(session.linkInfo.some(r => r.aplName === '#.Foo'));
		assert.ok(session.linkInfo.some(r => r.aplName === '#.Bar'));
		const bar = session.linkInfo.find(r => r.aplName === '#.Bar');
		assert.strictEqual(bar?.startLine, 5);
	});

	test('query is a single Execute that writes no file', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();

		await session.loadLinkInfo(WS);

		const executes = server.getReceived('Execute');
		assert.strictEqual(executes.length, 1, 'exactly one Execute (no follow-up no-op)');
		const query = executes[0].text as string;
		assert.ok(query.includes('5177⌶'), 'queries the loaded-file table');
		assert.ok(query.includes('3500⌶'), 'replies over the RIDE connection');
		assert.ok(query.includes(LINK_INFO_MARKER), 'tags the reply with the marker');
		assert.ok(!query.includes('⎕NPUT'), 'must not write a file');
		assert.ok(query.includes("'⎕SE'"), 'drops rows under ⎕SE on the interpreter side');
	});

	test('multi-chunk reply is reassembled in order', async () => {
		setupLinkQueryHandler(server, [
			row('Foo', '#', `${WS}/Foo.aplf`),
			row('Bar', '#', `${WS}/sub/Bar.aplf`, 12),
		], { chunkSize: 7 });
		await connect();

		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 2);
		const bar = session.linkInfo.find(r => r.aplName === '#.Bar');
		assert.ok(bar, 'row from the later chunks is present');
		assert.strictEqual(bar!.startLine, 12);
		assert.ok(bar!.filePath.endsWith('Bar.aplf'));
	});

	test('idle timeout restarts on every chunk, so a slow but steady reply succeeds', async () => {
		setupLinkQueryHandler(server, [
			row('Foo', '#', `${WS}/Foo.aplf`),
			row('Bar', '#', `${WS}/Bar.aplf`),
		], { chunkSize: 8, spacingMs: 120 });
		await connect();
		session.linkInfoTimeoutMs = 200;

		const start = Date.now();
		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 2, 'table loaded despite total time exceeding the timeout');
		assert.ok(Date.now() - start > 200, 'the reply really did take longer than one timeout');
	});

	test('incomplete reply (last chunk lost) gives up after the idle timeout with an empty table', async () => {
		setupLinkQueryHandler(server, [
			row('Foo', '#', `${WS}/Foo.aplf`),
			row('Bar', '#', `${WS}/Bar.aplf`),
		], { chunkSize: 7, dropLast: true });
		await connect();
		session.linkInfoTimeoutMs = 200;

		const start = Date.now();
		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 0);
		assert.ok(Date.now() - start >= 150, 'waited for the idle timeout');
		assert.ok(Date.now() - start < 1500, 'did not wait much longer than the idle timeout');
	});

	test('reply timer starts only when the interpreter echoes the query (busy interpreter)', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)], { echoDelayMs: 450 });
		await connect();
		session.linkInfoTimeoutMs = 200;

		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 1,
			'loaded although the interpreter was busy for longer than the reply timeout');
	});

	test('a query the interpreter never starts on gives up after the queue timeout', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)], { swallow: true });
		await connect();
		session.linkInfoQueueTimeoutMs = 200;

		const start = Date.now();
		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 0);
		const took = Date.now() - start;
		assert.ok(took >= 150 && took < 1500, `bounded by the queue timeout (took ${took} ms)`);
	});

	test('a timed-out load is retried after the retry delay, not before', async () => {
		setupLinkQueryHandler(server, null);
		await connect();
		session.linkInfoTimeoutMs = 100;
		session.linkInfoRetryDelayMs = 300;

		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 0);
		assert.strictEqual(linkQueries(server).length, 1);

		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await session.loadLinkInfo(WS);
		assert.strictEqual(linkQueries(server).length, 1, 'no retry within the delay');
		assert.strictEqual(session.linkInfo.length, 0);

		await new Promise(r => setTimeout(r, 350));
		await session.loadLinkInfo(WS);
		assert.strictEqual(linkQueries(server).length, 2, 'retried once the delay has passed');
		assert.strictEqual(session.linkInfo.length, 1);
	});

	test('refreshLinkInfo retries immediately after a timed-out load', async () => {
		setupLinkQueryHandler(server, null);
		await connect();
		session.linkInfoTimeoutMs = 100;

		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 0);

		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await session.refreshLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 1);
	});

	test('a late reply to an earlier query is ignored', async () => {
		// First query: its reply only arrives after the timeout has expired.
		setupLinkQueryHandler(server, [row('Old', '#', `${WS}/Old.aplf`)], { replyDelayMs: 500 });
		await connect();
		session.linkInfoTimeoutMs = 150;
		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 0, 'first query timed out');

		// Second query answers at once with a different table.
		setupLinkQueryHandler(server, [row('New', '#', `${WS}/New.aplf`)]);
		await session.refreshLinkInfo(WS);
		assert.strictEqual(session.linkInfo[0]?.aplName, '#.New');

		// Now the first query's reply turns up.
		await new Promise(r => setTimeout(r, 600));
		assert.strictEqual(session.linkInfo.length, 1);
		assert.strictEqual(session.linkInfo[0].aplName, '#.New', 'stale reply must not replace the table');
	});

	test('loadLinkInfo handles empty link list', async () => {
		setupLinkQueryHandler(server, []);
		await connect();

		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 0);
	});

	test('loadLinkInfo gives up after the timeout when nothing replies', async () => {
		setupLinkQueryHandler(server, null);
		await connect();
		session.linkInfoTimeoutMs = 200;

		const start = Date.now();
		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 0);
		assert.ok(Date.now() - start >= 150, 'waited for the timeout');
		assert.ok(Date.now() - start < 1500, 'did not wait much longer than the timeout');
	});

	test('link-info reply is not surfaced as showHtml; other ShowHTML messages still are', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)], { chunkSize: 9 });
		await connect();
		const seen: Array<{ title: string; html: string }> = [];
		session.on('showHtml', (args: { title: string; html: string }) => seen.push(args));

		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 1);
		assert.strictEqual(seen.length, 0, 'no link-info chunk may open an HTML view');

		server.send('ShowHTML', { title: 'report', html: '<b>hi</b>' });
		assert.ok(await waitFor(() => seen.length === 1), 'ordinary ShowHTML still reaches the REPL');
		assert.strictEqual(seen[0].title, 'report');
	});

	test('reply is consumed before the debug handler sees it', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)], { chunkSize: 9 });
		await connect();
		const forwarded: string[] = [];
		session.setDebugHandler((command: string, args: any) => {
			if (command === 'ShowHTML') { forwarded.push(args.html); }
		});

		await session.loadLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 1, 'table loads while a debug handler is attached');
		assert.strictEqual(forwarded.length, 0, 'debug handler must not receive link-info chunks');
	});

	test('loadLinkInfo is idempotent — second call sends no extra query', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();

		await session.loadLinkInfo(WS);
		const afterFirst = linkQueries(server).length;

		await session.loadLinkInfo(WS);
		const afterSecond = linkQueries(server).length;

		assert.strictEqual(afterSecond, afterFirst,
			'second loadLinkInfo should not send another 5177⌶ query');
	});

	test('concurrent loadLinkInfo calls coalesce into one query', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();

		await Promise.all([
			session.loadLinkInfo(WS),
			session.loadLinkInfo(WS),
		]);

		assert.strictEqual(linkQueries(server).length, 1,
			'concurrent loadLinkInfo calls should share one query');
	});

	test('a refresh that gets no reply keeps the table it had, and the next one replaces it', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);

		setupLinkQueryHandler(server, null, { swallow: true });
		session.linkInfoQueueTimeoutMs = 100;
		await session.refreshLinkInfo(WS);

		assert.deepStrictEqual(session.linkInfo.map(r => r.aplName), ['#.Foo']);
		assert.ok(await session.getLinkedFile('#.Foo'), 'lookups keep working');

		setupLinkQueryHandler(server, [row('Bar', '#', `${WS}/Bar.aplf`)]);
		await session.refreshLinkInfo(WS);
		assert.deepStrictEqual(session.linkInfo.map(r => r.aplName), ['#.Bar']);
	});

	test('refreshLinkInfo replaces the table with a fresh fetch', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 1);

		setupLinkQueryHandler(server, [row('Bar', '#', `${WS}/Bar.aplf`)]);

		await session.refreshLinkInfo(WS);

		assert.strictEqual(session.linkInfo.length, 1);
		assert.strictEqual(session.linkInfo[0].aplName, '#.Bar');
	});

	test('disconnect clears linkInfo', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 1);

		session.disconnect();

		assert.strictEqual(session.linkInfo.length, 0);
	});

	test('disconnect while a query is pending resolves it and does not poison the next load', async () => {
		setupLinkQueryHandler(server, null);   // never replies
		await connect();

		const pending = session.loadLinkInfo(WS);
		assert.ok(await waitFor(() => linkQueries(server).length === 1), 'query was sent');

		const start = Date.now();
		session.disconnect();
		await pending;
		assert.ok(Date.now() - start < 1000, 'pending load resolves promptly on disconnect');
		assert.strictEqual(session.linkInfo.length, 0);

		// A fresh connection must fetch again, not be marked loaded by the stale query.
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 1, 'next connection loads the table');
	});

	test('the table is dropped when the interpreter goes away, as on disconnect', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);

		server.hangUp();
		assert.ok(await waitFor(() => session.state === 'disconnected'), 'session noticed');

		assert.strictEqual(session.linkInfo.length, 0);
	});

	test('the interpreter going away while a query is pending resolves it and does not poison the next load', async () => {
		setupLinkQueryHandler(server, null);   // never replies
		await connect();

		const pending = session.loadLinkInfo(WS);
		assert.ok(await waitFor(() => linkQueries(server).length === 1), 'query was sent');

		const start = Date.now();
		server.hangUp();
		await pending;
		assert.ok(Date.now() - start < 1000, 'pending load resolves promptly when the interpreter goes away');

		// A fresh connection fetches at once: no dead query to wait for, no back-off.
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);
		assert.strictEqual(session.linkInfo.length, 1, 'next connection loads the table');
	});

	test('getLinkedFile returns mapped path for known name', async () => {
		setupLinkQueryHandler(server, [row('Foo', '#', `${WS}/Foo.aplf`)]);
		await connect();
		await session.loadLinkInfo(WS);

		const linked = await session.getLinkedFile('#.Foo');
		assert.ok(linked, 'should resolve linked path');
		assert.ok(linked!.endsWith('Foo.aplf'));
	});

	test('getLinkedFile returns undefined for unknown name', async () => {
		setupLinkQueryHandler(server, []);
		await connect();
		await session.loadLinkInfo(WS);

		const linked = await session.getLinkedFile('#.Nonexistent');
		assert.strictEqual(linked, undefined);
	});

	test('seedLinkInfo helper populates linkInfo and getLinkedFile', async () => {
		seedLinkInfo(session, [
			{ aplName: '#.Foo', filePath: '/test/Foo.aplf', startLine: 0 },
		]);

		assert.strictEqual(session.linkInfo.length, 1);
		const linked = await session.getLinkedFile('#.Foo');
		assert.strictEqual(linked, '/test/Foo.aplf');
	});
});
