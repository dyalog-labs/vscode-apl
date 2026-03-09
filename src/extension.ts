/*---------------------------------------------------------
 * Copyright (C) Tiamatica, martanit. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { activateAplDebug } from './activateAplDebug';

export function activate(context: vscode.ExtensionContext) {
	activateAplDebug(context);
}

export function deactivate() {
	// nothing to do
}
