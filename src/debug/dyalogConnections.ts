import * as fs from 'fs';
import * as os from 'os';
import * as Path from 'path';

/**
 * Discovery of Dyalog/RIDE's `connections.json` — the file where the
 * user's saved interpreter connections live. Used by the extension's
 * debug-configuration provider to surface "launch into this Dyalog"
 * entries in the F5 picker.
 *
 * No `vscode` dependency.
 */

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
