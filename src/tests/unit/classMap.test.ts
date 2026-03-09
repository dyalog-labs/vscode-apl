import assert = require('assert');

/**
 * Extracted pure-function version of AplDebugSession.classMap
 * for testability. The original is a private method in aplDebug.ts.
 */
function classMap(nc: number): string {
	switch (nc) {
		case 2.1:
		case 2.2:
		case 2.6:
			return 'data';

		case 2.3:
			return 'property';

		case 3.1:
		case 3.2:
		case 3.3:
		case 3.6:
		case 4.1:
		case 4.2:
		case 4.3:
			return 'method';

		case -1:
		case 9.1:
		case 9.2:
		case 9.4:
		case 9.6:
			return 'class';

		case 9.5:
		case 9.7:
			return 'interface';

		default: return 'virtual';
	}
}

suite('classMap', () => {
	test('data types', () => {
		assert.strictEqual(classMap(2.1), 'data');
		assert.strictEqual(classMap(2.2), 'data');
		assert.strictEqual(classMap(2.6), 'data');
	});

	test('property type', () => {
		assert.strictEqual(classMap(2.3), 'property');
	});

	test('method types', () => {
		assert.strictEqual(classMap(3.1), 'method');
		assert.strictEqual(classMap(3.2), 'method');
		assert.strictEqual(classMap(3.3), 'method');
		assert.strictEqual(classMap(3.6), 'method');
		assert.strictEqual(classMap(4.1), 'method');
		assert.strictEqual(classMap(4.2), 'method');
		assert.strictEqual(classMap(4.3), 'method');
	});

	test('class types', () => {
		assert.strictEqual(classMap(-1), 'class');
		assert.strictEqual(classMap(9.1), 'class');
		assert.strictEqual(classMap(9.2), 'class');
		assert.strictEqual(classMap(9.4), 'class');
		assert.strictEqual(classMap(9.6), 'class');
	});

	test('interface types', () => {
		assert.strictEqual(classMap(9.5), 'interface');
		assert.strictEqual(classMap(9.7), 'interface');
	});

	test('unknown types default to virtual', () => {
		assert.strictEqual(classMap(0), 'virtual');
		assert.strictEqual(classMap(1), 'virtual');
		assert.strictEqual(classMap(5), 'virtual');
		assert.strictEqual(classMap(99), 'virtual');
	});
});
