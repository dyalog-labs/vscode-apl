import * as vscode from 'vscode';
import * as fs from 'fs';
import * as Path from 'path';
import * as cp from 'child_process';

/**
 * Mapping from APL glyphs to their symbol overview page
 * (relative to language-reference-guide/).
 *
 * Each glyph maps to its symbols/<name>.htm overview page, which
 * matches the behaviour of the original Dyalog help viewer.
 */
const GLYPH_DOC_MAP: Record<string, string> = {
	// Arithmetic
	'+': 'symbols/plus.htm',
	'-': 'symbols/minus.htm',
	'×': 'symbols/times.htm',
	'÷': 'symbols/divide.htm',
	'|': 'symbols/stile.htm',
	'*': 'symbols/star.htm',
	'⍟': 'symbols/log.htm',
	'○': 'symbols/circle.htm',
	'⌈': 'symbols/upstile.htm',
	'⌊': 'symbols/downstile.htm',
	'!': 'symbols/exclamation-mark.htm',
	'?': 'symbols/question-mark.htm',
	'⌹': 'symbols/domino.htm',

	// Comparison
	'<': 'symbols/less-than.htm',
	'≤': 'symbols/less-than-or-equal-to.htm',
	'=': 'symbols/equal.htm',
	'≥': 'symbols/greater-than-or-equal-to.htm',
	'>': 'symbols/greater-than.htm',
	'≠': 'symbols/not-equal.htm',
	'≡': 'symbols/equal-underbar.htm',
	'≢': 'symbols/equal-underbar-slash.htm',

	// Logical
	'∧': 'symbols/logical-and.htm',
	'∨': 'symbols/logical-or.htm',
	'⍲': 'symbols/logical-nand.htm',
	'⍱': 'symbols/logical-nor.htm',
	'~': 'symbols/tilde.htm',

	// Structural
	'⍴': 'symbols/rho.htm',
	',': 'symbols/comma.htm',
	'⍪': 'symbols/comma-bar.htm',
	'⌽': 'symbols/circle-stile.htm',
	'⊖': 'symbols/circle-bar.htm',
	'⍉': 'symbols/circle-backslash.htm',

	// Selection
	'↑': 'symbols/up-arrow.htm',
	'↓': 'symbols/down-arrow.htm',
	'⊂': 'symbols/left-shoe.htm',
	'⊆': 'symbols/left-shoe-underbar.htm',
	'⊃': 'symbols/right-shoe.htm',
	'⍳': 'symbols/iota.htm',
	'⍸': 'symbols/iota-underbar.htm',
	'∊': 'symbols/epsilon.htm',
	'⍷': 'symbols/epsilon-underbar.htm',
	'⍋': 'symbols/grade-up.htm',
	'⍒': 'symbols/grade-down.htm',
	'⌷': 'symbols/squad.htm',
	'∩': 'symbols/up-shoe.htm',
	'∪': 'symbols/down-shoe.htm',

	// Miscellaneous functions
	'⊤': 'symbols/down-tack.htm',
	'⊥': 'symbols/up-tack.htm',
	'⊢': 'symbols/right-tack.htm',
	'⊣': 'symbols/left-tack.htm',
	'⍎': 'symbols/hydrant.htm',
	'⍕': 'symbols/thorn.htm',

	// Operators
	'/': 'symbols/slash.htm',
	'\\': 'symbols/backslash.htm',
	'⌿': 'symbols/slash-bar.htm',
	'⍀': 'symbols/backslash-bar.htm',
	'¨': 'symbols/diaeresis.htm',
	'⍨': 'symbols/tilde-diaeresis.htm',
	'⍤': 'symbols/jot-diaeresis.htm',
	'⍣': 'symbols/star-diaeresis.htm',
	'⍥': 'symbols/circle-diaeresis.htm',
	'∘': 'symbols/jot.htm',
	'⍛': 'symbols/jot-underbar.htm',
	'⌸': 'symbols/quad-equal.htm',
	'⌺': 'symbols/quad-diamond.htm',
	'⍠': 'symbols/quad-colon.htm',
	'⌶': 'symbols/ibeam.htm',
	'@': 'symbols/at.htm',
	'&': 'symbols/ampersand.htm',

	// Other syntax
	'←': 'symbols/left-arrow.htm',
	'→': 'symbols/right-arrow.htm',
	'⋄': 'glyphs.htm',
	'⍝': 'glyphs.htm',
	'⍬': 'symbols/zilde.htm',
	'⍞': 'system-functions/character-input-output.htm',

	// I/O
	'⎕': 'system-functions/evaluated-input-output.htm',
};

/**
 * System function name (lowercase, without ⎕ prefix) → doc page path
 * (relative to language-reference-guide/system-functions/).
 */
const SYSTEM_FN_DOC_MAP: Record<string, string> = {
	'a': 'a.htm', 'ai': 'ai.htm', 'an': 'an.htm',
	'arbin': 'arbin.htm', 'arbout': 'arbout.htm',
	'at': 'at.htm', 'atx': 'atx.htm', 'av': 'av.htm', 'avu': 'avu.htm',
	'base': 'base.htm', 'c': 'c.htm', 'class': 'class.htm',
	'clear': 'clear.htm', 'cmd': 'cmd.htm', 'cr': 'cr.htm',
	'cs': 'cs.htm', 'csv': 'csv.htm', 'ct': 'ct.htm', 'cy': 'cy.htm',
	'd': 'd.htm', 'dct': 'dct.htm', 'df': 'df.htm', 'div': 'div.htm',
	'dl': 'dl.htm', 'dm': 'dm.htm', 'dmx': 'dmx.htm',
	'dq': 'dq.htm', 'dr': 'dr.htm', 'dt': 'dt.htm',
	'ed': 'ed.htm', 'em': 'em.htm', 'en': 'en.htm',
	'ex': 'ex.htm', 'exception': 'exception.htm', 'export': 'export.htm',
	'fappend': 'fappend.htm', 'favail': 'favail.htm',
	'fchk': 'fchk.htm', 'fcopy': 'fcopy.htm', 'fcreate': 'fcreate.htm',
	'fdrop': 'fdrop.htm', 'ferase': 'ferase.htm', 'fhist': 'fhist.htm',
	'fhold': 'fhold.htm', 'fix': 'fix.htm', 'flib': 'flib.htm',
	'fmt': 'fmt.htm', 'fnames': 'fnames.htm', 'fnums': 'fnums.htm',
	'fprops': 'fprops.htm', 'fr': 'fr.htm', 'frdac': 'frdac.htm',
	'frdci': 'frdci.htm', 'fread': 'fread.htm', 'frename': 'frename.htm',
	'freplace': 'freplace.htm', 'fresize': 'fresize.htm',
	'fsize': 'fsize.htm', 'fstac': 'fstac.htm', 'fstie': 'fstie.htm',
	'ftie': 'ftie.htm', 'funtie': 'funtie.htm', 'fx': 'fx.htm',
	'instances': 'instances.htm', 'io': 'io.htm',
	'json': 'json.htm', 'kl': 'kl.htm', 'lc': 'lc.htm',
	'load': 'load.htm', 'lock': 'lock.htm', 'lx': 'lx.htm',
	'map': 'map.htm', 'mkdir': 'mkdir.htm', 'ml': 'ml.htm',
	'monitor': 'monitor.htm', 'na': 'na.htm',
	'nappend': 'nappend.htm', 'nc': 'nc.htm', 'ncopy': 'ncopy.htm',
	'ncreate': 'ncreate.htm', 'ndelete': 'ndelete.htm',
	'nerase': 'nerase.htm', 'new': 'new.htm', 'nexists': 'nexists.htm',
	'nget': 'nget.htm', 'ninfo': 'ninfo.htm', 'nl': 'nl.htm',
	'nlock': 'nlock.htm', 'nmove': 'nmove.htm', 'nnames': 'nnames.htm',
	'nnums': 'nnums.htm', 'nparts': 'nparts.htm', 'nput': 'nput.htm',
	'nq': 'nq.htm', 'nr': 'nr.htm', 'nread': 'nread.htm',
	'nrename': 'nrename.htm', 'nreplace': 'nreplace.htm',
	'nresize': 'nresize.htm', 'ns': 'ns.htm', 'nsi': 'nsi.htm',
	'nsize': 'nsize.htm', 'ntie': 'ntie.htm', 'null': 'null.htm',
	'nuntie': 'nuntie.htm', 'nxlate': 'nxlate.htm',
	'off': 'off.htm', 'opt': 'opt.htm', 'or': 'or.htm',
	'path': 'path.htm', 'pfkey': 'pfkey.htm', 'pp': 'pp.htm',
	'profile': 'profile.htm', 'pw': 'pw.htm',
	'r': 'r.htm', 'refs': 'refs.htm', 'rl': 'rl.htm',
	'rsi': 'rsi.htm', 'rtl': 'rtl.htm',
	's': 's.htm', 'save': 'save.htm', 'sd': 'sd.htm', 'se': 'se.htm',
	'sh': 'sh.htm', 'shadow': 'shadow.htm', 'si': 'si.htm',
	'signal': 'signal.htm', 'size': 'size.htm', 'sm': 'sm.htm',
	'sr': 'sr.htm', 'src': 'src.htm', 'stack': 'stack.htm',
	'state': 'state.htm', 'stop': 'stop.htm',
	'svc': 'svc.htm', 'svo': 'svo.htm', 'svq': 'svq.htm',
	'svr': 'svr.htm', 'svs': 'svs.htm',
	'tc': 'tc.htm', 'tcnums': 'tcnums.htm', 'tget': 'tget.htm',
	'this': 'this.htm', 'tid': 'tid.htm', 'tkill': 'tkill.htm',
	'tname': 'tname.htm', 'tnums': 'tnums.htm', 'tpool': 'tpool.htm',
	'tput': 'tput.htm', 'trace': 'trace.htm', 'trap': 'trap.htm',
	'treq': 'treq.htm', 'ts': 'ts.htm', 'tsync': 'tsync.htm',
	'ucs': 'ucs.htm', 'using': 'using.htm',
	'vfi': 'vfi.htm', 'vr': 'vr.htm',
	'wa': 'wa.htm', 'wc': 'wc.htm', 'wg': 'wg.htm', 'wn': 'wn.htm',
	'ws': 'ws.htm', 'wsid': 'wsid.htm', 'wx': 'wx.htm',
	'xml': 'xml.htm', 'xsi': 'xsi.htm', 'xt': 'xt.htm',
	'talloc': 'talloc.htm', 'vget': 'vget.htm', 'vset': 'vset.htm',
};

/**
 * System command name (lowercase, without ) prefix) → doc page path
 * (relative to language-reference-guide/system-commands/).
 */
const SYSTEM_CMD_DOC_MAP: Record<string, string> = {
	'classes': 'classes.htm', 'clear': 'clear.htm', 'cmd': 'cmd.htm',
	'continue': 'continue.htm', 'copy': 'copy.htm', 'cs': 'cs.htm',
	'drop': 'drop.htm', 'ed': 'ed.htm', 'erase': 'erase.htm',
	'events': 'events.htm', 'fns': 'fns.htm', 'holds': 'holds.htm',
	'lib': 'lib.htm', 'load': 'load.htm', 'methods': 'methods.htm',
	'ns': 'ns.htm', 'objects': 'objects.htm', 'obs': 'obs.htm',
	'off': 'off.htm', 'ops': 'ops.htm', 'pcopy': 'pcopy.htm',
	'props': 'props.htm', 'reset': 'reset.htm', 'save': 'save.htm',
	'sh': 'sh.htm', 'si': 'si.htm', 'sic': 'sic.htm', 'sinl': 'sinl.htm',
	'tid': 'tid.htm', 'vars': 'vars.htm', 'wsid': 'wsid.htm',
	'xload': 'xload.htm',
};

/**
 * Control structure keyword (lowercase, without : prefix) → doc page path
 * (relative to programming-reference-guide/defined-functions-and-operators/
 * traditional-functions-and-operators/control-structures/).
 *
 * Sub-keywords (e.g. :AndIf, :ElseIf) map to their parent structure page.
 */
const CS = 'programming-reference-guide/defined-functions-and-operators/traditional-functions-and-operators/control-structures/';
const CONTROL_STRUCTURE_DOC_MAP: Record<string, string> = {
	// Flow control
	'if': CS + 'if.htm',
	'andif': CS + 'if.htm',
	'orif': CS + 'if.htm',
	'else': CS + 'if.htm',
	'elseif': CS + 'if.htm',
	'endif': CS + 'if.htm',

	'select': CS + 'select.htm',
	'case': CS + 'select.htm',
	'caselist': CS + 'select.htm',
	'endselect': CS + 'select.htm',

	// Loops
	'for': CS + 'for.htm',
	'forin': CS + 'for.htm',
	'in': CS + 'for.htm',
	'ineach': CS + 'for.htm',
	'endfor': CS + 'for.htm',

	'while': CS + 'while.htm',
	'endwhile': CS + 'while.htm',

	'repeat': CS + 'repeat.htm',
	'until': CS + 'repeat.htm',
	'endrepeat': CS + 'repeat.htm',

	'leave': CS + 'leave.htm',
	'continue': CS + 'continue.htm',
	'return': CS + 'return.htm',
	'goto': CS + 'goto.htm',

	// Error handling
	'trap': CS + 'trap.htm',
	'endtrap': CS + 'trap.htm',

	'hold': CS + 'hold.htm',
	'endhold': CS + 'hold.htm',

	'disposable': CS + 'disposable.htm',
	'enddisposable': CS + 'disposable.htm',

	'with': CS + 'with.htm',
	'endwith': CS + 'with.htm',

	// OOP
	'class': CS + 'class.htm',
	'endclass': CS + 'class.htm',

	'namespace': CS + 'namespace.htm',
	'endnamespace': CS + 'namespace.htm',

	'interface': CS + 'interface.htm',
	'endinterface': CS + 'interface.htm',

	'section': CS + 'section.htm',
	'endsection': CS + 'section.htm',

	'using': CS + 'using.htm',
	'endusing': CS + 'using.htm',

	'implements': CS + 'implements.htm',
	'access': CS + 'access.htm',
	'attribute': CS + 'attribute.htm',
	'signature': CS + 'signature.htm',
};

let helpPanel: vscode.WebviewPanel | undefined;
let extractedPath: string | undefined;
let helpHistory: string[][] = [];
let helpCurrentPages: string[] | undefined;

/**
 * Find the Dyalog installation directory (containing dyalog.exe).
 */
function findDyalogDir(): string | undefined {
	// Check user-configured path first
	const configured = vscode.workspace.getConfiguration('apl').get<string>('interpreter.path');
	if (configured && fs.existsSync(configured)) {
		return Path.dirname(configured);
	}

	if (!/^win/i.test(process.platform)) {
		return undefined;
	}

	const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
	const dyalogBase = Path.join(programFiles, 'Dyalog');
	if (!fs.existsSync(dyalogBase)) {
		return undefined;
	}

	try {
		const dirs = fs.readdirSync(dyalogBase)
			.filter(d => /^Dyalog APL/i.test(d))
			.sort()
			.reverse();

		for (const dir of dirs) {
			const exePath = Path.join(dyalogBase, dir, 'dyalog.exe');
			if (fs.existsSync(exePath)) {
				return Path.join(dyalogBase, dir);
			}
		}
	} catch { /* ignore */ }

	return undefined;
}

/**
 * Extract the CHM file to the extension's global storage directory.
 * Returns the path to the extracted content, or undefined on failure.
 */
async function ensureExtracted(globalStoragePath: string): Promise<string | undefined> {
	if (extractedPath && fs.existsSync(Path.join(extractedPath, 'language-reference-guide'))) {
		return extractedPath;
	}

	const dyalogDir = findDyalogDir();
	if (!dyalogDir) {
		vscode.window.showErrorMessage('Dyalog APL installation not found. Set apl.interpreter.path in settings.');
		return undefined;
	}

	const chmPath = Path.join(dyalogDir, 'help', 'dyalog.chm');
	if (!fs.existsSync(chmPath)) {
		vscode.window.showErrorMessage(`Documentation file not found: ${chmPath}`);
		return undefined;
	}

	const destDir = Path.join(globalStoragePath, 'help');

	// Check if already extracted and CHM hasn't changed
	const markerFile = Path.join(destDir, '.extracted');
	if (fs.existsSync(markerFile)) {
		try {
			const markerTime = fs.statSync(markerFile).mtimeMs;
			const chmTime = fs.statSync(chmPath).mtimeMs;
			if (markerTime >= chmTime && fs.existsSync(Path.join(destDir, 'language-reference-guide'))) {
				extractedPath = destDir;
				return destDir;
			}
		} catch { /* re-extract */ }
	}

	// Extract CHM using PowerShell Start-Process -Wait (hh.exe is a GUI app
	// that returns immediately, so cp.spawn can't wait for it)
	fs.mkdirSync(destDir, { recursive: true });

	try {
		cp.execSync(
			`powershell.exe -NoProfile -Command "Start-Process -FilePath 'hh.exe' -ArgumentList @('-decompile','${destDir.replace(/'/g, "''")}','${chmPath.replace(/'/g, "''")}') -Wait -NoNewWindow"`,
			{ timeout: 30000, windowsHide: true }
		);
	} catch (e) {
		vscode.window.showErrorMessage('Failed to extract documentation from CHM file.');
		return undefined;
	}

	if (fs.existsSync(Path.join(destDir, 'language-reference-guide'))) {
		fs.writeFileSync(markerFile, new Date().toISOString());
		extractedPath = destDir;
		return destDir;
	}

	vscode.window.showErrorMessage('Failed to extract documentation from CHM file.');
	return undefined;
}

/**
 * Detect the APL token under the cursor and return its doc page path
 * (relative to language-reference-guide/) or undefined.
 */
function getDocPages(document: vscode.TextDocument, position: vscode.Position): string[] | undefined {
	const line = document.lineAt(position.line).text;
	const col = position.character;

	// Try the character before the cursor first (left wins), then at cursor
	const charsToTry = col > 0 ? [col - 1, col] : [col];

	const LRG = 'language-reference-guide/';
	for (const c of charsToTry) {
		if (c < 0 || c >= line.length) { continue; }
		const ch = line[c];

		// Control structure: :Keyword
		if (ch === ':' || /[a-zA-Z]/.test(ch)) {
			const csPage = tryControlStructure(line, c);
			if (csPage) { return [csPage]; }
		}

		// System command: )Name
		if (ch === ')' || /[a-zA-Z]/.test(ch)) {
			const cmdPage = trySystemCommand(line, c);
			if (cmdPage) { return [LRG + cmdPage]; }
		}

		// System function: ⎕Name — scan to find full ⎕Name around position
		if (ch === '⎕' || /[a-zA-Z]/.test(ch)) {
			const sysFn = trySystemFunction(line, c);
			if (sysFn) { return [LRG + sysFn]; }
		}

		// Glyph lookup
		const page = GLYPH_DOC_MAP[ch];
		if (page) {
			return [LRG + page];
		}
	}

	return undefined;
}

/**
 * Try to resolve a system command ()Name) around the given column.
 * Returns path relative to language-reference-guide/, or undefined.
 */
function trySystemCommand(line: string, col: number): string | undefined {
	// Scan backward to find the )
	let start = col;
	while (start > 0 && /[a-zA-Z]/.test(line[start])) { start--; }
	if (line[start] !== ')') { return undefined; }

	// Scan forward to find the end of the command name
	let end = start + 1;
	while (end < line.length && /[a-zA-Z]/.test(line[end])) { end++; }

	const name = line.substring(start + 1, end).toLowerCase();
	if (name.length === 0) { return undefined; }

	const page = SYSTEM_CMD_DOC_MAP[name];
	return page ? `system-commands/${page}` : undefined;
}

/**
 * Try to resolve a control structure (:Keyword) around the given column.
 * Returns full path relative to docBasePath, or undefined.
 */
function tryControlStructure(line: string, col: number): string | undefined {
	// Scan backward to find the :
	let start = col;
	while (start > 0 && /[a-zA-Z]/.test(line[start])) { start--; }
	if (line[start] !== ':') { return undefined; }

	// Scan forward to find the end of the keyword
	let end = start + 1;
	while (end < line.length && /[a-zA-Z]/.test(line[end])) { end++; }

	const name = line.substring(start + 1, end).toLowerCase();
	if (name.length === 0) { return undefined; }

	return CONTROL_STRUCTURE_DOC_MAP[name];
}

/**
 * Try to resolve a system function (⎕Name) around the given column.
 */
function trySystemFunction(line: string, col: number): string | undefined {
	// Scan backward to find the ⎕
	let start = col;
	while (start > 0 && /[a-zA-Z]/.test(line[start])) { start--; }
	if (line[start] !== '⎕') { return undefined; }

	// Scan forward to find the end of the name
	let end = start + 1;
	while (end < line.length && /[a-zA-Z]/.test(line[end])) { end++; }

	const name = line.substring(start + 1, end).toLowerCase();
	if (name.length === 0) {
		return 'system-functions/evaluated-input-output.htm';
	}

	const page = SYSTEM_FN_DOC_MAP[name];
	return page ? `system-functions/${page}` : undefined;
}

/**
 * Show one or more documentation pages in a VS Code webview panel.
 * When multiple paths are given (monadic + dyadic), their bodies are combined.
 */
async function showDocPage(docBasePath: string, relativePaths: string[], isBack = false): Promise<void> {
	const lrgDir = Path.join(docBasePath, 'language-reference-guide');
	const imgBaseDir = Path.join(lrgDir, 'img');

	// Read all pages, skip missing ones.
	// Paths may reference other top-level sections (e.g. programming-reference-guide),
	// so resolve relative to docBasePath and guard against traversal beyond it.
	const pages: { html: string; dir: string; title: string }[] = [];
	for (const rel of relativePaths) {
		const fullPath = Path.resolve(docBasePath, rel);
		if (!fullPath.startsWith(docBasePath + Path.sep) && fullPath !== docBasePath) { continue; }
		if (!fs.existsSync(fullPath)) { continue; }
		const raw = fs.readFileSync(fullPath, 'utf-8');
		const titleMatch = raw.match(/<title>(.*?)<\/title>/i);
		pages.push({ html: raw, dir: Path.dirname(fullPath), title: titleMatch?.[1] || '' });
	}
	if (pages.length === 0) {
		vscode.window.showWarningMessage(`Documentation page not found: ${relativePaths[0]}`);
		return;
	}

	// Track navigation history
	if (!isBack && helpCurrentPages) {
		helpHistory.push(helpCurrentPages);
	}
	helpCurrentPages = relativePaths;

	const title = `APL: ${pages.map(p => p.title).join(' / ')}`;

	// Create or reuse panel
	if (helpPanel) {
		helpPanel.title = title;
		helpPanel.reveal(vscode.ViewColumn.Beside, false);
	} else {
		helpPanel = vscode.window.createWebviewPanel(
			'aplDocumentation',
			title,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(docBasePath)],
			}
		);
		helpPanel.onDidDispose(() => { helpPanel = undefined; helpHistory = []; helpCurrentPages = undefined; });
		helpPanel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'navigate' && msg.path) {
				await showDocPage(docBasePath, [msg.path]);
			} else if (msg.type === 'back' && helpHistory.length > 0) {
				const prev = helpHistory.pop()!;
				await showDocPage(docBasePath, prev, true);
			}
		});
	}

	let html: string;
	if (pages.length === 1) {
		html = pages[0].html;
	} else {
		// Combine: use first page's <head>, merge bodies with a separator
		const head = pages[0].html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] || '';
		const bodies = pages.map(p => {
			const bodyMatch = p.html.match(/<body>([\s\S]*)<\/body>/i);
			return bodyMatch?.[1] || '';
		});
		html = `<!DOCTYPE html><html lang=en><head>${head}</head><body>${bodies.join('<hr style="border:none;border-top:2px solid #d9d9d9;margin:24px 0">')}</body></html>`;
	}

	// Fix image src paths to use webview URIs
	const primaryDir = pages[0].dir;
	html = html.replace(/src="([^"]+\.(png|jpg|gif|svg))"/gi, (_match, imgPath: string) => {
		let absoluteImgPath: string;
		if (Path.isAbsolute(imgPath)) {
			absoluteImgPath = imgPath;
		} else {
			absoluteImgPath = Path.resolve(primaryDir, imgPath);
			if (!fs.existsSync(absoluteImgPath)) {
				absoluteImgPath = Path.join(imgBaseDir, Path.basename(imgPath));
			}
		}
		const webviewUri = helpPanel!.webview.asWebviewUri(vscode.Uri.file(absoluteImgPath));
		return `src="${webviewUri}"`;
	});

	// Rewrite relative .htm links so clicking them navigates within the webview.
	// CHM-extracted HTML may use unquoted href values (e.g. <a href=foo.htm>),
	// so we match both quoted and unquoted forms.
	html = html.replace(/<a\s+href=(?:"([^"]*\.htm[^"]*)"|([^\s>"]*\.htm[^\s>]*))/gi, (_m, quoted: string, unquoted: string) => {
		const href = quoted || unquoted;
		// Resolve the href relative to the page's directory to get a
		// path relative to docBasePath (the extracted help root)
		const abs = Path.resolve(primaryDir, href);
		if (!abs.startsWith(docBasePath + Path.sep)) { return _m; }
		const resolved = Path.relative(docBasePath, abs).replace(/\\/g, '/');
		return `<a href="#" data-doc-path="${resolved}"`;
	});

	// Remove syntax highlighting from code blocks (keep gray block background)
	html = html.replace(/\.highlight\s+\.\w+\{[^}]*\}/g, '');
	html = html.replace('</head>', `<style>
.highlight,.highlight pre,.highlight code,.highlight span{color:#000 !important;font-style:normal !important;font-weight:normal !important;background:transparent !important;background-color:transparent !important}
.highlight{background:#f8f8f8 !important}
code{background:transparent !important;background-color:transparent !important}
</style></head>`);

	// Inject back button and script to handle doc link navigation
	const hasHistory = helpHistory.length > 0;
	const backButton = hasHistory
		? `<div style="position:sticky;top:0;z-index:999;padding:4px 8px;background:var(--vscode-editor-background,#fff);border-bottom:1px solid #d9d9d9"><button id="apl-back-btn" style="cursor:pointer;padding:2px 8px;font-size:13px" title="Go back">Back</button></div>`
		: '';
	const navScript = `<script>
(function(){
	const vscode = acquireVsCodeApi();
	document.addEventListener('click', function(e) {
		const a = e.target.closest('a[data-doc-path]');
		if (a) {
			e.preventDefault();
			vscode.postMessage({ type: 'navigate', path: a.getAttribute('data-doc-path') });
		}
	});
	const backBtn = document.getElementById('apl-back-btn');
	if (backBtn) {
		backBtn.addEventListener('click', function() {
			vscode.postMessage({ type: 'back' });
		});
	}
})();
</script>`;
	html = html.replace(/<body>/i, '<body>' + backButton);
	html = html.replace(/<\/body>/i, navScript + '</body>');

	helpPanel.webview.html = html;
}

/**
 * Handle the F1 help command. Called from activateAplDebug.
 */
export async function handleHelp(
	editor: vscode.TextEditor,
	globalStoragePath: string,
): Promise<void> {
	const { document, selection } = editor;

	// If not an APL file, forward to the default command palette
	if (document.languageId !== 'apl') {
		vscode.commands.executeCommand('workbench.action.showCommands');
		return;
	}

	const position = selection.active;

	// Try local documentation lookup
	const docPages = getDocPages(document, position);

	if (docPages) {
		const basePath = await ensureExtracted(globalStoragePath);
		if (basePath) {
			await showDocPage(basePath, docPages);
		}
		return;
	}

	// Fall back to RIDE-based help if a debug session is active
	const ds = vscode.debug.activeDebugSession;
	if (ds) {
		const textline = document.lineAt(position.line);
		ds.customRequest('help', { line: textline.text, pos: position.character });
		return;
	}

	vscode.window.showInformationMessage('No documentation found for the symbol under the cursor.');
}

/**
 * Handle help from the REPL webview (line text + cursor position).
 */
export async function handleHelpForLine(
	line: string,
	pos: number,
	globalStoragePath: string,
): Promise<void> {
	const docPages = getDocPagesFromLine(line, pos);

	if (docPages) {
		const basePath = await ensureExtracted(globalStoragePath);
		if (basePath) {
			await showDocPage(basePath, docPages);
		}
		return;
	}

	// Fall back to RIDE-based help if a debug session is active
	const ds = vscode.debug.activeDebugSession;
	if (ds) {
		ds.customRequest('help', { line, pos });
		return;
	}

	vscode.window.showInformationMessage('No documentation found for the symbol under the cursor.');
}

/**
 * Look up documentation from raw line text and cursor position.
 */
function getDocPagesFromLine(line: string, col: number): string[] | undefined {
	// Try the character before the cursor first (left wins), then at cursor
	const charsToTry = col > 0 ? [col - 1, col] : [col];
	const LRG = 'language-reference-guide/';

	for (const c of charsToTry) {
		if (c < 0 || c >= line.length) { continue; }
		const ch = line[c];

		if (ch === ':' || /[a-zA-Z]/.test(ch)) {
			const csPage = tryControlStructure(line, c);
			if (csPage) { return [csPage]; }
		}

		if (ch === ')' || /[a-zA-Z]/.test(ch)) {
			const cmdPage = trySystemCommand(line, c);
			if (cmdPage) { return [LRG + cmdPage]; }
		}

		if (ch === '⎕' || /[a-zA-Z]/.test(ch)) {
			const sysFn = trySystemFunction(line, c);
			if (sysFn) { return [LRG + sysFn]; }
		}

		const page = GLYPH_DOC_MAP[ch];
		if (page) {
			return [LRG + page];
		}
	}

	return undefined;
}
