import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as Net from 'net';
import * as Path from 'path';
import * as vscode from 'vscode';
import { findDyalogExe } from './findDyalogExe';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'busy';

export interface LinkInfoRow {
	aplName: string;
	filePath: string;
	startLine: number;
}

/**
 * The Link table arrives as ShowHTML messages (3500⌶) whose payload is
 * `<marker><query id>:<count>:<piece of JSON>`: the marker because not
 * every interpreter accepts the caption argument, the id so a late reply
 * to an earlier query is ignored. Pieces arrive in order.
 */
export const LINK_INFO_MARKER = 'vscode-apl:link-info:';
const LINK_INFO_CHUNK_RE = /^vscode-apl:link-info:(\d+):(\d+):/;

/**
 * Characters per 3500⌶ call: its cost grows faster than the payload (300 KB
 * never arrives), so a large table goes as many small messages.
 */
const LINK_INFO_CHUNK_SIZE = 10000;

/**
 * The query, one statement per line here, joined with ⋄ into one Execute:
 * the loaded-file table (5177⌶) as JSON rows of [name parent file startLine],
 * without ⎕SE rows, in pieces tagged with `id`; [] when nothing is linked.
 */
const linkInfoQuery = (id: number) => [
	'{}{⎕IO ⎕ML←1 1',
	// the table as text (refs → names); empty if Link is absent or unused
	'r←⍕¨↑{6::⍬ ⋄ 0=≢⎕SE.Link.Links:⍬ ⋄ 5177⌶⍬}⍬',
	// nothing loaded: ↑ gave a vector, so reply [] here
	`0=≢r:3500⌶'${LINK_INFO_MARKER}${id}:1:[]'`,
	// keep name parent file startLine; drop rows under ⎕SE
	"r←r[;1 2 4 5]⌿⍨(⊂'⎕SE')≢¨3↑¨r[;2]",
	// JSON of the rows in pieces of LINK_INFO_CHUNK_SIZE, each tagged with id and count
	'json←⎕JSON↓r',
	`chunks←json⊂⍨(≢json)⍴1,${LINK_INFO_CHUNK_SIZE - 1}⍴0`,
	`{3500⌶'${LINK_INFO_MARKER}${id}:',(⍕≢chunks),':',⍵}¨chunks}⍬`,
].join(' ⋄ ');

/**
 * Manages a shared APL interpreter session via RIDE protocol.
 * Can be used by both the REPL panel and debug sessions.
 */
export class AplSession extends EventEmitter {
	private _client?: Net.Socket;
	private _child?: cp.ChildProcess;
	private _server?: Net.Server;
	private _state: ConnectionState = 'disconnected';
	private _promptType = 0;
	private _messageQueue: Array<[string, any]> = [];
	private _lastRundown = 0;
	private _rundownTimeout = 0;
	private _maxLogLength = 1000;
	private _verbose = false;

	public set verbose(v: boolean) { this._verbose = v; }

	// Debug handler for delegating debug-specific messages
	private _debugHandler?: (command: string, args: any) => void;

	// Pending debug messages buffered when no debug handler is attached
	private _pendingDebugMessages: Array<[string, any]> = [];
	private _isSuspended = false;
	private _editWindowTokens = new Set<number>();

	// The Link table, fetched once over RIDE (linkInfoQuery); cleared on disconnect.
	private _linkInfo: LinkInfoRow[] = [];
	private _linkMap = new Map<string, string>();
	private _linkInfoLoading?: Promise<void>;
	private _linkInfoLoaded = false;

	// Waiter for the in-flight 5177⌶ query (see _queryLinkInfo).
	private _pendingLinkInfo?: {
		id: number;
		text: string;
		started: () => void;
		chunk: (data: string, total: number) => void;
		abort: () => void;
	};
	private _linkInfoQueryId = 0;
	// Set after a query got no reply: loadLinkInfo waits until then, so callers
	// are not stalled on every breakpoint change. refreshLinkInfo ignores it.
	private _linkInfoRetryAt = 0;

	/**
	 * Longest the query may wait in the input queue before we give up. The
	 * interpreter echoes a line when it starts on it; until then it may be
	 * busy with earlier input, so this is generous.
	 */
	public linkInfoQueueTimeoutMs = 60000;

	/**
	 * Longest silence once the interpreter has started on the query. The timer
	 * restarts on every chunk, so only a lost reply times out.
	 */
	public linkInfoTimeoutMs = 5000;

	/** How long loadLinkInfo waits after a query got no reply before trying again. */
	public linkInfoRetryDelayMs = 30000;

	public get state(): ConnectionState {
		return this._state;
	}

	public get isConnected(): boolean {
		return this._state === 'connected' || this._state === 'busy';
	}

	/**
	 * Set a debug handler to receive debug-specific RIDE messages.
	 * Used by AplRuntime when attaching to an existing session.
	 */
	public setDebugHandler(handler: (command: string, args: any) => void): void {
		// Flush any queued messages with the current (old) handler state before
		// switching.  This prevents a race where messages already in _messageQueue
		// (waiting on the 20 ms debounce) would be processed *after* the handler
		// is set, bypassing _pendingDebugMessages and reaching the runtime before
		// _linkMap is populated.
		if (this._rundownTimeout) {
			clearTimeout(this._rundownTimeout);
			this._rundownTimeout = 0;
		}
		this.rundown();
		this._debugHandler = handler;
	}

	/**
	 * Clear the debug handler (called when debug session ends).
	 */
	public clearDebugHandler(): void {
		this._debugHandler = undefined;
	}

	/**
	 * Check if a debug handler is attached.
	 */
	public get hasDebugHandler(): boolean {
		return this._debugHandler !== undefined;
	}

	/**
	 * Check if the interpreter is in a suspended state (untrapped error).
	 */
	public get isSuspended(): boolean {
		return this._isSuspended;
	}

	/**
	 * Number of buffered debug messages waiting for replay.
	 */
	public get pendingDebugMessageCount(): number {
		return this._pendingDebugMessages.length;
	}

	/**
	 * Replay buffered debug messages through the debug handler.
	 * Called after a debug session attaches to handle a suspended state.
	 */
	public replayPendingMessages(): void {
		if (!this._debugHandler) {
			return;
		}
		const messages = this._pendingDebugMessages.splice(0);
		for (const [command, args] of messages) {
			this._debugHandler(command, args);
		}
	}

	/**
	 * Get the underlying socket client (for AplRuntime attachment).
	 */
	public get client(): Net.Socket | undefined {
		return this._client;
	}

	/**
	 * Start a new Dyalog interpreter and connect to it
	 */
	public async spawn(exe?: string): Promise<void> {
		if (this.isConnected) {
			return;
		}

		this.setState('connecting');

		const config = vscode.workspace.getConfiguration('apl');
		const configuredPath = exe || config.get<string>('interpreter.path');
		const interpreterPath = configuredPath || findDyalogExe() || 'dyalog.exe';

		if (!configuredPath && interpreterPath === 'dyalog.exe') {
			this.setState('disconnected');
			const err = new Error(
				'Could not find Dyalog APL. Please set "apl.interpreter.path" in settings ' +
				'or ensure Dyalog APL is installed in the default location.'
			);
			throw err;
		}

		this.log(`Using interpreter: ${interpreterPath}`);

		/* eslint-disable @typescript-eslint/naming-convention */
		const env = {
			APLK0: 'default',
			AUTOCOMPLETE_PREFIXSIZE: '0',
			CLASSICMODE: '1',
			SINGLETRACE: '1',
			RIDE_SPAWNED: '1',
			TRACE_ON_ERROR: '1',
		};
		/* eslint-enable @typescript-eslint/naming-convention */

		return new Promise((resolve, reject) => {
			this._server = Net.createServer((socket) => {
				this.log('Interpreter connected');
				this._server?.close();
				this._server = undefined;
				this._client = socket;
				this.initConnection();
				resolve();
			});

			this._server.on('error', (e) => {
				this.setState('disconnected');
				reject(e);
			});

			this._server.listen(0, '127.0.0.1', () => {
				const addr = this._server!.address() as Net.AddressInfo;
				const hp = `${addr.address}:${addr.port}`;
				this.log(`Listening on ${hp}, spawning interpreter...`);

				let args = ['+s', '-q', '-nokbd'];
				const stdio: cp.StdioOptions = ['pipe', 'ignore', 'ignore'];
				if (/^win/i.test(process.platform)) {
					args = [];
					stdio[0] = 'ignore';
				}

				try {
					this._child = cp.spawn(interpreterPath, args, {
						stdio,
						detached: true,
						env: {
							...process.env,
							...env,
							RIDE_INIT: `CONNECT:${hp}`, // eslint-disable-line @typescript-eslint/naming-convention
						},
					});
				} catch (e) {
					this.setState('disconnected');
					reject(e);
					return;
				}

				this._child.on('exit', (code, sig) => {
					this._server?.close();
					if (code !== 0) {
						this.log(`Interpreter ${code !== null ? `exited with code ${code}` : `received ${sig}`}`);
					}
					this.setState('disconnected');
					this.emit('end');
				});

				this._child.on('error', (e) => {
					this._server?.close();
					this.setState('disconnected');
					reject(e);
				});
			});
		});
	}

	/**
	 * Connect to an existing RIDE session
	 */
	public async connect(host?: string, port?: number): Promise<void> {
		if (this.isConnected) {
			return;
		}

		this.setState('connecting');

		const config = vscode.workspace.getConfiguration('apl');
		const rideHost = host || config.get<string>('ride.host') || '127.0.0.1';
		const ridePort = port || config.get<number>('ride.port') || 4502;

		// Warn when connecting to a non-localhost host (unencrypted RIDE protocol)
		if (!['127.0.0.1', 'localhost', '::1'].includes(rideHost)) {
			const choice = await vscode.window.showWarningMessage(
				`Connecting to remote RIDE host "${rideHost}:${ridePort}". The connection is unencrypted and unauthenticated. Continue?`,
				{ modal: true },
				'Connect'
			);
			if (choice !== 'Connect') {
				this.setState('disconnected');
				throw new Error('Connection cancelled by user');
			}
		}

		return new Promise((resolve, reject) => {
			this._client = Net.createConnection({ host: rideHost, port: ridePort }, () => {
				this.log(`Connected to ${rideHost}:${ridePort}`);
				this.initConnection();
				resolve();
			});

			this._client.on('error', (e) => {
				this.setState('disconnected');
				reject(e);
			});
		});
	}

	/**
	 * Disconnect from the interpreter
	 */
	public disconnect(): void {
		if (this._client) {
			this.sendMessage('Exit', { code: 0 });
			this._client.destroy();
			this._client = undefined;
		}
		if (this._child) {
			this._child.kill();
			this._child = undefined;
		}
		if (this._server) {
			this._server.close();
			this._server = undefined;
		}
		this._pendingDebugMessages = [];
		this._isSuspended = false;
		this._editWindowTokens.clear();
		this._linkInfo = [];
		this._linkMap.clear();
		this._linkInfoLoaded = false;
		this._linkInfoLoading = undefined;
		this._linkInfoRetryAt = 0;
		this._pendingLinkInfo?.abort();
		this.setState('disconnected');
	}

	/**
	 * Send interrupt signal
	 */
	public interrupt(): void {
		if (this.isConnected) {
			this.sendMessage('StrongInterrupt', {});
		}
	}

	/**
	 * Execute APL code
	 */
	public execute(code: string, trace: number = 0): void {
		if (!this.isConnected) {
			this.emit('output', '[Not connected to interpreter]', 'error');
			return;
		}
		const text = code.endsWith('\n') ? code : `${code}\n`;
		this.sendMessage('Execute', { trace, text });
	}

	/** Snapshot of cached Link rows (empty if Link is inactive or load hasn't run). */
	public get linkInfo(): readonly LinkInfoRow[] {
		return this._linkInfo;
	}

	/** Sync map lookup. Empty until loadLinkInfo completes. */
	public linkedFileFor(name: string): string | undefined {
		return this._linkMap.get(name);
	}

	/**
	 * Look up the file backing a linked APL name. Async to keep the API stable
	 * while a load may still be in flight (callers attach immediately after the
	 * session emits 'ready', before loadLinkInfo's promise has settled).
	 */
	public async getLinkedFile(name: string): Promise<string | undefined> {
		if (this._linkInfoLoading) { await this._linkInfoLoading; }
		return this._linkMap.get(name);
	}

	/**
	 * Bulk-fetch the interpreter's Link table via 5177⌶ and cache it.
	 * Idempotent: returns immediately if already loaded; coalesces concurrent
	 * callers onto a single in-flight promise. Silently no-ops without a
	 * folder (debug-only sessions, no workspace) or when Link is unavailable.
	 */
	public async loadLinkInfo(folder: string): Promise<void> {
		if (this._linkInfoLoaded) { return; }
		if (this._linkInfoLoading) { return this._linkInfoLoading; }
		if (!folder || !this.isConnected) { return; }
		if (Date.now() < this._linkInfoRetryAt) { return; }

		this._linkInfoLoading = this._doLoadLinkInfo().finally(() => {
			this._linkInfoLoading = undefined;
		});
		return this._linkInfoLoading;
	}

	/** Drop cached Link info and re-fetch. Used when Link state may have changed. */
	public async refreshLinkInfo(folder: string): Promise<void> {
		this._linkInfoLoaded = false;
		this._linkInfoRetryAt = 0;
		this._linkInfo = [];
		this._linkMap.clear();
		return this.loadLinkInfo(folder);
	}

	private async _doLoadLinkInfo(): Promise<void> {
		const json = await this._queryLinkInfo();
		// Disconnected while waiting: the cache was reset for the next connection; leave it.
		if (!this.isConnected) { return; }

		if (json === undefined) {
			// Leave the cache unloaded so a later load tries again, after a pause.
			this._linkInfoRetryAt = Date.now() + this.linkInfoRetryDelayMs;
			this.log('No reply to Link info query — will try again later');
			return;
		}
		try {
			// Rows are [name, parent, file, startLine] — see linkInfoQuery.
			const rows: LinkInfoRow[] = JSON.parse(json)
				.map((row: string[]) => {
					const aplName = row[0][0] === '#' ? row[0] : `${row[1]}.${row[0]}`;
					const filePath = Path.resolve(row[2]);
					const startLine = +row[3];
					return { aplName, filePath, startLine };
				});
			this._linkInfo = rows;
			this._linkMap.clear();
			for (const r of rows) {
				this._linkMap.set(r.aplName, r.filePath);
				this._linkMap.set(r.filePath, r.aplName);
			}
		} catch (e) {
			this.log(`Failed to parse link info: ${(e as Error).message}`);
		}
		this._linkInfoLoaded = true;
	}

	/**
	 * Send the query and wait for its reply: ShowHTML pieces tagged with
	 * LINK_INFO_MARKER and this id, routed here by handleMessage and joined.
	 * Resolves with the JSON, or undefined after the queue or idle timeout or
	 * a disconnect.
	 */
	private _queryLinkInfo(): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve) => {
			const id = ++this._linkInfoQueryId;
			const text = `${linkInfoQuery(id)}\n`;
			const parts: string[] = [];
			let timer: ReturnType<typeof setTimeout> | undefined;

			const finish = (json?: string) => {
				clearTimeout(timer);
				if (this._pendingLinkInfo === waiter) { this._pendingLinkInfo = undefined; }
				resolve(json);
			};
			const arm = (ms: number) => {
				clearTimeout(timer);
				timer = setTimeout(() => finish(), ms);
			};
			const waiter = {
				id,
				text,
				started: () => arm(this.linkInfoTimeoutMs),
				chunk: (data: string, total: number) => {
					parts.push(data);
					if (parts.length >= total) { finish(parts.join('')); } else { arm(this.linkInfoTimeoutMs); }
				},
				abort: () => finish(),
			};

			this._pendingLinkInfo = waiter;
			arm(this.linkInfoQueueTimeoutMs);
			this.sendMessage('Execute', { trace: 0, text });
		});
	}

	/**
	 * Get autocomplete suggestions
	 */
	public getAutocomplete(line: string, pos: number, token: number): void {
		if (this.isConnected) {
			this.sendMessage('GetAutocomplete', { line, pos, token });
		}
	}

	private setState(state: ConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this.emit('stateChanged', state);
		}
	}

	private initConnection(): void {
		let buffer = Buffer.alloc(0x100000);
		let bufferOffset = 0;
		let bufferLength = 0;
		let handshakeDone = false;

		this._client?.on('data', (data) => {
			// Grow buffer if needed
			if (bufferLength + data.length > buffer.length) {
				const needed = bufferLength + data.length;
				const newBuffer = Buffer.alloc(Math.max(needed, 0x100000, 2 ** Math.ceil(Math.log2(needed))));
				buffer.copy(newBuffer, 0, bufferOffset, bufferOffset + bufferLength);
				bufferOffset = 0;
				buffer = newBuffer;
			} else if (bufferOffset + bufferLength + data.length > buffer.length) {
				buffer.copy(buffer, 0, bufferOffset, bufferOffset + bufferLength);
				bufferOffset = 0;
			}

			data.copy(buffer, bufferOffset + bufferLength, 0, data.length);
			bufferLength += data.length;

			// Process complete messages
			let messageLength: number;
			while (bufferLength >= 4 && (messageLength = buffer.readInt32BE(bufferOffset)) <= bufferLength) {
				if (messageLength <= 8) {
					this.log('Bad protocol message');
					break;
				}
				const message = buffer.slice(bufferOffset + 8, bufferOffset + messageLength).toString();
				bufferOffset += messageLength;
				bufferLength -= messageLength;

				if (this._verbose) { this.log(`recv ${this.truncate(message)}`); }

				if (message[0] === '[') {
					const parsed = JSON.parse(message);
					this.queueMessage(parsed[0], parsed[1]);
				} else if (/^UsingProtocol=/.test(message)) {
					if (message.slice(message.indexOf('=') + 1) === '2') {
						handshakeDone = true;
					}
				}
			}
		});

		this._client?.on('error', (e) => {
			this.log(`Socket error: ${e.message}`);
			this.emit('error', e);
		});

		this._client?.on('end', () => {
			if (handshakeDone) {
				this.log('Interpreter disconnected');
			}
			this.setState('disconnected');
			this.emit('end');
		});

		// Send handshake
		this.sendRaw([
			'SupportedProtocols=2',
			'UsingProtocol=2',
			'["Identify",{"identity":1}]',
			'["Connect",{"remoteId":2}]',
			'["GetWindowLayout",{}]',
			'["Subscribe",{"status":["statusfields"]}]'
		]);
	}

	private queueMessage(command: string, args: any): void {
		this._messageQueue.push([command, args]);
		this.requestRundown();
	}

	private requestRundown(): void {
		if (!this._rundownTimeout) {
			if (Date.now() - this._lastRundown < 20) {
				this._rundownTimeout = +setTimeout(() => this.rundown(), 20);
			} else {
				this.rundown();
			}
		}
	}

	private rundown(): void {
		while (this._messageQueue.length) {
			const [command, args] = this._messageQueue.shift()!;
			this.handleMessage(command, args);
		}
		this._lastRundown = Date.now();
		this._rundownTimeout = 0;
	}

	private handleMessage(command: string, args: any): void {
		// The Link-table reply (see _queryLinkInfo) is ours alone: not for the HTML viewer or the debugger.
		if (command === 'ShowHTML' && typeof args?.html === 'string' && args.html.startsWith(LINK_INFO_MARKER)) {
			const m = LINK_INFO_CHUNK_RE.exec(args.html);
			const waiter = this._pendingLinkInfo;
			if (m && waiter && +m[1] === waiter.id) {
				waiter.chunk(args.html.slice(m[0].length), +m[2]);
			} else if (m) {
				this.log(`Ignoring link info reply for query ${m[1]} (waiting for ${waiter?.id ?? 'none'})`);
			}
			return;
		}

		// When debug handler is attached, forward ALL messages to it first
		// This allows AplRuntime to process messages it needs (SetPromptType, EchoInput, etc.)
		if (this._debugHandler) {
			this._debugHandler(command, args);
		}

		// Then handle REPL-specific processing
		switch (command) {
			case 'Identify':
				this.log(`Connected to Dyalog APL ${args.version}`);
				break;

			case 'SetPromptType':
				this._promptType = args.type;
				if (args.type === 1) {
					this.setState('connected');
					this.emit('ready');
				} else if (args.type === 0) {
					this.setState('busy');
				}
				break;

			case 'AppendSessionOutput':
				if (this._debugHandler) {
					// Emit for REPL display (debug handler handles execution separately)
					this.emit('output', args.result, 'result');
					break;
				}
				// Batch consecutive output messages
				let output = args.result;
				while (this._messageQueue.length && this._messageQueue[0][0] === 'AppendSessionOutput') {
					output += this._messageQueue.shift()![1].result;
				}
				this.emit('output', output, 'result');
				break;

			case 'EchoInput': {
				// The interpreter echoes a line when it starts on it: the reply timer may begin.
				const pendingLink = this._pendingLinkInfo;
				if (pendingLink && pendingLink.text === args.input) {
					pendingLink.started();
				}
				if (!this._debugHandler) {
					this.emit('echo', args.input);
				}
				break;
			}

			case 'HadError':
				if (!this._debugHandler) {
					this._pendingDebugMessages.push([command, args]);
				}
				break;

			case 'OpenWindow':
				if (!this._debugHandler) {
					if (args.debugger) {
						this._pendingDebugMessages.push([command, args]);
					} else {
						this._editWindowTokens.add(args.token);
						this.emit('editWindow', args);
					}
				}
				break;

			case 'UpdateWindow':
				if (!this._debugHandler) {
					if (this._editWindowTokens.has(args.token)) {
						this.emit('updateEditWindow', args);
					} else {
						this._pendingDebugMessages.push([command, args]);
					}
				}
				break;

			case 'GotoWindow':
				if (!this._debugHandler) {
					if (this._editWindowTokens.has(args.win)) {
						this.emit('gotoEditWindow', args);
					} else {
						this._pendingDebugMessages.push([command, args]);
					}
				}
				break;

			case 'SetHighlightLine':
				if (!this._debugHandler) {
					this._pendingDebugMessages.push([command, args]);
					this._isSuspended = true;
					this.emit('suspended');
				}
				break;

			case 'CloseWindow':
				if (!this._debugHandler) {
					if (this._editWindowTokens.has(args.win)) {
						this._editWindowTokens.delete(args.win);
						this.emit('closeEditWindow', args);
					} else {
						if (this._pendingDebugMessages.length > 0) {
							this._pendingDebugMessages.push([command, args]);
						}
						this._isSuspended = false;
					}
				}
				break;

			case 'ReplySaveChanges':
				if (this._editWindowTokens.has(args.win)) {
					this.emit('replySaveChanges', args);
				}
				break;

			case 'OptionsDialog':
				// Dyalog raises this for errors like a SaveChanges parse
				// failure ("can't fix").  If we never reply, the interpreter
				// blocks waiting for our index.  In debug mode aplRuntime's
				// own handler runs first; in REPL mode we surface it as a
				// VS Code modal and route the user's choice back.
				if (!this._debugHandler) {
					this._handleOptionsDialog(args);
				}
				break;

			case 'StatusOutput':
				this.emit('output', args.text, 'error');
				break;

			case 'InterpreterStatus':
				this.emit('status', args);
				break;

			case 'ShowHTML':
				this.emit('showHtml', args);
				break;

			case 'ReplyGetAutocomplete':
				this.emit('autocomplete', args.options, args.skip, args.token);
				break;

			case 'Disconnect':
				this.log(`Disconnect: ${args.message}`);
				this.setState('disconnected');
				this.emit('end');
				break;

			case 'SysError':
				this.emit('output', `System Error: ${args.text}`, 'error');
				this.emit('end');
				break;
		}
	}

	/**
	 * Surface an OptionsDialog (e.g. Dyalog's "can't fix" save error) as a
	 * VS Code modal and route the user's choice back via ReplyOptionsDialog.
	 * Crucial: Dyalog blocks until we reply, so dismissing without an
	 * answer would deadlock the interpreter.  We treat Esc as the last
	 * option (typically Cancel/No).
	 */
	private async _handleOptionsDialog(args: any): Promise<void> {
		const options: string[] = Array.isArray(args.options) ? args.options : [];
		const message: string = args.text || args.title || 'Dyalog dialog';
		let index = options.length - 1;
		if (options.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				message, { modal: true }, ...options,
			);
			if (choice !== undefined) {
				const found = options.indexOf(choice);
				if (found >= 0) { index = found; }
			}
		} else {
			vscode.window.showWarningMessage(message);
			index = 0;
		}
		this.sendMessage('ReplyOptionsDialog', { token: args.token, index });
	}

	/**
	 * Send a RIDE protocol message to the interpreter.
	 * Public to allow AplRuntime to send messages through shared session.
	 */
	public sendMessage(command: string, args: object): void {
		if (this._client) {
			const message = JSON.stringify([command, args]);
			if (this._verbose) { this.log(`send ${this.truncate(message)}`); }
			this._client.write(this.toBuffer(message));
		}
	}

	private sendRaw(messages: string[]): void {
		if (this._client) {
			if (this._verbose) { messages.forEach(m => this.log(`send ${this.truncate(m)}`)); }
			this._client.write(Buffer.concat(messages.map(m => this.toBuffer(m))));
		}
	}

	private toBuffer(message: string): Buffer {
		const buf = Buffer.from(`xxxxRIDE${message}`);
		buf.writeInt32BE(buf.length, 0);
		return buf;
	}

	private truncate(s: string): string {
		return s.length > this._maxLogLength ? `${s.slice(0, this._maxLogLength - 3)}...` : s;
	}

	private log(message: string): void {
		console.log(`[AplSession] ${message}`);
	}
}
