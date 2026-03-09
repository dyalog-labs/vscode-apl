import * as Net from 'net';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AplRuntime, FileAccessor } from '../../aplRuntime';
import { AplSession } from '../../aplSession';
import { MockRideServer } from './mockRideServer';

/**
 * Abstraction over what's providing the RIDE server — either a MockRideServer
 * or a real Dyalog interpreter. Tests written against this interface can run
 * against both backends.
 */
export interface TestBackend {
	readonly type: 'mock' | 'dyalog';
	readonly session: AplSession;
	readonly runtime: AplRuntime;

	/**
	 * Define a function in the interpreter and make it available for breakpoints.
	 * Returns the file path and startLine for use with setBreakPoint().
	 *
	 * Mock: injects _linkInfo entries directly.
	 * Dyalog: writes an .aplf file, Links the workspace, reads linkInfo via 5177⌶.
	 */
	defineFunction(name: string, text: string[]): Promise<{ filePath: string; startLine: number }>;

	/** Tear down the backend, disconnect, clean up. */
	teardown(): Promise<void>;
}

// ─── Mock backend ────────────────────────────────────────────────────

const mockFileAccessor: FileAccessor = {
	isWindows: false,
	checkExists: async () => false,
	deleteFile: async () => {},
	readFile: async () => new Uint8Array(),
	writeFile: async () => {},
};

export class MockBackend implements TestBackend {
	readonly type = 'mock' as const;
	readonly session: AplSession;
	readonly runtime: AplRuntime;
	readonly server: MockRideServer;

	private constructor(server: MockRideServer, session: AplSession, runtime: AplRuntime) {
		this.server = server;
		this.session = session;
		this.runtime = runtime;
	}

	static async create(): Promise<MockBackend> {
		const server = new MockRideServer();
		await server.start();

		const session = new AplSession();
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', server.port);
		await readyPromise;

		const runtime = new AplRuntime(mockFileAccessor);
		(runtime as any)._session = session;
		session.setDebugHandler((command: string, args: any) => {
			(runtime as any).handleMessage([command, args]);
		});

		return new MockBackend(server, session, runtime);
	}

	async defineFunction(name: string, _text: string[]): Promise<{ filePath: string; startLine: number }> {
		const filePath = `/mock/${name}.aplf`;
		const startLine = 0;
		const linkInfo = (this.runtime as any)._linkInfo;
		linkInfo.push({ aplName: name, filePath, startLine });
		return { filePath, startLine };
	}

	async teardown(): Promise<void> {
		this.session.clearDebugHandler();
		this.session.disconnect();
		this.server.stop();
	}
}

// ─── Real Dyalog backend ────────────────────────────────────────────

export class DyalogBackend implements TestBackend {
	readonly type = 'dyalog' as const;
	readonly session: AplSession;
	readonly runtime: AplRuntime;
	private _process: cp.ChildProcess;
	private _tempDir: string;
	private _linked = false;

	private constructor(proc: cp.ChildProcess, session: AplSession, runtime: AplRuntime, tempDir: string) {
		this._process = proc;
		this.session = session;
		this.runtime = runtime;
		this._tempDir = tempDir;
	}

	static async create(): Promise<DyalogBackend> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apl-test-'));
		const port = await findFreePort();

		// Create .vscode dir for link.json (same as the extension expects)
		fs.mkdirSync(path.join(tempDir, '.vscode'), { recursive: true });

		const proc = cp.spawn('dyalog', ['+s', '-q'], {
			env: {
				...process.env,
				RIDE_INIT: `SERVE:127.0.0.1:${port}`,
				CLEARWS: '1',
			},
			stdio: 'ignore',
		});

		// Wait for the RIDE port to be available
		await waitForPort(port, 5000);

		const session = new AplSession();
		const readyPromise = new Promise<void>(resolve => {
			session.once('ready', resolve);
		});
		await session.connect('127.0.0.1', port);
		await readyPromise;

		const fileAccessor: FileAccessor = {
			isWindows: false,
			checkExists: async (filePath: string, timeout: number) => {
				const start = Date.now();
				while (Date.now() - start < timeout) {
					if (fs.existsSync(filePath)) return true;
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				return false;
			},
			deleteFile: async (p: string) => { try { fs.unlinkSync(p); } catch {} },
			readFile: async (p: string) => fs.readFileSync(p),
			writeFile: async (p: string, data: Uint8Array) => fs.writeFileSync(p, data),
		};

		const runtime = new AplRuntime(fileAccessor);
		(runtime as any)._session = session;
		// Set _folder so getLinkInfo() knows where to write link.json
		(runtime as any)._folder = tempDir;
		(runtime as any)._link = path.join(tempDir, '.vscode', 'link.json');
		session.setDebugHandler((command: string, args: any) => {
			(runtime as any).handleMessage([command, args]);
		});

		const backend = new DyalogBackend(proc, session, runtime, tempDir);

		// Clear # so Link.Create succeeds (same as the real extension)
		await backend._exec(')clear');

		return backend;
	}

	async defineFunction(name: string, text: string[]): Promise<{ filePath: string; startLine: number }> {
		const filePath = path.join(this._tempDir, `${name}.aplf`);
		fs.writeFileSync(filePath, text.join('\n') + '\n');

		if (!this._linked) {
			// Write file first, then Link — so Link discovers it on initial scan
			await this._exec(`⎕SE.Link.Create '#' '${this._tempDir.replace(/\\/g, '/')}'`);
			this._linked = true;
		} else {
			// Already linked — notify Link about the new file via Add
			await this._exec(`⎕SE.Link.Add '#.${name}'`);
		}

		// Use the same mechanism as the extension: 5177⌶ → link.json → parse
		await (this.runtime as any).getLinkInfo();

		// Find this function's entry in linkInfo
		const info = (this.runtime as any)._linkInfo.find(
			(r: any) => r.aplName === name || r.aplName === `#.${name}`
		);
		return {
			filePath: info?.filePath || filePath,
			startLine: info?.startLine || 0,
		};
	}

	/**
	 * Execute APL and wait for completion.
	 * Watches for SetPromptType (type > 0) as the completion signal,
	 * same pattern as gritt's Execute().
	 */
	_exec(expression: string): Promise<void> {
		return new Promise<void>((resolve) => {
			const origHandler = (this.session as any)._debugHandler;
			let resolved = false;
			const done = () => {
				if (resolved) return;
				resolved = true;
				this.session.setDebugHandler(origHandler);
				clearTimeout(timer);
				resolve();
			};
			const wrappedHandler = (command: string, args: any) => {
				if (origHandler) origHandler(command, args);
				if (command === 'SetPromptType' && args.type > 0) {
					done();
				}
			};
			this.session.setDebugHandler(wrappedHandler);

			const timer = setTimeout(done, 10000);
			this.session.execute(expression);
		});
	}

	async teardown(): Promise<void> {
		this.session.clearDebugHandler();
		this.session.disconnect();
		this._process.kill();

		// Clean up temp directory
		try {
			fs.rmSync(this._tempDir, { recursive: true, force: true });
		} catch {}
	}
}

// ─── Utilities ───────────────────────────────────────────────────────

async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = Net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as Net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await new Promise<void>((resolve, reject) => {
				const sock = Net.createConnection(port, '127.0.0.1');
				sock.once('connect', () => { sock.destroy(); resolve(); });
				sock.once('error', reject);
			});
			return;
		} catch {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	throw new Error(`Port ${port} not available after ${timeoutMs}ms`);
}

// ─── Backend factory ─────────────────────────────────────────────────

/** Check whether `dyalog` is available on PATH. */
export function isDyalogAvailable(): boolean {
	try {
		cp.execSync('which dyalog', { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns the list of backend types to test against.
 * Always includes 'mock'. Includes 'dyalog' when the interpreter is available
 * and the DYALOG_TESTS env var is set (to avoid slow tests by default).
 */
export function getBackends(): Array<'mock' | 'dyalog'> {
	const backends: Array<'mock' | 'dyalog'> = ['mock'];
	if (process.env.DYALOG_TESTS && isDyalogAvailable()) {
		backends.push('dyalog');
	}
	return backends;
}

export async function createBackend(type: 'mock' | 'dyalog'): Promise<TestBackend> {
	if (type === 'dyalog') {
		return DyalogBackend.create();
	}
	return MockBackend.create();
}
