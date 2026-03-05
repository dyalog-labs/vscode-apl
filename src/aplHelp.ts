import * as vscode from 'vscode';
import * as fs from 'fs';
import * as Path from 'path';
import * as cp from 'child_process';

/**
 * Mapping from APL glyphs to their documentation page paths
 * (relative to language-reference-guide/).
 *
 * A string value means a single page; an array means multiple pages
 * (monadic + dyadic) that will be combined into one view.
 */
const GLYPH_DOC_MAP: Record<string, string | string[]> = {
	// Arithmetic
	'+': ['primitive-functions/conjugate.htm', 'primitive-functions/plus.htm'],
	'-': ['primitive-functions/negate.htm', 'primitive-functions/minus.htm'],
	'×': ['primitive-functions/direction.htm', 'primitive-functions/times.htm'],
	'÷': ['primitive-functions/reciprocal.htm', 'primitive-functions/divide.htm'],
	'|': ['primitive-functions/magnitude.htm', 'primitive-functions/residue.htm'],
	'*': ['primitive-functions/exponential.htm', 'primitive-functions/power.htm'],
	'⍟': ['primitive-functions/natural-logarithm.htm', 'primitive-functions/logarithm.htm'],
	'○': ['primitive-functions/pi-times.htm', 'primitive-functions/circular-functions.htm'],
	'⌈': ['primitive-functions/ceiling.htm', 'primitive-functions/maximum.htm'],
	'⌊': ['primitive-functions/floor.htm', 'primitive-functions/minimum.htm'],
	'!': ['primitive-functions/factorial.htm', 'primitive-functions/binomial.htm'],
	'?': ['primitive-functions/roll.htm', 'primitive-functions/deal.htm'],
	'⌹': ['primitive-functions/matrix-inverse.htm', 'primitive-functions/matrix-divide.htm'],

	// Comparison
	'<': 'primitive-functions/less-than.htm',
	'≤': 'primitive-functions/less-than-or-equal-to.htm',
	'=': 'primitive-functions/equal-to.htm',
	'≥': 'primitive-functions/greater-than-or-equal-to.htm',
	'>': 'primitive-functions/greater-than.htm',
	'≠': ['primitive-functions/unique-mask.htm', 'primitive-functions/not-equal-to.htm'],
	'≡': ['primitive-functions/depth.htm', 'primitive-functions/match.htm'],
	'≢': ['primitive-functions/tally.htm', 'primitive-functions/not-match.htm'],

	// Logical
	'∧': 'primitive-functions/lowest-common-multiple-and.htm',
	'∨': 'primitive-functions/greatest-common-divisor-or.htm',
	'⍲': 'primitive-functions/nand.htm',
	'⍱': 'primitive-functions/nor.htm',
	'~': ['primitive-functions/not.htm', 'primitive-functions/without.htm'],

	// Structural
	'⍴': ['primitive-functions/shape.htm', 'primitive-functions/reshape.htm'],
	',': ['primitive-functions/ravel/index.htm', 'primitive-functions/catenate-laminate.htm'],
	'⍪': ['primitive-functions/table.htm', 'primitive-functions/catenate-first.htm'],
	'⌽': ['primitive-functions/reverse.htm', 'primitive-functions/rotate.htm'],
	'⊖': ['primitive-functions/reverse-first.htm', 'primitive-functions/rotate-first.htm'],
	'⍉': ['primitive-functions/transpose.htm', 'primitive-functions/dyadic-transpose.htm'],

	// Selection
	'↑': ['primitive-functions/mix.htm', 'primitive-functions/take/index.htm'],
	'↓': ['primitive-functions/split.htm', 'primitive-functions/drop/index.htm'],
	'⊂': ['primitive-functions/enclose/index.htm', 'primitive-functions/partitioned-enclose.htm'],
	'⊆': ['primitive-functions/nest.htm', 'primitive-functions/partition.htm'],
	'⊃': ['primitive-functions/first.htm', 'primitive-functions/pick.htm'],
	'⍳': ['primitive-functions/index-generator.htm', 'primitive-functions/index-of.htm'],
	'⍸': ['primitive-functions/where.htm', 'primitive-functions/interval-index.htm'],
	'∊': ['primitive-functions/enlist.htm', 'primitive-functions/membership.htm'],
	'⍷': 'primitive-functions/find.htm',
	'⍋': ['primitive-functions/grade-up.htm', 'primitive-functions/dyadic-grade-up.htm'],
	'⍒': ['primitive-functions/grade-down.htm', 'primitive-functions/dyadic-grade-down.htm'],
	'⌷': ['primitive-functions/materialise.htm', 'primitive-functions/index-function/index.htm'],
	'∩': 'primitive-functions/intersection.htm',
	'∪': ['primitive-functions/unique.htm', 'primitive-functions/union.htm'],

	// Miscellaneous functions
	'⊤': 'primitive-functions/encode.htm',
	'⊥': 'primitive-functions/decode.htm',
	'⊢': 'primitive-functions/right.htm',
	'⊣': 'primitive-functions/left.htm',
	'⍎': ['primitive-functions/execute.htm', 'primitive-functions/dyadic-execute.htm'],
	'⍕': ['primitive-functions/format.htm', 'primitive-functions/format-by-specification.htm'],

	// Operators
	'/': ['primitive-functions/replicate.htm', 'primitive-operators/reduce/index.htm'],
	'\\': ['primitive-functions/expand.htm', 'primitive-operators/scan.htm'],
	'⌿': ['primitive-functions/replicate-first.htm', 'primitive-operators/reduce-first/index.htm'],
	'⍀': ['primitive-functions/expand-first.htm', 'primitive-operators/scan-first.htm'],
	'¨': 'primitive-operators/each/each-with-monadic-operand.htm',
	'⍨': 'primitive-operators/commute.htm',
	'⍤': 'primitive-operators/rank.htm',
	'⍣': 'primitive-operators/power.htm',
	'⍥': 'primitive-operators/over.htm',
	'∘': 'primitive-operators/beside.htm',
	'⍛': 'primitive-operators/behind.htm',
	'⌸': 'primitive-operators/key.htm',
	'⌺': 'primitive-operators/stencil.htm',
	'⍠': 'primitive-operators/variant.htm',
	'⌶': 'primitive-operators/i-beam/index.htm',
	'@': 'primitive-operators/at.htm',
	'&': 'primitive-operators/spawn.htm',

	// Other syntax
	'←': 'other-syntax/assignment/index.htm',
	'→': 'other-syntax/branch.htm',
	'⋄': 'glyphs.htm',
	'⍝': 'glyphs.htm',
	'⍬': 'other-syntax/zilde.htm',
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

let helpPanel: vscode.WebviewPanel | undefined;
let extractedPath: string | undefined;

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

	for (const c of charsToTry) {
		if (c < 0 || c >= line.length) { continue; }
		const ch = line[c];

		// System function: ⎕Name — scan to find full ⎕Name around position
		if (ch === '⎕' || /[a-zA-Z]/.test(ch)) {
			const sysFn = trySystemFunction(line, c);
			if (sysFn) { return [sysFn]; }
		}

		// Glyph lookup
		const page = GLYPH_DOC_MAP[ch];
		if (page) { return Array.isArray(page) ? page : [page]; }
	}

	return undefined;
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
async function showDocPage(docBasePath: string, relativePaths: string[]): Promise<void> {
	const lrgDir = Path.join(docBasePath, 'language-reference-guide');
	const imgBaseDir = Path.join(lrgDir, 'img');

	// Read all pages, skip missing ones
	const pages: { html: string; dir: string; title: string }[] = [];
	for (const rel of relativePaths) {
		const fullPath = Path.join(lrgDir, rel);
		if (!fs.existsSync(fullPath)) { continue; }
		const raw = fs.readFileSync(fullPath, 'utf-8');
		const titleMatch = raw.match(/<title>(.*?)<\/title>/i);
		pages.push({ html: raw, dir: Path.dirname(fullPath), title: titleMatch?.[1] || '' });
	}
	if (pages.length === 0) {
		vscode.window.showWarningMessage(`Documentation page not found: ${relativePaths[0]}`);
		return;
	}

	const title = `APL: ${pages.map(p => p.title).join(' / ')}`;

	// Create or reuse panel
	if (helpPanel) {
		helpPanel.title = title;
		helpPanel.reveal(vscode.ViewColumn.Beside, true);
	} else {
		helpPanel = vscode.window.createWebviewPanel(
			'aplDocumentation',
			title,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: false,
				localResourceRoots: [vscode.Uri.file(docBasePath)],
			}
		);
		helpPanel.onDidDispose(() => { helpPanel = undefined; });
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

	// Remove links that point to other doc pages to avoid broken navigation
	html = html.replace(/<a\s+href="([^"]*\.htm[^"]*)"/gi, '<a href="#"');

	// Remove syntax highlighting from code blocks (keep gray block background)
	html = html.replace(/\.highlight\s+\.\w+\{[^}]*\}/g, '');
	html = html.replace('</head>', `<style>
.highlight,.highlight pre,.highlight code,.highlight span{color:#000 !important;font-style:normal !important;font-weight:normal !important;background:transparent !important;background-color:transparent !important}
.highlight{background:#f8f8f8 !important}
code{background:transparent !important;background-color:transparent !important}
</style></head>`);

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

	for (const c of charsToTry) {
		if (c < 0 || c >= line.length) { continue; }
		const ch = line[c];

		if (ch === '⎕' || /[a-zA-Z]/.test(ch)) {
			const sysFn = trySystemFunction(line, c);
			if (sysFn) { return [sysFn]; }
		}

		const page = GLYPH_DOC_MAP[ch];
		if (page) { return Array.isArray(page) ? page : [page]; }
	}

	return undefined;
}
