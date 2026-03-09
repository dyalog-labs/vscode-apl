import * as assert from 'assert';
import { getBackends, createBackend, TestBackend } from '../helpers/testBackend';

/**
 * Parameterized tests that run against both MockRideServer and real Dyalog.
 *
 * By default, only the mock backend runs (fast, no dependencies).
 * Set DYALOG_TESTS=1 to also run against a real Dyalog interpreter:
 *
 *   DYALOG_TESTS=1 npm test
 */
for (const backendType of getBackends()) {

	suite(`Breakpoints (${backendType})`, () => {
		let backend: TestBackend;

		setup(async () => {
			backend = await createBackend(backendType);
		});

		teardown(async () => {
			await backend.teardown();
		});

		test('breakpoint on defined function is verified', async () => {
			const { filePath, startLine } = await backend.defineFunction('Add', [
				'r←Add x',
				'r←x+1',
			]);

			const bp = await backend.runtime.setBreakPoint(filePath, startLine + 1);
			assert.ok(bp.verified, `breakpoint should be verified (${backendType})`);
		});

		test('breakpoint line offset is calculated from startLine', async () => {
			const { filePath, startLine } = await backend.defineFunction('Sub', [
				'r←Sub x',
				'r←x-1',
			]);

			const bp = await backend.runtime.setBreakPoint(filePath, startLine + 1);
			assert.ok(bp.verified);
			assert.strictEqual(bp.line, startLine + 1);
		});

		test('breakpoint outside any function stays unverified', async () => {
			const bp = await backend.runtime.setBreakPoint('/nonexistent/file.aplf', 5);
			assert.strictEqual(bp.verified, false);
		});

		test('clearBreakpoints then set new ones', async () => {
			const { filePath } = await backend.defineFunction('Mul', [
				'r←Mul x',
				'r←x×2',
				'r←r+0',
			]);

			// Set a breakpoint
			const bp1 = await backend.runtime.setBreakPoint(filePath, 1);
			assert.ok(bp1.verified);

			// Clear and set a different one
			await backend.runtime.clearBreakpoints(filePath);
			const bp2 = await backend.runtime.setBreakPoint(filePath, 2);
			assert.ok(bp2.verified);
			assert.strictEqual(bp2.line, 2);
		});
	});

	suite(`Execute (${backendType})`, () => {
		let backend: TestBackend;

		setup(async () => {
			backend = await createBackend(backendType);
		});

		teardown(async () => {
			await backend.teardown();
		});

		test('execute sends command without error', async () => {
			// Should not throw — just sends the command
			await (backend.runtime as any).exec(0, '1+1', 1);
		});

		test('execute produces output', async () => {
			const output = await backend.execute('2+3');
			assert.ok(output.length > 0, `should produce output, got: "${output}"`);
			if (backend.type === 'dyalog') {
				// Real Dyalog should return "5"
				assert.ok(output.trim().includes('5'), `expected output containing "5", got: "${output.trim()}"`);
			}
		});

		test('execute expression with assignment produces no output', async () => {
			const output = await backend.execute('X←42');
			if (backend.type === 'dyalog') {
				assert.strictEqual(output.trim(), '', 'assignment should produce no output');
			}
		});

		test('define and call function produces correct output', async () => {
			await backend.defineFunction('Double', [
				'r←Double x',
				'r←x×2',
			]);
			const output = await backend.execute('Double 7');
			if (backend.type === 'dyalog') {
				assert.ok(output.trim().includes('14'), `expected 14, got: "${output.trim()}"`);
			} else {
				// Mock: just verify we get some output
				assert.ok(output.length > 0);
			}
		});
	});

	suite(`Autocomplete (${backendType})`, () => {
		let backend: TestBackend;

		setup(async () => {
			backend = await createBackend(backendType);
		});

		teardown(async () => {
			await backend.teardown();
		});

		test('getAutocomplete returns results', async () => {
			const results = await backend.runtime.getAutocomplete('⎕', 1, 0);
			assert.ok(Array.isArray(results), 'should return an array');
			assert.ok(results.length > 0, 'should have at least one completion');
		});
	});

	suite(`Lifecycle (${backendType})`, () => {
		let backend: TestBackend;

		setup(async () => {
			backend = await createBackend(backendType);
		});

		teardown(async () => {
			await backend.teardown();
		});

		test('session is connected after setup', () => {
			assert.ok(backend.session.isConnected);
		});

		test('runtime has session wired up', () => {
			assert.ok((backend.runtime as any)._session === backend.session);
		});
	});
}
