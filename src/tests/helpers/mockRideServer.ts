import * as Net from 'net';

/**
 * Minimal TCP server that speaks the RIDE protocol (v2).
 * Used for integration testing AplSession without a real Dyalog interpreter.
 */
export class MockRideServer {
	private _server?: Net.Server;
	private _client?: Net.Socket;
	private _port = 0;
	public handshakeComplete = false;

	/** Messages received from the client */
	public received: Array<[string, any]> = [];

	/** Resolved when a client connects and completes handshake */
	public clientConnected: Promise<void>;
	private _resolveConnected!: () => void;

	constructor() {
		this.clientConnected = new Promise(resolve => {
			this._resolveConnected = resolve;
		});
	}

	public get port(): number {
		return this._port;
	}

	/**
	 * Start listening on a random port.
	 */
	public async start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this._server = Net.createServer(socket => {
				this._client = socket;

				let buffer = Buffer.alloc(0);
				socket.on('data', (data) => {
					buffer = Buffer.concat([buffer, data]);
					this._processBuffer(buffer, (remaining) => { buffer = remaining; });
				});

				socket.on('error', () => {});
			});

			this._server.on('error', reject);
			this._server.listen(0, '127.0.0.1', () => {
				const addr = this._server!.address() as Net.AddressInfo;
				this._port = addr.port;
				resolve(this._port);
			});
		});
	}

	private _processBuffer(buffer: Buffer, setRemaining: (b: Buffer) => void): void {
		let offset = 0;

		while (offset < buffer.length) {
			// Check if we have at least 4 bytes for length
			if (buffer.length - offset < 4) break;

			const msgLen = buffer.readInt32BE(offset);
			if (msgLen <= 0 || buffer.length - offset < msgLen) break;

			const content = buffer.slice(offset + 8, offset + msgLen).toString();
			offset += msgLen;

			if (content.startsWith('SupportedProtocols=')) {
				// Handshake step 1 — send back our supported protocols
				// (Client already sends full handshake batch, we just need to respond)
			} else if (content.startsWith('UsingProtocol=')) {
				this.handshakeComplete = true;
			} else if (content.startsWith('[')) {
				try {
					const parsed = JSON.parse(content);
					this.received.push(parsed);

					// Auto-respond to common messages
					this._autoRespond(parsed[0], parsed[1]);
				} catch {
					// Ignore parse errors
				}
			}
		}

		setRemaining(buffer.slice(offset));
	}

	private _autoRespond(command: string, args: any): void {
		switch (command) {
			case 'Identify':
				this.send('Identify', { identity: 1, version: '19.0.0 (mock)' });
				break;
			case 'Connect':
				this.send('SetPromptType', { type: 1 });
				this._resolveConnected();
				break;
			case 'Execute':
				// Echo the input back, then send output
				this.send('EchoInput', { input: args.text });
				this.send('AppendSessionOutput', { result: 'mock result\n' });
				this.send('SetPromptType', { type: 1 });
				break;
			case 'GetAutocomplete':
				this.send('ReplyGetAutocomplete', {
					options: ['option1', 'option2'],
					token: args.token,
					skip: 0
				});
				break;
		}
	}

	/**
	 * Send a RIDE message to the connected client.
	 */
	public send(command: string, args: object): void {
		if (!this._client) return;
		const message = JSON.stringify([command, args]);
		const buf = Buffer.from(`xxxxRIDE${message}`);
		buf.writeInt32BE(buf.length, 0);
		this._client.write(buf);
	}

	/**
	 * Send raw protocol bytes (for handshake testing).
	 */
	public sendRaw(message: string): void {
		if (!this._client) return;
		const buf = Buffer.from(`xxxxRIDE${message}`);
		buf.writeInt32BE(buf.length, 0);
		this._client.write(buf);
	}

	/**
	 * Get messages received with a specific command name.
	 */
	public getReceived(command: string): any[] {
		return this.received
			.filter(([cmd]) => cmd === command)
			.map(([, args]) => args);
	}

	/**
	 * Stop the server and close all connections.
	 */
	public stop(): void {
		this._client?.destroy();
		this._server?.close();
		this._client = undefined;
		this._server = undefined;
	}
}
