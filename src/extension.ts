/*---------------------------------------------------------
 * Copyright (C) Tiamatica, martanit. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { activateAplDebug } from './activateAplDebug';
import { ReplManager } from './replManager';

export function activate(context: vscode.ExtensionContext) {
	activateAplDebug(context);
	return { replManager: ReplManager.getInstance() };
}

export function deactivate() {
	// nothing to do
}
