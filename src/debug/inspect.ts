/**
 * Pure variable-inspection helpers for the debug adapter, kept free of
 * vscode/DAP dependencies so they can be unit-tested directly.
 * Used by `AplDebugSession` (aplDebug.ts).
 */

/**
 * Map a ⎕NC name-class code to a DAP variable kind.
 */
export function classMap(nc: number): string {
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

/**
 * Parse local variable names from a function header line.
 * For tradfn: extracts result, arguments, and declared locals from the header.
 * For dfn: returns ⍵ and ⍺ as potential locals.
 */
export function parseLocalNames(headerLine: string, funcName: string): string[] {
	if (!headerLine || !funcName) { return []; }

	// A dfn starts with { but tradfns can start with result as {Z}← in eg {Z}←FuncName.
	// Current heuristic is looking for {...}←
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
