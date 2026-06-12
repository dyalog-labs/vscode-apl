import assert = require('assert');
import { parseLocalNames } from '../../debug/inspect';

suite('parseLocalNames', () => {
	test('dfn header returns ⍵ and ⍺', () => {
		const result = parseLocalNames('{⍵+1}', 'myFn');
		assert.deepStrictEqual(result, ['⍵', '⍺']);
	});

	test('dfn with leading whitespace', () => {
		const result = parseLocalNames('  { ⍵×2 }', 'fn');
		assert.deepStrictEqual(result, ['⍵', '⍺']);
	});

	test('simple tradfn: FuncName', () => {
		const result = parseLocalNames('FuncName', 'FuncName');
		assert.deepStrictEqual(result, []);
	});

	test('tradfn with result: Z←FuncName', () => {
		const result = parseLocalNames('Z←FuncName', 'FuncName');
		assert.deepStrictEqual(result, ['Z']);
	});

	test('tradfn with result and arg: Z←FuncName B', () => {
		const result = parseLocalNames('Z←FuncName B', 'FuncName');
		assert.deepStrictEqual(result, ['Z', 'B']);
	});

	test('tradfn with left and right args: Z←A FuncName B', () => {
		const result = parseLocalNames('Z←A FuncName B', 'FuncName');
		assert.deepStrictEqual(result, ['Z', 'A', 'B']);
	});

	test('tradfn with locals: Z←FuncName B;loc1;loc2', () => {
		const result = parseLocalNames('Z←FuncName B;loc1;loc2', 'FuncName');
		assert.deepStrictEqual(result, ['Z', 'B', 'loc1', 'loc2']);
	});

	test('tradfn with only locals: FuncName;x;y;z', () => {
		const result = parseLocalNames('FuncName;x;y;z', 'FuncName');
		assert.deepStrictEqual(result, ['x', 'y', 'z']);
	});

	test('tradfn with optional args: {Z}←{A} FuncName {B}', () => {
		const result = parseLocalNames('{Z}←{A} FuncName {B}', 'FuncName');
		assert.deepStrictEqual(result, ['Z', 'A', 'B']);
	});

	// TODO! Should this find foo?!
	test('dfn with assignment inside body is still a dfn', () => {
		const result = parseLocalNames('{foo←⍺+5 ⋄ foo}', 'myFn');
		assert.deepStrictEqual(result, ['⍵', '⍺']);
	});

	test('empty inputs return empty array', () => {
		assert.deepStrictEqual(parseLocalNames('', 'fn'), []);
		assert.deepStrictEqual(parseLocalNames('header', ''), []);
	});

	test('locals with whitespace are trimmed', () => {
		const result = parseLocalNames('FuncName; x ; y ', 'FuncName');
		assert.deepStrictEqual(result, ['x', 'y']);
	});

	test('empty local sections are filtered', () => {
		const result = parseLocalNames('FuncName;;x', 'FuncName');
		assert.deepStrictEqual(result, ['x']);
	});
});
