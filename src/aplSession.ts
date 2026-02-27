import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as Net from 'net';
import * as Path from 'path';
import * as vscode from 'vscode';

/**
 * Find Dyalog APL installation on Windows
 */
function findDyalogExe(): string | undefined {
	if (!/^win/i.test(process.platform)) {
		return undefined;
	}

	// Check common installation directories
	const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
	const dyalogBase = Path.join(programFiles, 'Dyalog');

	if (!fs.existsSync(dyalogBase)) {
		return undefined;
	}

	try {
		// List all Dyalog installations and find the latest version
		const dirs = fs.readdirSync(dyalogBase)
			.filter(d => /^Dyalog APL/i.test(d))
			.sort()
			.reverse(); // Latest version first

		for (const dir of dirs) {
			const exePath = Path.join(dyalogBase, dir, 'dyalog.exe');
			if (fs.existsSync(exePath)) {
				return exePath;
			}
		}
	} catch {
		// Ignore errors reading directory
	}

	return undefined;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'busy';

/**
 * Manages a shared APL interpreter session via RIDE protocol.
 * Can be used by both the REPL panel and debug sessions.
 */
export class AplSession extends EventEmitter {
	private static _instance: AplSession | undefined;

	private _client?: Net.Socket;
	private _child?: cp.ChildProcess;
	private _server?: Net.Server;
	private _state: ConnectionState = 'disconnected';
	private _promptType = 0;
	private _messageQueue: Array<[string, any]> = [];
	private _lastRundown = 0;
	private _rundownTimeout = 0;
	private _maxLogLength = 1000;

	public static getInstance(): AplSession {
		if (!AplSession._instance) {
			AplSession._instance = new AplSession();
		}
		return AplSession._instance;
	}

	private constructor() {
		super();
	}

	public get state(): ConnectionState {
		return this._state;
	}

	public get isConnected(): boolean {
		return this._state === 'connected' || this._state === 'busy';
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
				const newBuffer = Buffer.alloc(2 ** Math.ceil(Math.log(bufferLength + data.length) / Math.log(2)));
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

				this.log(`recv ${this.truncate(message)}`);

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
				// Batch consecutive output messages
				let output = args.result;
				while (this._messageQueue.length && this._messageQueue[0][0] === 'AppendSessionOutput') {
					output += this._messageQueue.shift()![1].result;
				}
				this.emit('output', output, 'result');
				break;

			case 'EchoInput':
				this.emit('echo', args.input);
				break;

			case 'HadError':
				// Error occurred
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
				this.emit('autocomplete', args.options, args.token);
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

			default:
				// Ignore other messages for REPL
				break;
		}
	}

	private sendMessage(command: string, args: object): void {
		if (this._client) {
			const message = JSON.stringify([command, args]);
			this.log(`send ${this.truncate(message)}`);
			this._client.write(this.toBuffer(message));
		}
	}

	private sendRaw(messages: string[]): void {
		if (this._client) {
			messages.forEach(m => this.log(`send ${this.truncate(m)}`));
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
