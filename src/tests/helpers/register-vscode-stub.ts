/**
 * Mocha --require hook that registers a vscode module stub.
 * This allows tests to run outside the VS Code Extension Host.
 *
 * Usage: mocha --require out/tests/helpers/register-vscode-stub.js
 */
import Module = require('module');

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
	if (request === 'vscode') {
		return require.resolve('./vscode-stub');
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};
