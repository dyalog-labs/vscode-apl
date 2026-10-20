import type { LinkInfoRow } from './aplSession';
import { normPath } from '../utils';

/**
 * For each `{ line, bp }` in `items`, find the closest preceding function
 * in `linkInfo` for `filePath` (max `r.startLine <= line`), compute the
 * `line - r.startLine` offset that `⎕STOP` wants, and group offsets by
 * APL function name. Breakpoints that fall outside any function (e.g.
 * before the first function in a file) are dropped from `stops` AND
 * from `matched`.
 *
 * Shared by `aplRuntime.setBreakPointOnFile` (debug path, bp =
 * `IAplBreakpoint`) and `replBreakpointSync._syncBreakpointsForFile`
 * (REPL path, bp = `vscode.SourceBreakpoint`). `T` lets each caller
 * keep its own breakpoint type — `matched` is the subset of inputs
 * whose lines actually landed in a function, in original order.
 */
export function mapBreakpointsToStops<T>(
	items: ReadonlyArray<{ line: number; bp: T }>,
	filePath: string,
	linkInfo: readonly LinkInfoRow[],
): { stops: Record<string, number[]>; matched: T[] } {
	const stops: Record<string, number[]> = {};
	const matched: T[] = [];
	const normalizedPath = normPath(filePath);
	for (const { line, bp } of items) {
		let row: LinkInfoRow | undefined;
		for (const r of linkInfo) {
			if (normPath(r.filePath) === normalizedPath && r.startLine <= line) {
				if (!row || r.startLine > row.startLine) { row = r; }
			}
		}
		if (row) {
			(stops[row.aplName] ??= []).push(line - row.startLine);
			matched.push(bp);
		}
	}
	return { stops, matched };
}

/**
 * One input line that clears ⎕STOP on every function the interpreter loaded
 * from a file, except under ⎕SE, from its own 5177⌶ table so no names
 * travel. Non-functions fail inside the guard and are skipped. ⎕IO and ⎕ML
 * are set as in the link-info query, since ↑ is First under ⎕ML≥2. Prints
 * nothing.
 */
export const CLEAR_ALL_STOPS =
	"{}{⎕IO ⎕ML←1 1 ⋄ r←⍕¨↑5177⌶⍬ ⋄ 0=≢r:0 ⋄ r←r⌿⍨(⊂'⎕SE')≢¨3↑¨r[;2] ⋄ {0::0 ⋄ ⍬ ⎕STOP ⍵}¨r[;2]{⍺,'.',⍵}¨r[;1]}⍬";

/**
 * Longest input line sent to the interpreter, in characters. A line that
 * does not fit the interpreter's history buffer is rejected with a LIMIT
 * ERROR: lines of 1300 characters have been, and the buffer's size is a
 * user setting (History_Size), so this stays well below.
 */
export const MAX_INPUT_LINE = 500;

/** Quote an APL name as a character vector literal. */
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Statement setting ⎕STOP `lines` (function-relative, none clears) on one function. */
export function setStopsStatement(name: string, lines: readonly number[]): string {
	return `{}{0::0 ⋄ ${lines.length ? lines.join(' ') : '⍬'} ⎕STOP ⍵}${quote(name)}`;
}

/** Pack statements into ⋄-joined lines of at most `max` characters; a longer statement goes alone. */
export function packStatements(statements: readonly string[], max = MAX_INPUT_LINE): string[] {
	const lines: string[] = [];
	let current = '';
	for (const s of statements) {
		if (current && current.length + 3 + s.length > max) {
			lines.push(current);
			current = '';
		}
		current = current ? `${current} ⋄ ${s}` : s;
	}
	if (current) { lines.push(current); }
	return lines;
}
