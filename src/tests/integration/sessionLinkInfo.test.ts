import assert = require('assert');
import * as fs from 'fs';
import * as os from 'os';
import * as Path from 'path';
import { AplSession } from '../../aplSession';
import { MockRideServer } from '../helpers/mockRideServer';
import { seedLinkInfo } from '../helpers/sessionTestUtils';

/**
 * Configure a mock Execute handler that intercepts the 5177⌶ link-info query
 * and writes controlled JSON to the path embedded in the expression. Always
 * echoes the input back and emits SetPromptType so awaiting code resolves.
 *
 * @param server  the mock RIDE server
 * @param rows    rows to write into link.json, or null to leave the file absent
 *                (simulating Link being unavailable / interpreter no-op)
 */
function setupLinkQueryHandler(server: MockRideServer, rows: string[][] | null) {
	server.onCommand('Execute', (args: { text: string }) => {
		const text = args.text;
		server.send('EchoInput', { input: text });

		if (text.includes('5177⌶') && rows !== null) {
			const m = /⎕NPUT '([^']+)'/.exec(text);
			if (m) {
				const linkPath = m[1];
				fs.mkdirSync(Path.dirname(linkPath), { recursive: true });
				fs.writeFileSync(linkPath, JSON.stringify(rows));
			}
		}

		server.send('SetPromptType', { type: 1 });
	});
}

suite('AplSession — link info loading', () => {
	let server: MockRideServer;
	let session: AplSession;
	let tempDir: string;

	setup(async () => {
		server = new MockRideServer();
		await server.start();
		session = new AplSession();
		tempDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'apl-session-test-'));
	});

	teardown(() => {
		session.disconnect();
		server.stop();
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	async function connect(): Promise<void> {
		const ready = new Promise<void>(r => session.once('ready', r));
		await session.connect('127.0.0.1', server.port);
		await ready;
	}

	function fwd(p: string): string { return p.replace(/\\/g, '/'); }

	test('loadLinkInfo populates linkInfo from successful query', async () => {
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', `${fwd(tempDir)}/Foo.aplf`, '0', 'utf8'],
			['Bar', '#', 'Function', `${fwd(tempDir)}/Bar.aplf`, '5', 'utf8'],
		]);
		await connect();

		await session.loadLinkInfo(tempDir);

		assert.strictEqual(session.linkInfo.length, 2);
		assert.ok(session.linkInfo.some(r => r.aplName === '#.Foo'));
		assert.ok(session.linkInfo.some(r => r.aplName === '#.Bar'));
		const bar = session.linkInfo.find(r => r.aplName === '#.Bar');
		assert.strictEqual(bar?.startLine, 5);
	});

	test('loadLinkInfo filters ⎕SE rows', async () => {
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', `${fwd(tempDir)}/Foo.aplf`, '0', 'utf8'],
			['SaltCmd', '⎕SE', 'Function', 'C:/Dyalog/spice/cmd.aplf', '0', 'utf8'],
		]);
		await connect();

		await session.loadLinkInfo(tempDir);

		assert.strictEqual(session.linkInfo.length, 1);
		assert.strictEqual(session.linkInfo[0].aplName, '#.Foo');
	});

	test('loadLinkInfo handles empty link list', async () => {
		setupLinkQueryHandler(server, []);
		await connect();

		await session.loadLinkInfo(tempDir);

		assert.strictEqual(session.linkInfo.length, 0);
	});

	test('loadLinkInfo handles missing file (Link unavailable)', async () => {
		setupLinkQueryHandler(server, null);
		await connect();

		await session.loadLinkInfo(tempDir);

		assert.strictEqual(session.linkInfo.length, 0);
	});

	test('loadLinkInfo is idempotent — second call sends no extra query', async () => {
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', `${fwd(tempDir)}/Foo.aplf`, '0', 'utf8'],
		]);
		await connect();

		await session.loadLinkInfo(tempDir);
		const afterFirst = server.getReceived('Execute')
			.filter((m: { text: string }) => m.text.includes('5177⌶')).length;

		await session.loadLinkInfo(tempDir);
		const afterSecond = server.getReceived('Execute')
			.filter((m: { text: string }) => m.text.includes('5177⌶')).length;

		assert.strictEqual(afterSecond, afterFirst,
			'second loadLinkInfo should not send another 5177⌶ query');
	});

	test('concurrent loadLinkInfo calls coalesce into one query', async () => {
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', `${fwd(tempDir)}/Foo.aplf`, '0', 'utf8'],
		]);
		await connect();

		await Promise.all([
			session.loadLinkInfo(tempDir),
			session.loadLinkInfo(tempDir),
		]);

		const executes = server.getReceived('Execute')
			.filter((m: { text: string }) => m.text.includes('5177⌶'));
		assert.strictEqual(executes.length, 1,
			'concurrent loadLinkInfo calls should share one query');
	});

	test('refreshLinkInfo clears cached state and re-fetches', async () => {
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', `${fwd(tempDir)}/Foo.aplf`, '0', 'utf8'],
		]);
		await connect();
		await session.loadLinkInfo(tempDir);
		assert.strictEqual(session.linkInfo.length, 1);

		setupLinkQueryHandler(server, [
			['Bar', '#', 'Function', `${fwd(tempDir)}/Bar.aplf`, '0', 'utf8'],
		]);

		await session.refreshLinkInfo(tempDir);

		assert.strictEqual(session.linkInfo.length, 1);
		assert.strictEqual(session.linkInfo[0].aplName, '#.Bar');
	});

	test('disconnect clears linkInfo', async () => {
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', `${fwd(tempDir)}/Foo.aplf`, '0', 'utf8'],
		]);
		await connect();
		await session.loadLinkInfo(tempDir);
		assert.strictEqual(session.linkInfo.length, 1);

		session.disconnect();

		assert.strictEqual(session.linkInfo.length, 0);
	});

	test('getLinkedFile returns mapped path for known name', async () => {
		const fooPath = `${fwd(tempDir)}/Foo.aplf`;
		setupLinkQueryHandler(server, [
			['Foo', '#', 'Function', fooPath, '0', 'utf8'],
		]);
		await connect();
		await session.loadLinkInfo(tempDir);

		const linked = await session.getLinkedFile('#.Foo');
		assert.ok(linked, 'should resolve linked path');
		assert.ok(linked!.endsWith('Foo.aplf'));
	});

	test('getLinkedFile returns undefined for unknown name', async () => {
		setupLinkQueryHandler(server, []);
		await connect();
		await session.loadLinkInfo(tempDir);

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
