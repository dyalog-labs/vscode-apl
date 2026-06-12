import assert = require('assert');
import { APL_KEYS, buildAplKeyMap, getAplKeysForWebview } from '../../editor/aplKeys';

suite('APL_KEYS data', () => {
	test('every entry has key and char fields', () => {
		for (const entry of APL_KEYS) {
			assert.ok(entry.key, `Entry missing key: ${JSON.stringify(entry)}`);
			assert.ok(entry.char, `Entry missing char for key "${entry.key}": ${JSON.stringify(entry)}`);
		}
	});

	test('no duplicate keys', () => {
		const seen = new Set<string>();
		for (const entry of APL_KEYS) {
			assert.ok(!seen.has(entry.key), `Duplicate key: "${entry.key}"`);
			seen.add(entry.key);
		}
	});

	test('APL glyphs are single characters or short strings', () => {
		for (const entry of APL_KEYS) {
			assert.ok(
				entry.char.length >= 1 && entry.char.length <= 3,
				`Unexpected APL glyph length for key "${entry.key}": "${entry.char}" (length ${entry.char.length})`
			);
		}
	});
});

suite('buildAplKeyMap', () => {
	test('returns a Map', () => {
		const map = buildAplKeyMap();
		assert.ok(map instanceof Map);
	});

	test('map has same size as APL_KEYS', () => {
		const map = buildAplKeyMap();
		assert.strictEqual(map.size, APL_KEYS.length);
	});

	test('lookup returns correct entry', () => {
		const map = buildAplKeyMap();
		// Find the first entry and verify lookup
		const first = APL_KEYS[0];
		const found = map.get(first.key);
		assert.ok(found);
		assert.strictEqual(found.char, first.char);
	});
});

suite('getAplKeysForWebview', () => {
	test('returns an array', () => {
		const result = getAplKeysForWebview();
		assert.ok(Array.isArray(result));
	});

	test('array entries have key and char', () => {
		const result = getAplKeysForWebview();
		assert.ok(result.length > 0);
		for (const entry of result) {
			assert.ok('key' in entry);
			assert.ok('char' in entry);
		}
	});

	test('result is JSON-serializable', () => {
		const result = getAplKeysForWebview();
		const json = JSON.stringify(result);
		const parsed = JSON.parse(json);
		assert.strictEqual(parsed.length, result.length);
	});
});
