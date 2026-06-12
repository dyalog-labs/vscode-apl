import * as assert from 'assert';
import * as Path from 'path';
import { tempFilePath, caseTag, TEMP_DIR } from '../../editor/tempFiles';

/**
 * The edit-window and debug-tracer paths used to be derived directly from
 * the APL identifier:
 *
 *   <TEMP_DIR>/<replId>/<safeName>.<ext>
 *
 * On Windows (NTFS) and macOS (HFS+ / APFS-default), the filesystem is
 * case-insensitive, so two identifiers differing only in case — say `M`
 * and `m` — would collide on the same backing file. Writing `m`
 * truncated `M`'s file (or vice versa) and VS Code's tab labels
 * reflected the on-disk casing, surprising the user.
 *
 * The fix interposes a case-sensitive hash subdir between the replId
 * and the original-cased basename:
 *
 *   <TEMP_DIR>/<replId>/<caseTag(name)>/<safeName>.<ext>
 *
 * `caseTag` is lowercase hex, so it cannot case-collide with itself.
 * `M` and `m` therefore live under different `caseTag` subdirs and end
 * up at paths that differ case-insensitively. The original casing of
 * the basename is preserved so VS Code's tab title reads naturally.
 */

suite('tempFilePath — case-insensitive filesystem safety', () => {
	test('M and m get distinct paths (case-sensitive)', () => {
		const a = tempFilePath('r1', 'M', 'apl');
		const b = tempFilePath('r1', 'm', 'apl');
		assert.notStrictEqual(a, b);
	});

	test('M and m paths differ case-INsensitively too (the actual bug)', () => {
		// This is the load-bearing invariant: if two paths case-fold to the
		// same string, NTFS/HFS+ treats them as the same file. The fix is
		// meaningless unless this passes.
		const a = tempFilePath('r1', 'M', 'apl');
		const b = tempFilePath('r1', 'm', 'apl');
		assert.notStrictEqual(a.toLowerCase(), b.toLowerCase());
	});

	test('basename preserves the original casing of the identifier', () => {
		// The tab title in VS Code is derived from the file basename, so
		// the user expects to see `M.apl` for `M` and `m.apl` for `m`.
		assert.strictEqual(Path.basename(tempFilePath('r1', 'M', 'apl')), 'M.apl');
		assert.strictEqual(Path.basename(tempFilePath('r1', 'm', 'apl')), 'm.apl');
	});

	test('same (replId, name, ext) → same path (deterministic)', () => {
		// Stable paths are important: VS Code persists breakpoints by
		// file path, and reopening the same variable should land at the
		// same file across sessions.
		const a = tempFilePath('r1', 'Foo', 'apl');
		const b = tempFilePath('r1', 'Foo', 'apl');
		assert.strictEqual(a, b);
	});

	test('different replIds → different paths even for the same name', () => {
		const a = tempFilePath('r1', 'Foo', 'apl');
		const b = tempFilePath('r2', 'Foo', 'apl');
		assert.notStrictEqual(a, b);
	});

	test('special characters in the identifier are stripped from the basename', () => {
		// Quad-prefixed names, dots, slashes etc. are not valid in
		// filesystem paths; the safe-name regex replaces them with `_`.
		assert.strictEqual(Path.basename(tempFilePath('r1', '⎕CR', 'apl')), '_CR.apl');
		assert.strictEqual(Path.basename(tempFilePath('r1', '#.Ns', 'apl')), '__Ns.apl');
	});

	test('edit-window (.apl) and tracer (.aplf) for the same name share the case-tag dir', () => {
		// Both surfaces deriving from the same identifier should agree on
		// the parent directory. That keeps the layout coherent and makes
		// the path stable when the same name is edited in different
		// contexts (variable / function / tracer).
		const a = tempFilePath('r1', 'Foo', 'apl');
		const t = tempFilePath('r1', 'Foo', 'aplf');
		assert.strictEqual(Path.dirname(a), Path.dirname(t));
	});

	test('full path is rooted under TEMP_DIR/<replId>', () => {
		const p = tempFilePath('repl-7', 'Foo', 'apl');
		assert.ok(
			p.startsWith(Path.join(TEMP_DIR, 'repl-7') + Path.sep),
			`expected ${p} to start with ${Path.join(TEMP_DIR, 'repl-7')}`,
		);
	});
});

suite('caseTag', () => {
	test('returns lowercase-hex only — cannot case-collide with itself', () => {
		// Critical: if the tag contained uppercase letters, two tags could
		// case-fold to the same string on NTFS, defeating the disambiguation.
		for (const n of ['M', 'm', 'Foo', 'fOO', 'A', 'a', '⎕CR', 'mixed_Case', '']) {
			const tag = caseTag(n);
			assert.match(tag, /^[0-9a-f]+$/, `tag for "${n}" must be lowercase hex, got ${tag}`);
		}
	});

	test('case-sensitive: M and m get different tags', () => {
		assert.notStrictEqual(caseTag('M'), caseTag('m'));
	});

	test('deterministic: same input → same tag', () => {
		assert.strictEqual(caseTag('Foo'), caseTag('Foo'));
	});

	test('distinguishes case patterns of the same letters', () => {
		// `Mm`, `mM`, `MM`, `mm` are four different APL identifiers and
		// must each get a unique tag.
		const tags = new Set([caseTag('Mm'), caseTag('mM'), caseTag('MM'), caseTag('mm')]);
		assert.strictEqual(tags.size, 4);
	});
});
