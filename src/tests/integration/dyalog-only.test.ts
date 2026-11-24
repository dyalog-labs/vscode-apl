import * as assert from 'assert';
import * as path from 'path';
import { DyalogBackend, isDyalogAvailable } from '../helpers/testBackend';

/**
 * Tests that require a real Dyalog interpreter — things that can't be
 * meaningfully faked by the mock server.
 *
 * Skipped unless DYALOG_TESTS=1 is set and dyalog is on PATH.
 */
const skip = !process.env.DYALOG_TESTS || !isDyalogAvailable();

(skip ? suite.skip : suite)('Real Dyalog — ⎕STOP suspends execution', () => {
	let backend: DyalogBackend;

	setup(async () => {
		backend = await DyalogBackend.create();
	});

	teardown(async () => {
		await backend.teardown();
	});

	test('breakpoint causes suspension on function call', async () => {
		const { filePath, startLine } = await backend.defineFunction('StopMe', [
			'r←StopMe x',
			'r←x+1',
			'r←r×2',
		]);

		// Set breakpoint on line "r←x+1" (startLine + 1)
		const bp = await backend.runtime.setBreakPoint(filePath, startLine + 1);
		assert.ok(bp.verified, 'breakpoint should be verified');

		// Execute the function — should suspend at the breakpoint
		const stopped = new Promise<string>(resolve => {
			backend.runtime.once('stopOnStep', () => resolve('step'));
			backend.runtime.once('stopOnBreakpoint', () => resolve('breakpoint'));
		});

		// Execute with trace so the interpreter opens a tracer window
		backend.session.execute('StopMe 5\n');

		const reason = await Promise.race([
			stopped,
			new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 5000)),
		]);

		assert.ok(reason !== 'timeout', 'function should have suspended at breakpoint');

		// Verify a tracer window is open
		const win = backend.runtime.currentWindow;
		assert.ok(win, 'should have an open tracer window');
		assert.ok(win!.name.includes('StopMe'), `tracer should show StopMe, got: ${win!.name}`);

		// Continue execution to clean up the suspension
		backend.runtime.continue();

		// Wait for the window to close
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test('⎕STOP is cleared after clearBreakpoints', async () => {
		const { filePath, startLine } = await backend.defineFunction('ClearMe', [
			'r←ClearMe x',
			'r←x+1',
		]);

		// Set then clear
		await backend.runtime.setBreakPoint(filePath, startLine + 1);
		await backend.runtime.clearBreakpoints(filePath);

		// Execute — should NOT suspend (no breakpoint)
		const output = await backend.execute('ClearMe 10');
		assert.ok(output.trim().includes('11'), `should get result 11, got: "${output.trim()}"`);
	});

	test('a breakpoint set while the interpreter is busy does not wait, and is there once it is free', async () => {
		const { filePath, startLine } = await backend.defineFunction('BusyStop', [
			'r←BusyStop x',
			'r←x+1',
		]);

		const busy = new Promise<void>(resolve => {
			const onState = (state: string) => {
				if (state !== 'busy') { return; }
				backend.session.removeListener('stateChanged', onState);
				resolve();
			};
			backend.session.on('stateChanged', onState);
		});
		backend.session.execute('⎕DL 3');
		await busy;

		const started = Date.now();
		const bp = await backend.runtime.setBreakPoint(filePath, startLine + 1);
		const waited = Date.now() - started;
		assert.ok(waited < 1000, `setBreakPoint waited ${waited} ms for the busy interpreter`);
		assert.ok(bp.verified, 'breakpoint should be verified');

		// Queued behind ⎕DL and the stop: the call suspends on it.
		const stopped = new Promise<boolean>(resolve => {
			backend.runtime.once('stopOnStep', () => resolve(true));
			backend.runtime.once('stopOnBreakpoint', () => resolve(true));
			setTimeout(() => resolve(false), 8000);
		});
		backend.session.execute('BusyStop 5');
		assert.ok(await stopped, 'the call should have suspended at the breakpoint');

		backend.runtime.continue();
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test('opening another function in the editor while suspended does not swallow Continue', async () => {
		const inner = await backend.defineFunction('EditInner', ['r←EditInner x', 'r←x×2']);
		const outer = await backend.defineFunction('EditOuter', ['r←EditOuter x', 'r←x+1', 'r←EditInner r']);
		await backend.runtime.setBreakPoint(outer.filePath, outer.startLine + 1);

		const within = (event: string) => new Promise<boolean>(resolve => {
			backend.runtime.once(event, () => resolve(true));
			setTimeout(() => resolve(false), 5000);
		});
		let stopped = within('stopOnBreakpoint');
		backend.session.execute('EditOuter 5');
		assert.ok(await stopped, 'should have stopped in EditOuter');

		// What go to definition sends: the interpreter answers with an edit window.
		const opened = within('openWindow');
		backend.session.sendMessage('Edit', { win: 0, pos: 0, text: 'EditInner' });
		assert.ok(await opened, 'the interpreter should have opened EditInner in an editor');
		await backend.runtime.setBreakPoint(inner.filePath, inner.startLine + 1);

		stopped = within('stopOnBreakpoint');
		backend.runtime.continue();
		assert.ok(await stopped, 'Continue should have run on to the stop in EditInner');
		assert.ok(backend.runtime.currentWindow?.name.includes('EditInner'), 'should be suspended in EditInner');

		backend.runtime.continue();
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test('a debug session started on a suspension outlives Continue into a stop in another function', async () => {
		const inner = await backend.defineFunction('StopInner', ['r←StopInner x', 'r←x×2']);
		const outer = await backend.defineFunction('StopOuter', ['r←StopOuter x', 'r←x+1', 'r←StopInner r']);
		await backend.runtime.setBreakPoint(outer.filePath, outer.startLine + 1);

		// As the REPL does: run with no debugger attached, then attach to the suspension.
		backend.session.clearDebugHandler();
		const suspended = new Promise<void>(resolve => backend.session.once('suspended', () => resolve()));
		backend.session.execute('StopOuter 5');
		await suspended;
		let ended = false;
		backend.runtime.once('end', () => { ended = true; });
		await backend.runtime.attachToSuspendedSession(backend.session, 'test', path.dirname(outer.filePath));
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.ok(backend.runtime.currentWindow?.name.includes('StopOuter'), 'should be suspended in StopOuter');

		await backend.runtime.setBreakPoint(inner.filePath, inner.startLine + 1);

		const within = (event: string) => new Promise<boolean>(resolve => {
			backend.runtime.once(event, () => resolve(true));
			setTimeout(() => resolve(false), 5000);
		});
		const stopped = within('stopOnBreakpoint');
		backend.runtime.continue();
		assert.ok(await stopped, 'should have stopped in StopInner');
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.ok(!ended, 'the debug session ended before the run did');
		assert.ok(backend.runtime.currentWindow?.name.includes('StopInner'), 'should be suspended in StopInner');

		const finished = within('end');
		backend.runtime.continue();
		assert.ok(await finished, 'the debug session should end when the run finishes');
	});
});

(skip ? suite.skip : suite)('Real Dyalog — exception info', () => {
	let backend: DyalogBackend;

	setup(async () => {
		backend = await DyalogBackend.create();
	});

	teardown(async () => {
		await backend.teardown();
	});

	test('division by zero triggers HadError', async () => {
		await backend.defineFunction('DivZero', [
			'r←DivZero x',
			'r←x÷0',
		]);

		// Execute with trace — error will cause suspension
		const stopped = new Promise<void>(resolve => {
			backend.runtime.once('stopOnStep', resolve);
			backend.runtime.once('stopOnBreakpoint', resolve);
		});

		backend.session.execute('DivZero 1\n');

		await Promise.race([
			stopped,
			new Promise<void>(resolve => setTimeout(resolve, 5000)),
		]);

		// Check that HadError was received
		const lastError = backend.runtime.lastError;
		assert.ok(lastError, 'should have received HadError');
		assert.ok(lastError!.error > 0, `error code should be > 0, got: ${lastError!.error}`);

		// Clean up suspension
		backend.runtime.cutback();
		await new Promise(resolve => setTimeout(resolve, 500));
	});

	test('⎕DM is queryable after error', async () => {
		await backend.defineFunction('ErrFunc', [
			'r←ErrFunc x',
			'r←x÷0',
		]);

		const stopped = new Promise<void>(resolve => {
			backend.runtime.once('stopOnStep', resolve);
			backend.runtime.once('stopOnBreakpoint', resolve);
		});

		backend.session.execute('ErrFunc 1\n');

		const result = await Promise.race([
			stopped.then(() => 'stopped' as const),
			new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 5000)),
		]);
		assert.strictEqual(result, 'stopped', 'function should have suspended');

		// Small delay to let the interpreter settle
		await new Promise(resolve => setTimeout(resolve, 200));

		// Query ⎕DM via getValueTip — use a longer timeout via a fresh call
		// The win must match the open tracer window
		const win = backend.runtime.winId;
		assert.ok(win > 0, `should have a tracer window open, got winId: ${win}`);

		// Use session directly to query ⎕DM since getValueTip has a short timeout
		const dmOutput = await backend.execute('⎕DM');
		assert.ok(dmOutput.length > 0, `⎕DM should return content, got: "${dmOutput}"`);
		assert.ok(dmOutput.includes('DOMAIN ERROR') || dmOutput.includes('÷'),
			`⎕DM should mention the error, got: "${dmOutput}"`);

		// Clean up
		backend.runtime.cutback();
		await new Promise(resolve => setTimeout(resolve, 500));
	});
});

(skip ? suite.skip : suite)('Real Dyalog — Link round-trip', () => {
	let backend: DyalogBackend;

	setup(async () => {
		backend = await DyalogBackend.create();
	});

	teardown(async () => {
		await backend.teardown();
	});

	test('defined function is callable after Link', async () => {
		await backend.defineFunction('AddTwo', [
			'r←AddTwo x',
			'r←x+2',
		]);

		const output = await backend.execute('AddTwo 10');
		assert.ok(output.trim().includes('12'), `expected 12, got: "${output.trim()}"`);
	});

	test('multiple functions in same directory', async () => {
		await backend.defineFunction('FuncA', [
			'r←FuncA x',
			'r←x×10',
		]);
		await backend.defineFunction('FuncB', [
			'r←FuncB x',
			'r←x+100',
		]);

		const outputA = await backend.execute('FuncA 3');
		assert.ok(outputA.trim().includes('30'), `FuncA 3 should be 30, got: "${outputA.trim()}"`);

		const outputB = await backend.execute('FuncB 5');
		assert.ok(outputB.trim().includes('105'), `FuncB 5 should be 105, got: "${outputB.trim()}"`);
	});

	test('function composition works across linked functions', async () => {
		await backend.defineFunction('Inner', [
			'r←Inner x',
			'r←x×2',
		]);
		await backend.defineFunction('Outer', [
			'r←Outer x',
			'r←Inner x+1',
		]);

		const output = await backend.execute('Outer 4');
		assert.ok(output.trim().includes('10'), `Outer 4 → Inner 5 → 10, got: "${output.trim()}"`);
	});
});
