import assert = require('assert');
import { parseStackDescription } from '../../aplRuntime';

suite('parseStackDescription', () => {

	test('parses standard name[line] format', () => {
		const result = parseStackDescription('foo[3]');
		assert.strictEqual(result.name, 'foo');
		assert.strictEqual(result.lineOffset, 3);
	});

	test('parses qualified name with line', () => {
		const result = parseStackDescription('#.MyNS.MyFunc[10]');
		assert.strictEqual(result.name, '#.MyNS.MyFunc');
		assert.strictEqual(result.lineOffset, 10);
	});

	test('parses empty name with line', () => {
		const result = parseStackDescription('[3]');
		assert.strictEqual(result.name, '');
		assert.strictEqual(result.lineOffset, 3);
	});

	test('parses line 0', () => {
		const result = parseStackDescription('foo[0]');
		assert.strictEqual(result.name, 'foo');
		assert.strictEqual(result.lineOffset, 0);
	});

	// --- These tests expose the bug: NaN/undefined on malformed input ---

	test('description without brackets returns safe defaults', () => {
		const result = parseStackDescription('no brackets');
		assert.strictEqual(typeof result.name, 'string', 'name should be a string, not undefined');
		assert.ok(!isNaN(result.lineOffset), 'lineOffset should not be NaN');
	});

	test('empty string returns safe defaults', () => {
		const result = parseStackDescription('');
		assert.strictEqual(typeof result.name, 'string', 'name should be a string, not undefined');
		assert.ok(!isNaN(result.lineOffset), 'lineOffset should not be NaN');
	});

	test('description with only name returns safe defaults', () => {
		const result = parseStackDescription('MyFunc');
		assert.strictEqual(typeof result.name, 'string', 'name should be a string, not undefined');
		assert.ok(!isNaN(result.lineOffset), 'lineOffset should not be NaN');
	});
});
