import assert = require('assert');
import { CLEAR_ALL_STOPS, MAX_INPUT_LINE, packStatements, setStopsStatement } from '../../session/linkBreakpoints';

suite('⎕STOP statement builders', () => {

	test('CLEAR_ALL_STOPS walks the loaded-file table on the interpreter and prints nothing', () => {
		assert.ok(CLEAR_ALL_STOPS.includes('5177⌶'), 'uses the interpreter-side table');
		assert.ok(CLEAR_ALL_STOPS.includes('⍬ ⎕STOP'), 'clears stops');
		assert.ok(CLEAR_ALL_STOPS.startsWith('{}'), 'result is sunk so nothing prints');
		assert.ok(CLEAR_ALL_STOPS.includes("'⎕SE'"), 'leaves ⎕SE objects alone');
		assert.ok(CLEAR_ALL_STOPS.includes('⎕IO ⎕ML←1 1'), 'independent of the session: ↑ is First under ⎕ML≥2');
	});

	test('names containing a quote are escaped by doubling', () => {
		assert.strictEqual(setStopsStatement("#.it's", [2]), "{}{0::0 ⋄ 2 ⎕STOP ⍵}'#.it''s'");
	});

	test('setStopsStatement sets the given function-relative lines; none clears', () => {
		assert.strictEqual(setStopsStatement('#.foo', [1, 3]), "{}{0::0 ⋄ 1 3 ⎕STOP ⍵}'#.foo'");
		assert.strictEqual(setStopsStatement('#.foo', []), "{}{0::0 ⋄ ⍬ ⎕STOP ⍵}'#.foo'");
	});

	test('packStatements joins short statements with ⋄ into one line', () => {
		assert.deepStrictEqual(packStatements(['a←1', 'b←2', 'c←3']), ['a←1 ⋄ b←2 ⋄ c←3']);
	});

	test('packStatements starts a new line when the limit would be exceeded', () => {
		const lines = packStatements(['aaaa', 'bbbb', 'cccc'], 12);
		assert.deepStrictEqual(lines, ['aaaa ⋄ bbbb', 'cccc']);
		for (const l of lines) { assert.ok(l.length <= 12); }
	});

	test('packStatements sends an oversized statement on its own line', () => {
		const big = 'x'.repeat(50);
		assert.deepStrictEqual(packStatements(['a←1', big, 'b←2'], 12), ['a←1', big, 'b←2']);
	});

	test('packStatements of nothing is nothing', () => {
		assert.deepStrictEqual(packStatements([]), []);
	});

	test('packStatements keeps lines within MAX_INPUT_LINE unless told otherwise', () => {
		const clears = Array.from({ length: 300 }, (_, i) => setStopsStatement(`#.ns.fn${i}`, []));
		const lines = packStatements(clears);
		assert.ok(lines.length > 1);
		for (const l of lines) { assert.ok(l.length <= MAX_INPUT_LINE, `line of ${l.length} characters`); }
		assert.strictEqual(lines.join(' ⋄ '), clears.join(' ⋄ '), 'every statement is sent, in order');
	});
});
