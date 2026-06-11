/*---------------------------------------------------------
 * Copyright (C) Tiamatica, martanit. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { activateExtension } from './activateExtension';

export function activate(context: vscode.ExtensionContext) {
	return activateExtension(context);
}

export function deactivate() {
	// nothing to do
}
