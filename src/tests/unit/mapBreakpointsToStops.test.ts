import * as assert from 'assert';
import { LinkInfoRow } from '../../session/aplSession';
import { mapBreakpointsToStops } from '../../debug/linkBreakpoints';

/**
 * `mapBreakpointsToStops` is the shared algorithm behind both
 * `aplRuntime.setBreakPointOnFile` (debug-session path) and
 * `replBreakpointSync._syncBreakpointsForFile` (REPL path).
 *
 * For each breakpoint, it finds the closest preceding function in the
 * Link table (`r.startLine <= bp.line`, maximising `r.startLine`),
 * computes `bp.line - r.startLine` as the offset to feed `⎕STOP`, and
 * groups results by APL function name. Breakpoints that fall outside
 * any function (e.g. before the first function in a file) are dropped.
 *
 * The function is path-aware via `normPath`, so Windows drive-letter
 * casing inconsistencies don't cause misses.
 */

const linkInfo: LinkInfoRow[] = [
	{ aplName: 'Foo',     filePath: '/repo/a.apl', startLine: 0  },
	{ aplName: 'Bar',     filePath: '/repo/a.apl', startLine: 10 },
	{ aplName: 'Baz',     filePath: '/repo/b.apl', startLine: 0  },
];

suite('mapBreakpointsToStops', () => {
	test('empty items → empty stops, empty matched', () => {
		const { stops, matched } = mapBreakpointsToStops([], '/repo/a.apl', linkInfo);
		assert.deepStrictEqual(stops, {});
		assert.deepStrictEqual(matched, []);
	});

	test('single breakpoint inside a function maps to (line - startLine)', () => {
		const { stops } = mapBreakpointsToStops(
			[{ line: 3, bp: 'bp1' }],
			'/repo/a.apl',
			linkInfo,
		);
		assert.deepStrictEqual(stops, { Foo: [3] });
	});

	test('breakpoint at function startLine has offset 0', () => {
		const { stops } = mapBreakpointsToStops(
			[{ line: 10, bp: 'bp1' }],
			'/repo/a.apl',
			linkInfo,
		);
		assert.deepStrictEqual(stops, { Bar: [0] });
	});

	test('multiple breakpoints in the same function are grouped under one name', () => {
		const { stops } = mapBreakpointsToStops(
			[
				{ line: 1, bp: 'a' },
				{ line: 5, bp: 'b' },
				{ line: 8, bp: 'c' },
			],
			'/repo/a.apl',
			linkInfo,
		);
		assert.deepStrictEqual(stops, { Foo: [1, 5, 8] });
	});

	test('breakpoints in different functions land under separate keys', () => {
		const { stops } = mapBreakpointsToStops(
			[
				{ line: 2,  bp: 'a' },   // Foo+2
				{ line: 12, bp: 'b' },   // Bar+2
			],
			'/repo/a.apl',
			linkInfo,
		);
		assert.deepStrictEqual(stops, { Foo: [2], Bar: [2] });
	});

	test('breakpoint between two functions maps to the closest preceding (Bar, not Foo)', () => {
		const { stops } = mapBreakpointsToStops(
			[{ line: 15, bp: 'b' }],
			'/repo/a.apl',
			linkInfo,
		);
		assert.deepStrictEqual(stops, { Bar: [5] });
	});

	test('breakpoint with no preceding function in this file is dropped (empty stops)', () => {
		// All rows for /repo/a.apl have startLine >= 0, so this can only happen
		// if a file has its first function at line > 0 and a breakpoint sits above it.
		const linkInfoWithGap: LinkInfoRow[] = [
			{ aplName: 'OnlyFn', filePath: '/repo/c.apl', startLine: 5 },
		];
		const { stops, matched } = mapBreakpointsToStops(
			[{ line: 2, bp: 'orphan' }],
			'/repo/c.apl',
			linkInfoWithGap,
		);
		assert.deepStrictEqual(stops, {});
		assert.deepStrictEqual(matched, []);
	});

	test('rows for other files are ignored', () => {
		const { stops } = mapBreakpointsToStops(
			[{ line: 3, bp: 'a' }],
			'/repo/b.apl',
			linkInfo,
		);
		// Should land in Baz (the only row for /repo/b.apl), NOT in Foo
		// (which has startLine 0 too but is in a different file).
		assert.deepStrictEqual(stops, { Baz: [3] });
	});

	test('matched array preserves the order and identity of the input bps', () => {
		const bp1 = { tag: 'one' };
		const bp2 = { tag: 'two' };
		const bp3 = { tag: 'orphan' };  // before the first function — should not appear in matched
		const linkInfoGap: LinkInfoRow[] = [
			{ aplName: 'F', filePath: '/x.apl', startLine: 5 },
		];
		const { matched } = mapBreakpointsToStops(
			[
				{ line: 6, bp: bp1 },
				{ line: 2, bp: bp3 },
				{ line: 7, bp: bp2 },
			],
			'/x.apl',
			linkInfoGap,
		);
		// bp3 dropped; bp1 and bp2 kept in their original order.
		assert.deepStrictEqual(matched, [bp1, bp2]);
	});

	test('path matching uses normPath (Windows drive-letter casing)', () => {
		// normPath uppercases the drive letter, so paths that differ only
		// in drive-letter case must still match.
		const winLinkInfo: LinkInfoRow[] = [
			{ aplName: 'Win', filePath: 'C:/repo/a.apl', startLine: 0 },
		];
		const { stops } = mapBreakpointsToStops(
			[{ line: 4, bp: 'a' }],
			'c:/repo/a.apl',           // lowercase drive letter
			winLinkInfo,
		);
		assert.deepStrictEqual(stops, { Win: [4] });
	});

	test('does not mutate the input linkInfo or items array', () => {
		const items = [{ line: 3, bp: 'a' }];
		const itemsClone = JSON.parse(JSON.stringify(items));
		const linkInfoClone = JSON.parse(JSON.stringify(linkInfo));
		mapBreakpointsToStops(items, '/repo/a.apl', linkInfo);
		assert.deepStrictEqual(items, itemsClone);
		assert.deepStrictEqual(linkInfo, linkInfoClone);
	});
});
