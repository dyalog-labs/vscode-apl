import * as assert from 'assert';
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
