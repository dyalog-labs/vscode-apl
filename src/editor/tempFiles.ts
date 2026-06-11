import * as os from 'os';
import * as fs from 'fs';
import * as Path from 'path';

/** Shared temp directory for all vscode-apl temp files (edit windows and debug tracers). */
export const TEMP_DIR = Path.join(os.tmpdir(), 'vscode-apl');

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
