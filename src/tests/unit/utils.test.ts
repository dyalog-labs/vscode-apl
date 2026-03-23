import assert = require('assert');
import { PendingRequest, PendingRequests, normPath } from '../../utils';

suite('normPath', () => {
	test('uppercases Windows drive letter', () => {
		assert.strictEqual(normPath('c:\\Users\\test\\file.ts'), 'C:\\Users\\test\\file.ts');
	});

	test('leaves already-uppercase drive letter unchanged', () => {
		assert.strictEqual(normPath('D:\\foo\\bar'), 'D:\\foo\\bar');
	});

	test('leaves Unix path unchanged', () => {
		assert.strictEqual(normPath('/home/user/file.ts'), '/home/user/file.ts');
	});

	test('leaves path with no drive letter unchanged', () => {
		assert.strictEqual(normPath('relative/path/file.ts'), 'relative/path/file.ts');
	});

	test('handles empty string', () => {
		assert.strictEqual(normPath(''), '');
	});
});

suite('PendingRequest', () => {
	test('create returns a promise', () => {
		const pr = new PendingRequest<string>();
		const promise = pr.create();
		assert.ok(promise instanceof Promise);
	});

	test('pending is true after create, false after resolve', () => {
		const pr = new PendingRequest<string>();
		assert.strictEqual(pr.pending, false);
		pr.create();
		assert.strictEqual(pr.pending, true);
		pr.resolve('done');
		assert.strictEqual(pr.pending, false);
	});

	test('resolve delivers the value', async () => {
		const pr = new PendingRequest<number>();
		const promise = pr.create();
		pr.resolve(42);
		const result = await promise;
		assert.strictEqual(result, 42);
	});

	test('reject delivers the error', async () => {
		const pr = new PendingRequest<string>();
		const promise = pr.create();
		pr.reject(new Error('fail'));
		await assert.rejects(promise, { message: 'fail' });
	});

	test('timeout auto-resolves with undefined', async () => {
		const pr = new PendingRequest<string>();
		const promise = pr.create(50);
		const result = await promise;
		assert.strictEqual(result, undefined);
	});

	test('manual resolve before timeout clears the timer', async () => {
		const pr = new PendingRequest<string>();
		const promise = pr.create(500);
		pr.resolve('fast');
		const result = await promise;
		assert.strictEqual(result, 'fast');
	});

	test('double resolve does not throw', () => {
		const pr = new PendingRequest<string>();
		pr.create();
		pr.resolve('first');
		pr.resolve('second'); // should be a no-op
	});

	test('double reject does not throw', () => {
		const pr = new PendingRequest<string>();
		pr.create().catch(() => {}); // prevent unhandled rejection
		pr.reject(new Error('first'));
		pr.reject(new Error('second')); // should be a no-op
	});

	test('promise getter returns the created promise', () => {
		const pr = new PendingRequest<string>();
		assert.strictEqual(pr.promise, undefined);
		const p = pr.create();
		assert.strictEqual(pr.promise, p);
	});
});

suite('PendingRequests', () => {
	test('create and resolve with different keys', async () => {
		const prs = new PendingRequests<string>();
		const p1 = prs.create(1);
		const p2 = prs.create(2);

		prs.resolve(1, 'one');
		prs.resolve(2, 'two');

		assert.strictEqual(await p1, 'one');
		assert.strictEqual(await p2, 'two');
	});

	test('resolve unknown key is a no-op', () => {
		const prs = new PendingRequests<string>();
		prs.resolve(999, 'ghost'); // should not throw
	});

	test('reject unknown key is a no-op', () => {
		const prs = new PendingRequests<string>();
		prs.reject(999, new Error('ghost')); // should not throw
	});

	test('reject delivers error to correct key', async () => {
		const prs = new PendingRequests<string>();
		const p1 = prs.create(1);
		const p2 = prs.create(2);

		prs.reject(1, new Error('fail-1'));
		prs.resolve(2, 'ok');

		await assert.rejects(p1, { message: 'fail-1' });
		assert.strictEqual(await p2, 'ok');
	});

	test('timeout auto-resolves with undefined', async () => {
		const prs = new PendingRequests<string>();
		const p = prs.create(1, 50);
		const result = await p;
		assert.strictEqual(result, undefined);
	});

	test('manual resolve before timeout clears timer', async () => {
		const prs = new PendingRequests<string>();
		const p = prs.create(1, 500);
		prs.resolve(1, 'fast');
		assert.strictEqual(await p, 'fast');
	});

	test('multiple concurrent pending requests', async () => {
		const prs = new PendingRequests<number>();
		const promises: Promise<number>[] = [];
		for (let i = 0; i < 10; i++) {
			promises.push(prs.create(i));
		}

		// Resolve in reverse order
		for (let i = 9; i >= 0; i--) {
			prs.resolve(i, i * 10);
		}

		const results = await Promise.all(promises);
		for (let i = 0; i < 10; i++) {
			assert.strictEqual(results[i], i * 10);
		}
	});
});
