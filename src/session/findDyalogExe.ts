import * as cp from 'child_process';
import * as fs from 'fs';
import * as Path from 'path';

/**
 * Locate the installed Dyalog interpreter.
 *
 * No `vscode` dependency, so tests and production both use it.
 */

/**
 * Find the dyalog executable. Checks PATH first, then known install locations.
 * Returns the full path to the executable, or undefined if not found.
 */
export function findDyalogExe(): string | undefined {
	// Check PATH first
	try {
		const cmd = process.platform === 'win32' ? 'where dyalog' : 'which dyalog';
		const result = cp.execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		if (result) return result.split(/\r?\n/)[0];
	} catch {}

	// Check known install locations
	if (process.platform === 'win32') {
		const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
		const dyalogBase = Path.join(programFiles, 'Dyalog');
		try {
			const dirs = fs.readdirSync(dyalogBase)
				.filter(d => /^Dyalog APL/i.test(d))
				.sort()
				.reverse(); // Latest version first
			for (const dir of dirs) {
				const exePath = Path.join(dyalogBase, dir, 'dyalog.exe');
				if (fs.existsSync(exePath)) {
					return exePath;
				}
			}
		} catch {}
	} else {
		const candidates = [
			'/opt/mdyalog/19.0/64/unicode/mapl',
			'/opt/mdyalog/18.2/64/unicode/mapl',
			'/usr/local/bin/dyalog',
		];
		for (const p of candidates) {
			if (fs.existsSync(p)) return p;
		}
	}

	return undefined;
}

/**
 * Find the Dyalog installation directory.
 * Returns the directory containing the dyalog executable, or undefined.
 */
export function findDyalogDir(): string | undefined {
	const exe = findDyalogExe();
	return exe ? Path.dirname(exe) : undefined;
}
