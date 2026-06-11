import { LinkInfoRow } from './aplSession';
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
