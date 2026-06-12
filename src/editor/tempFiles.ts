import * as os from 'os';
import * as fs from 'fs';
import * as Path from 'path';

/** Shared temp directory for all vscode-apl temp files (edit windows and debug tracers). */
export const TEMP_DIR = Path.join(os.tmpdir(), 'vscode-apl');

/**
 * FNV-1a 32-bit hash of `name`, formatted as 8 lowercase-hex characters.
 *
 * Used as a per-identifier subdir so that case-variant APL names
 * (`M` vs `m`, `Foo` vs `foo`) get distinct on-disk paths on
 * case-insensitive filesystems (NTFS, default APFS, HFS+). The output
 * uses only `[0-9a-f]`, all of which case-fold to themselves, so the
 * tag cannot case-collide with itself.
 */
export function caseTag(name: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		h = (h ^ name.charCodeAt(i)) * 0x01000193;
		h = h >>> 0;
	}
	return ('00000000' + h.toString(16)).slice(-8);
}

/**
 * Per-identifier temp file path:
 *   <TEMP_DIR>/<replId>/<caseTag(name)>/<safeName>.<ext>
 *
 * The case-tag subdir disambiguates names that differ only in case so
 * they don't collide on case-insensitive filesystems. The basename
 * keeps the original casing of the identifier so VS Code's tab title
 * reads naturally.
 *
 * Pure: caller is responsible for `mkdirSync(dirname, { recursive: true })`
 * before writing.
 */
export function tempFilePath(replId: string, name: string, ext: string): string {
	const safeName = name.replace(/[⎕#./\\:*?"<>|]/g, '_');
	return Path.join(TEMP_DIR, replId, caseTag(name), `${safeName}.${ext}`);
}

/** Remove leftover temp files and per-REPL subdirs from a previous session
 *  (e.g. after a crash).  Uses rmSync with recursive+force so it handles
 *  both files (edit-window temp files at the top level) and directories
 *  (per-REPL tracer dirs). */
export function cleanTempDir(): void {
	if (!fs.existsSync(TEMP_DIR)) { return; }
	try {
		for (const entry of fs.readdirSync(TEMP_DIR)) {
			try { fs.rmSync(Path.join(TEMP_DIR, entry), { recursive: true, force: true }); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}
