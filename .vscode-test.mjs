import { defineConfig } from '@vscode/test-cli';
import { findDyalogExe } from './out/findDyalog.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

const dyalogExe = findDyalogExe();

// Write workspace settings so VS Code picks up the interpreter path
const settingsDir = './sampleWorkspace/.vscode';
const settingsPath = settingsDir + '/settings.json';
if (dyalogExe) {
	if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify({
		'apl.interpreter.path': dyalogExe,
	}, null, '\t') + '\n');
}

export default defineConfig({
	files: 'out/tests/e2e/**/*.test.js',
	workspaceFolder: './sampleWorkspace',
	mocha: {
		ui: 'tdd',
		timeout: 60000,
	},
	env: {
		...(dyalogExe ? { DYALOG_TESTS: '1' } : {}),
	},
});
