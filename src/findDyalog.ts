import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as Path from 'path';

/**
 * Find the dyalog executable. Checks PATH first, then known install locations.
 * Returns the full path to the executable, or undefined if not found.
 *
 * This module has no `vscode` dependency so it can be used from tests
 * and production code alike.
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

const MAX_DYALOG_VERSION = 20;

export interface DyalogConnection {
	name?: string;
	type?: string;
	subtype?: string;
	exe?: string;
	port?: string;
	host?: string;
	args?: string;
	preset?: boolean;
}

/**
 * Return the platform-specific directory where Dyalog/RIDE store per-version config.
 * macOS:  ~/Library/Application Support/
 * Linux:  ~/.config/
 * Windows: %APPDATA%
 */
function getAppDataDir(): string | undefined {
	if (process.platform === 'darwin') {
		return Path.join(os.homedir(), 'Library', 'Application Support');
	} else if (process.platform === 'win32') {
		return process.env['APPDATA'];
	} else {
		return Path.join(os.homedir(), '.config');
	}
}

/**
 * Find the connections.json from the latest installed Dyalog version
 * (capped at MAX_DYALOG_VERSION). Scans Dyalog-{version} directories.
 */
export function findConnectionsFile(): string | undefined {
	const appData = getAppDataDir();
	if (!appData || !fs.existsSync(appData)) {
		return undefined;
	}

	try {
		const entries = fs.readdirSync(appData);
		let bestVersion = 0;
		let bestPath: string | undefined;

		for (const entry of entries) {
			const match = entry.match(/^Dyalog-(\d+(?:\.\d+)?)$/);
			if (!match) { continue; }
			const version = parseFloat(match[1]);
			if (version > MAX_DYALOG_VERSION) { continue; }
			if (version <= bestVersion) { continue; }

			const connFile = Path.join(appData, entry, 'connections.json');
			if (fs.existsSync(connFile)) {
				bestVersion = version;
				bestPath = connFile;
			}
		}
		return bestPath;
	} catch {
		return undefined;
	}
}
