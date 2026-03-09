import assert = require('assert');

/**
 * Extracted pure-function version of AplDebugSession.parseLocalNames
 * for testability. The original is a private method in aplDebug.ts.
 */
function parseLocalNames(headerLine: string, funcName: string): string[] {
	if (!headerLine || !funcName) { return []; }

	// Dfn: first line starts with { but is NOT a tradfn with optional result {Z}←
	// In {Z}←FuncName, the } comes before ←. In a dfn like {foo←⍺+5}, ← is inside the braces.
	const trimmed = headerLine.trimStart();
	if (trimmed.startsWith('{') && !/^\s*\{[^}]*\}\s*←/.test(trimmed)) {
		return ['⍵', '⍺'];
	}

	// Tradfn header: {Z←} {A} FuncName {B} {;loc1} {;loc2} ...
	const parts = headerLine.split(';');
	const declaredLocals = parts.slice(1).map(s => s.trim()).filter(s => s.length > 0);

	const sig = parts[0];
	const tokens = sig
		.replace(/[{}]/g, '')       // Remove optional-arg braces
		.split(/[←\s]+/)            // Split by ← and whitespace
		.map(s => s.trim())
		.filter(s => s.length > 0);

	const names: string[] = [];
	for (const token of tokens) {
		if (token === funcName) { continue; } // Skip function name
		names.push(token);
	}

	return [...names, ...declaredLocals];
}

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
