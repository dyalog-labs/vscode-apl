import * as assert from 'assert';
import * as vscode from 'vscode';
import { ReplManager } from '../../repl/replManager';

/**
 * The DAP tracker only sees debug sessions created AFTER its factory is
 * registered. If the VsCodeDebugBridge is created lazily on the first
 * eval-server start, a debug session already running at that point is
 * adopted for requests but its events never reach `/debug listen` —
 * the client gets a successful [Listening] ack and then silence.
 *
 * The fix is structural: the bridge (and with it the tracker factory)
 * must be created during extension activation, before any debug session
 * can exist.
 */

suite('ReplManager — debug bridge lifecycle', () => {
	function aplFactoryCount(): number {
		return (vscode.debug as any).trackerFactories
			.filter((f: { type: string }) => f.type === 'apl').length;
	}

	const fakeContext: any = {
		globalState: {
			get: (_key: string, defaultValue: unknown) => defaultValue,
			update: async () => { /* */ },
		},
		subscriptions: [],
	};

	test('initialize() registers the apl tracker factory at activation', () => {
		const before = aplFactoryCount();
		ReplManager.getInstance().initialize(fakeContext);
		assert.strictEqual(
			aplFactoryCount(), before + 1,
			'the tracker factory must attach at activation — attached any later ' +
			'it can never observe a debug session the user has already started',
		);
	});

	test('initialize() twice does not register a second factory', () => {
		const manager = ReplManager.getInstance();
		manager.initialize(fakeContext);
		const before = aplFactoryCount();
		manager.initialize(fakeContext);
		assert.strictEqual(aplFactoryCount(), before, 'the bridge must be created once');
	});
});
