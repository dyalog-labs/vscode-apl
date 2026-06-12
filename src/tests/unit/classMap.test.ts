import assert = require('assert');
import { classMap } from '../../debug/inspect';

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
