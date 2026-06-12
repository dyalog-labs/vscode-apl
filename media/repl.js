// APL REPL Webview JavaScript

(function() {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	// DOM elements
	const outputEl = document.getElementById('output');
	const inputEl = document.getElementById('input');
	const statusEl = document.getElementById('status');
	const connectBtn = document.getElementById('connect-btn');
	const clearBtn = document.getElementById('clear-btn');
	const interruptBtn = document.getElementById('interrupt-btn');
	const tabListEl = document.getElementById('tab-list');
	const newTabBtn = document.getElementById('new-tab-btn');

	// State
	let inputHistory = [];
	let historyIndex = -1;
	let currentInput = '';
	let autocompleteToken = 0;
	let autocompleteDropdown = null;
	let autocompleteIndex = -1;
	let autocompleteOptions = [];
	let autocompleteSkip = 0;

	// Backtick prefix mode state
	let prefixMode = false;
	let aplKeyMap = null;       // Map: key -> {char, name, category}
	let aplKeyEntries = null;   // Array of all entries (for language bar)

	// Reverse search state (Ctrl+R)
	let reverseSearchActive = false;
	let reverseSearchQuery = '';
	let reverseSearchMatchIndex = -1;  // index into inputHistory (from end)
	let reverseSearchOverlay = null;

	// Initialize
	function init() {
		// Notify extension that the webview is ready
		vscode.postMessage({ command: 'ready' });

		// Set up event listeners
		inputEl.addEventListener('keydown', handleKeyDown);
		inputEl.addEventListener('input', handleInput);
		// If the input loses focus mid reverse-search, the key handler can no
		// longer fire and the (invisible, pointer-events:none) input would be
		// stuck. Restore it on blur so focus can always be recovered.
		inputEl.addEventListener('blur', function() {
			if (reverseSearchActive) {
				exitReverseSearch(false, false);
			}
		});
		connectBtn.addEventListener('click', handleConnect);
		clearBtn.addEventListener('click', handleClear);
		interruptBtn.addEventListener('click', handleInterrupt);
		newTabBtn.addEventListener('click', handleNewTab);

		// Set up clickable error locations
		outputEl.addEventListener('click', function(e) {
			const location = e.target.closest('.apl-location');
			if (location) {
				vscode.postMessage({
					command: 'navigateToError',
					name: location.getAttribute('data-name'),
					line: parseInt(location.getAttribute('data-line'), 10)
				});
			}
		});

		// Set up value tips on output
		setupValueTips();

		// Focus input
		inputEl.focus();
	}

	// --- Tab bar ---

	function handleNewTab() {
		vscode.postMessage({ command: 'newTab' });
	}

	let dragState = null; // { tabId, startX, el }

	function renderTabs(tabs) {
		tabListEl.innerHTML = '';
		tabs.forEach(function(tab) {
			const tabEl = document.createElement('div');
			tabEl.className = 'tab' + (tab.isActive ? ' active' : '');
			tabEl.setAttribute('data-tab-id', tab.replId);
			tabEl.draggable = true;

			const labelEl = document.createElement('span');
			labelEl.className = 'tab-label';
			labelEl.textContent = tab.label;
			tabEl.appendChild(labelEl);

			// Click on the tab div itself to switch (label has pointer-events:none in CSS)
			tabEl.addEventListener('click', function() {
				vscode.postMessage({ command: 'switchTab', tabId: tab.replId });
			});

			// --- Drag-and-drop reordering ---
			tabEl.addEventListener('dragstart', function(e) {
				dragState = { tabId: tab.replId };
				tabEl.classList.add('dragging');
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', tab.replId);
			});
			tabEl.addEventListener('dragend', function() {
				tabEl.classList.remove('dragging');
				dragState = null;
				// Remove all drop indicators
				tabListEl.querySelectorAll('.tab').forEach(function(t) {
					t.classList.remove('drop-before', 'drop-after');
				});
			});
			tabEl.addEventListener('dragover', function(e) {
				if (!dragState || dragState.tabId === tab.replId) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
				const rect = tabEl.getBoundingClientRect();
				const midX = rect.left + rect.width / 2;
				tabEl.classList.toggle('drop-before', e.clientX < midX);
				tabEl.classList.toggle('drop-after', e.clientX >= midX);
			});
			tabEl.addEventListener('dragleave', function() {
				tabEl.classList.remove('drop-before', 'drop-after');
			});
			tabEl.addEventListener('drop', function(e) {
				e.preventDefault();
				tabEl.classList.remove('drop-before', 'drop-after');
				if (!dragState || dragState.tabId === tab.replId) return;
				const rect = tabEl.getBoundingClientRect();
				const midX = rect.left + rect.width / 2;
				const before = e.clientX < midX;
				vscode.postMessage({
					command: 'reorderTab',
					tabId: dragState.tabId,
					targetId: tab.replId,
					before: before
				});
			});

			// Close button (only show if more than one tab)
			if (tabs.length > 1) {
				const closeEl = document.createElement('span');
				closeEl.className = 'tab-close';
				closeEl.textContent = '\u00d7';
				closeEl.title = 'Close';
				closeEl.addEventListener('click', function(e) {
					e.stopPropagation();
					vscode.postMessage({ command: 'closeTab', tabId: tab.replId });
				});
				tabEl.appendChild(closeEl);
			}

			tabListEl.appendChild(tabEl);
		});
	}

	// Handle keyboard input
	function handleKeyDown(e) {
		// --- Backtick prefix mode handling (works in both normal and reverse search) ---
		if (prefixMode) {
			// Ignore modifier-only keys (Shift, Ctrl, Alt, Meta) — wait for the actual character
			if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
				return;
			}

			e.preventDefault();
			e.stopPropagation();

			if (e.key === 'Escape') {
				setPrefixMode(false);
				return;
			}

			if (e.key === ' ') {
				// Backtick + space -> literal backtick
				insertAtCursor('`');
				setPrefixMode(false);
				return;
			}

			// Look up the APL character (includes ` -> ⋄)
			if (aplKeyMap) {
				const entry = aplKeyMap.get(e.key);
				if (entry) {
					insertAtCursor(entry.char);
				}
			}
			setPrefixMode(false);
			return;
		}

		// Detect backtick press to enter prefix mode
		if (e.key === '`' && !e.ctrlKey && !e.altKey && !e.metaKey && aplKeyMap) {
			e.preventDefault();
			e.stopPropagation();
			setPrefixMode(true);
			return;
		}

		// --- Reverse search mode handling ---
		if (reverseSearchActive) {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				exitReverseSearch(false);
				return;
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				exitReverseSearch(true);
				return;
			} else if (e.key === 'r' && e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();
				cycleReverseSearch();
				return;
			} else if (e.key === 'Backspace') {
				e.preventDefault();
				e.stopPropagation();
				if (reverseSearchQuery.length > 0) {
					reverseSearchQuery = reverseSearchQuery.slice(0, -1);
					updateReverseSearch();
				}
				return;
			} else if (e.key.length === 1) {
				// Accept any printable character, including APL glyphs via AltGr/APL key
				e.preventDefault();
				e.stopPropagation();
				reverseSearchQuery += e.key;
				updateReverseSearch();
				return;
			} else if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta'
				|| e.key === 'AltGraph') {
				return;
			} else {
				exitReverseSearch(true);
				return;
			}
		}

		// Ctrl+R: enter reverse search
		if (e.key === 'r' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation();
			enterReverseSearch();
			return;
		}

		// When autocomplete dropdown is open, intercept navigation keys
		if (autocompleteDropdown) {
			if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
				e.preventDefault();
				e.stopPropagation();
				navigateAutocomplete(-1);
				return;
			} else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
				e.preventDefault();
				e.stopPropagation();
				navigateAutocomplete(1);
				return;
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				acceptAutocomplete();
				return;
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				dismissAutocomplete();
				return;
			}
		}

		if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey) {
			e.preventDefault();
			e.stopPropagation();
			goToDefinition();
		} else if (e.key === 'Enter' && e.ctrlKey) {
			e.preventDefault();
			e.stopPropagation();
			executeWithTrace();
		} else if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation(); // Prevent bubbling to VS Code debug keybindings
			executeInput();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			navigateHistory(1);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			navigateHistory(-1);
		} else if (e.key === 'Tab') {
			e.preventDefault();
			e.stopPropagation();
			requestAutocomplete();
		} else if (e.key === 'Escape') {
			e.stopPropagation();
			dismissAutocomplete();
		} else if (e.key === 'l' && e.ctrlKey) {
			e.preventDefault();
			e.stopPropagation();
			handleClear();
		} else if (e.key === 'F1') {
			e.preventDefault();
			e.stopPropagation();
			const pos = inputEl.selectionStart || 0;
			vscode.postMessage({ command: 'help', line: inputEl.value, pos });
		} else if (e.key === 'F5' || e.key === 'F10' || e.key === 'F11') {
			// Let debug keys pass through to VS Code
			return;
		} else {
			// Stop other keys from triggering VS Code commands while typing
			e.stopPropagation();
		}
	}

	// Auto-resize textarea
	function handleInput() {
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';

		// Reset history navigation when typing
		if (historyIndex !== -1) {
			historyIndex = -1;
		}

		// Dismiss autocomplete on input change
		dismissAutocomplete();
	}

	// Execute the current input
	function executeInput() {
		const code = inputEl.value.trim();
		if (!code) return;

		// Add to history
		if (inputHistory[inputHistory.length - 1] !== code) {
			inputHistory.push(code);
		}
		historyIndex = -1;
		currentInput = '';

		// Send to extension
		vscode.postMessage({
			command: 'execute',
			code: code
		});

		// Clear input
		inputEl.value = '';
		inputEl.style.height = 'auto';
	}

	// Execute with tracing enabled (Ctrl+Enter)
	function executeWithTrace() {
		const code = inputEl.value.trim();
		if (!code) return;

		// Add to history
		if (inputHistory[inputHistory.length - 1] !== code) {
			inputHistory.push(code);
		}
		historyIndex = -1;
		currentInput = '';

		// Send to extension with trace flag
		vscode.postMessage({
			command: 'executeWithTrace',
			code: code
		});

		// Clear input
		inputEl.value = '';
		inputEl.style.height = 'auto';
	}

	// Navigate to the definition of the name at cursor (Shift+Enter)
	function goToDefinition() {
		const pos = inputEl.selectionStart;
		const name = getWordAt(inputEl.value, pos);
		if (name) {
			vscode.postMessage({ command: 'goToDefinition', name: name });
		}
	}

	// Navigate through input history
	function navigateHistory(direction) {
		if (inputHistory.length === 0) return;

		// Save current input when starting to navigate
		if (historyIndex === -1) {
			currentInput = inputEl.value;
		}

		const newIndex = historyIndex + direction;

		if (newIndex < -1) {
			return;
		} else if (newIndex === -1) {
			// Return to current input
			inputEl.value = currentInput;
			historyIndex = -1;
		} else if (newIndex < inputHistory.length) {
			historyIndex = newIndex;
			inputEl.value = inputHistory[inputHistory.length - 1 - historyIndex];
		}

		// Move cursor to end
		inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
		// Resize textarea without calling handleInput (which resets historyIndex)
		inputEl.style.height = 'auto';
		inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
	}

	// --- Reverse search (Ctrl+R) ---

	function enterReverseSearch() {
		reverseSearchActive = true;
		reverseSearchQuery = '';
		reverseSearchMatchIndex = -1;

		// Create overlay
		reverseSearchOverlay = document.createElement('div');
		reverseSearchOverlay.id = 'reverse-search';
		reverseSearchOverlay.innerHTML =
			'<span class="reverse-search-label">(reverse-i-search)</span>' +
			'<span class="reverse-search-query"></span>' +
			'<span class="reverse-search-sep">: </span>' +
			'<span class="reverse-search-match"></span>';
		document.getElementById('input-area').appendChild(reverseSearchOverlay);

		// Hide prompt; make input invisible but keep it focusable for key events
		document.getElementById('prompt').style.display = 'none';
		inputEl.style.opacity = '0';
		inputEl.style.position = 'absolute';
		inputEl.style.pointerEvents = 'none';
		inputEl.focus();
	}

	function exitReverseSearch(accept, refocus) {
		if (!reverseSearchActive) return;
		reverseSearchActive = false;
		if (refocus === undefined) refocus = true;

		// If accepting, put the matched text into the input
		if (accept && reverseSearchMatchIndex >= 0 && reverseSearchMatchIndex < inputHistory.length) {
			inputEl.value = inputHistory[reverseSearchMatchIndex];
			inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
			// Resize textarea
			inputEl.style.height = 'auto';
			inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
		}

		// Remove overlay and restore input
		if (reverseSearchOverlay) {
			reverseSearchOverlay.remove();
			reverseSearchOverlay = null;
		}
		document.getElementById('prompt').style.display = '';
		inputEl.style.opacity = '';
		inputEl.style.position = '';
		inputEl.style.pointerEvents = '';
		if (refocus) inputEl.focus();

		historyIndex = -1;
		currentInput = '';
	}

	function updateReverseSearch() {
		if (!reverseSearchOverlay) return;

		const queryEl = reverseSearchOverlay.querySelector('.reverse-search-query');
		const matchEl = reverseSearchOverlay.querySelector('.reverse-search-match');
		const labelEl = reverseSearchOverlay.querySelector('.reverse-search-label');
		queryEl.textContent = reverseSearchQuery;

		if (reverseSearchQuery === '') {
			matchEl.textContent = '';
			labelEl.textContent = '(reverse-i-search)';
			reverseSearchMatchIndex = -1;
			return;
		}

		// If we have a current match, check if it still matches the refined query;
		// otherwise search backwards from the end
		const startFrom = reverseSearchMatchIndex >= 0
			? reverseSearchMatchIndex
			: inputHistory.length - 1;

		const found = findReverseMatch(startFrom);
		if (found >= 0) {
			reverseSearchMatchIndex = found;
			matchEl.textContent = inputHistory[found];
			labelEl.textContent = '(reverse-i-search)';
		} else {
			reverseSearchMatchIndex = -1;
			matchEl.textContent = '';
			labelEl.textContent = '(failing reverse-i-search)';
		}
	}

	function cycleReverseSearch() {
		if (!reverseSearchOverlay || reverseSearchQuery === '') return;

		const matchEl = reverseSearchOverlay.querySelector('.reverse-search-match');
		const labelEl = reverseSearchOverlay.querySelector('.reverse-search-label');

		const startFrom = reverseSearchMatchIndex >= 0
			? reverseSearchMatchIndex - 1
			: inputHistory.length - 1;

		const found = findReverseMatch(startFrom);
		if (found >= 0) {
			reverseSearchMatchIndex = found;
			matchEl.textContent = inputHistory[found];
			labelEl.textContent = '(reverse-i-search)';
		} else {
			labelEl.textContent = '(failing reverse-i-search)';
		}
	}

	function findReverseMatch(startFrom) {
		const query = reverseSearchQuery.toLowerCase();
		for (let i = startFrom; i >= 0; i--) {
			if (inputHistory[i].toLowerCase().indexOf(query) !== -1) {
				return i;
			}
		}
		return -1;
	}

	// Connect to interpreter
	function handleConnect() {
		vscode.postMessage({ command: 'connect' });
	}

	// Clear output
	function handleClear() {
		outputEl.innerHTML = '';
		vscode.postMessage({ command: 'clear' });
	}

	// Interrupt execution
	function handleInterrupt() {
		vscode.postMessage({ command: 'interrupt' });
	}

	// --- Output highlighting helpers ---

	function escapeHtml(text) {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	function highlightResult(html) {
		// Highlight APL numbers (space-bounded or at line boundaries)
		// Handles: ¯ prefix, decimals, exponents (E), complex (J)
		return html.replace(
			/(^|\s)(¯?\d+\.?\d*(?:[Ee]¯?\d+)?(?:[Jj]¯?\d+\.?\d*(?:[Ee]¯?\d+)?)?)(?=\s|$)/gm,
			'$1<span class="apl-number">$2</span>'
		);
	}

	function highlightError(html) {
		// Highlight error type names (e.g., VALUE ERROR, SYNTAX ERROR)
		let result = html.replace(
			/^([A-Z][A-Z ]* ERROR.*)/gm,
			'<span class="apl-error-type">$1</span>'
		);

		// Make function[line] references clickable
		result = result.replace(
			/([A-Za-z_\u237a\u2375\u2206\u2359\u2395#][A-Za-z0-9_\u237a\u2375\u2206\u2359\u2395#.]*)\[(\d+)\]/g,
			'<a class="apl-location" data-name="$1" data-line="$2" title="Go to $1 line $2">$1[$2]</a>'
		);

		// Highlight caret indicator lines
		result = result.replace(
			/^(\s*\^+\s*)$/gm,
			'<span class="apl-caret">$1</span>'
		);

		return result;
	}

	// Append a line to output
	function appendOutput(type, text) {
		const line = document.createElement('div');
		line.className = 'output-line ' + type;

		if (type === 'error') {
			line.innerHTML = highlightError(escapeHtml(text));
		} else if (type === 'result') {
			// Error messages often arrive as 'result' via AppendSessionOutput;
			// detect and apply error highlighting when patterns match
			const escaped = escapeHtml(text);
			if (/^[A-Z][A-Z ]* ERROR/m.test(text) || /\[\d+\]/.test(text)) {
				line.innerHTML = highlightError(escaped);
			} else {
				line.innerHTML = highlightResult(escaped);
			}
		} else {
			line.textContent = text;
		}

		outputEl.appendChild(line);

		// Auto-scroll to bottom
		outputEl.scrollTop = outputEl.scrollHeight;
	}

	// Set connection status
	function setStatus(status) {
		statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
		statusEl.className = status;
		connectBtn.disabled = status !== 'disconnected';
		interruptBtn.disabled = status !== 'busy';
	}

	// Set debug mode indicator
	function setDebugMode(isDebug) {
		const debugIndicator = document.getElementById('debug-indicator');
		if (debugIndicator) {
			debugIndicator.style.display = isDebug ? 'inline' : 'none';
		}
	}

	// --- Autocomplete ---

	function requestAutocomplete() {
		const line = inputEl.value;
		const pos = inputEl.selectionStart;
		if (!line.trim()) return;
		autocompleteToken++;
		vscode.postMessage({
			command: 'autocomplete',
			line: line,
			pos: pos,
			token: autocompleteToken
		});
	}

	function showAutocomplete(options, skip) {
		dismissAutocomplete();
		if (!options || options.length === 0) return;

		autocompleteSkip = skip;

		// If single option, insert it directly
		if (options.length === 1) {
			insertCompletion(options[0]);
			return;
		}

		// Find common prefix and insert it
		const prefix = commonPrefix(options);
		if (prefix.length > 0) {
			insertCompletion(prefix);
		}

		// Store options for keyboard navigation
		autocompleteOptions = options;
		autocompleteIndex = -1;

		// Show dropdown for remaining choices
		autocompleteDropdown = document.createElement('div');
		autocompleteDropdown.className = 'autocomplete-dropdown';
		options.forEach(function(opt) {
			const item = document.createElement('div');
			item.className = 'autocomplete-item';
			item.textContent = opt;
			item.addEventListener('mousedown', function(e) {
				e.preventDefault();
				insertCompletion(opt);
				dismissAutocomplete();
			});
			autocompleteDropdown.appendChild(item);
		});
		document.getElementById('input-area').appendChild(autocompleteDropdown);
	}

	function navigateAutocomplete(direction) {
		if (!autocompleteDropdown || autocompleteOptions.length === 0) return;
		const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');

		// Remove previous highlight
		if (autocompleteIndex >= 0 && autocompleteIndex < items.length) {
			items[autocompleteIndex].classList.remove('selected');
		}

		// Update index with wrapping
		autocompleteIndex += direction;
		if (autocompleteIndex < 0) autocompleteIndex = items.length - 1;
		if (autocompleteIndex >= items.length) autocompleteIndex = 0;

		// Highlight new item and scroll into view
		items[autocompleteIndex].classList.add('selected');
		items[autocompleteIndex].scrollIntoView({ block: 'nearest' });
	}

	function acceptAutocomplete() {
		if (autocompleteIndex >= 0 && autocompleteIndex < autocompleteOptions.length) {
			insertCompletion(autocompleteOptions[autocompleteIndex]);
		}
		dismissAutocomplete();
	}

	function insertCompletion(text) {
		const pos = inputEl.selectionStart;
		const value = inputEl.value;
		// Use skip from the interpreter to determine how many characters to replace
		const start = pos - (autocompleteSkip || 0);
		inputEl.value = value.slice(0, start) + text + value.slice(pos);
		const newPos = start + text.length;
		inputEl.selectionStart = inputEl.selectionEnd = newPos;
		handleInput();
	}

	function dismissAutocomplete() {
		if (autocompleteDropdown) {
			autocompleteDropdown.remove();
			autocompleteDropdown = null;
		}
		autocompleteIndex = -1;
		autocompleteOptions = [];
	}

	// --- Backtick prefix mode helpers ---

	function insertAtCursor(text) {
		if (reverseSearchActive) {
			reverseSearchQuery += text;
			updateReverseSearch();
			return;
		}
		const start = inputEl.selectionStart;
		const end = inputEl.selectionEnd;
		const value = inputEl.value;
		inputEl.value = value.slice(0, start) + text + value.slice(end);
		const newPos = start + text.length;
		inputEl.selectionStart = inputEl.selectionEnd = newPos;
		handleInput();
	}

	function setPrefixMode(active) {
		prefixMode = active;
		const inputArea = document.getElementById('input-area');
		if (active) {
			inputArea.classList.add('prefix-mode');
		} else {
			inputArea.classList.remove('prefix-mode');
		}
	}

	// --- Language bar ---

	function renderLanguageBar() {
		const existing = document.getElementById('language-bar');
		if (existing) existing.remove();

		if (!aplKeyEntries || aplKeyEntries.length === 0) return;

		const bar = document.createElement('div');
		bar.id = 'language-bar';

		// Toggle button
		const toggle = document.createElement('button');
		toggle.id = 'langbar-toggle';
		toggle.textContent = 'APL';
		toggle.title = 'Toggle APL character bar';
		toggle.addEventListener('click', function() {
			const content = document.getElementById('langbar-content');
			const isHidden = content.style.display === 'none';
			content.style.display = isHidden ? 'flex' : 'none';
			toggle.classList.toggle('collapsed', !isHidden);
			vscode.setState(Object.assign(vscode.getState() || {}, { languageBarOpen: isHidden }));
		});
		bar.appendChild(toggle);

		// Character grid
		const content = document.createElement('div');
		content.id = 'langbar-content';

		// Characters to hide from bar
		const hideFromBar = { '\u236B': true, '\u2359': true }; // ⍫ Del Tilde, ⍙ Delta Underbar

		// Extra characters to add at the end (useful APL chars available on keyboard)
		const extras = [
			{ char: '\u22C4', name: 'Diamond', key: '`' },
			{ char: '+', name: 'Plus', key: null },
			{ char: '@', name: 'At', key: null },
			{ char: '/', name: 'Slash', key: null },
			{ char: '\\', name: 'Backslash', key: null },
			{ char: ',', name: 'Comma', key: null },
			{ char: '.', name: 'Dot', key: null },
			{ char: '&', name: 'Ampersand', key: null },
		];

		// Collect unique characters (avoid duplicates from shift variants)
		const seen = {};
		const categoryOrder = ['arithmetic','comparison','logical','structural',
			'selection','assignment','flow','io','other'];
		const categories = {};

		aplKeyEntries.forEach(function(entry) {
			if (entry.key === '`') return;
			if (seen[entry.char]) return;
			if (hideFromBar[entry.char]) return;
			seen[entry.char] = true;
			if (!categories[entry.category]) categories[entry.category] = [];
			categories[entry.category].push(entry);
		});

		categoryOrder.forEach(function(cat) {
			const entries = categories[cat];
			if (!entries || entries.length === 0) return;

			entries.forEach(function(entry) {
				const btn = document.createElement('button');
				btn.className = 'langbar-char';
				btn.textContent = entry.char;
				btn.title = entry.name + ' (`' + entry.key + ')';
				btn.addEventListener('click', function() {
					insertAtCursor(entry.char);
					inputEl.focus();
				});
				content.appendChild(btn);
			});
		});

		// Append extra characters
		extras.forEach(function(extra) {
			if (seen[extra.char]) return;
			const btn = document.createElement('button');
			btn.className = 'langbar-char';
			btn.textContent = extra.char;
			btn.title = extra.name + (extra.key ? ' (`' + extra.key + ')' : '');
			btn.addEventListener('click', function() {
				insertAtCursor(extra.char);
				inputEl.focus();
			});
			content.appendChild(btn);
		});

		// Restore collapsed state
		const state = vscode.getState();
		if (state && state.languageBarOpen === false) {
			content.style.display = 'none';
			toggle.classList.add('collapsed');
		} else {
			content.style.display = 'flex';
		}

		bar.appendChild(content);

		// Insert before the input-area
		const inputArea = document.getElementById('input-area');
		inputArea.parentNode.insertBefore(bar, inputArea);
	}

	function commonPrefix(arr) {
		if (arr.length === 0) return '';
		let prefix = arr[0];
		for (let i = 1; i < arr.length; i++) {
			while (arr[i].indexOf(prefix) !== 0) {
				prefix = prefix.slice(0, -1);
				if (!prefix) return '';
			}
		}
		return prefix;
	}

	// --- Value Tips (Hover on output) ---

	let tipEl = null;
	let tipTimeout = null;

	function setupValueTips() {
		outputEl.addEventListener('mouseover', function(e) {
			const target = e.target;
			const outputLine = target.closest ? target.closest('.output-line') : null;
			if (!outputLine) return;
			clearTimeout(tipTimeout);
			tipTimeout = setTimeout(function() {
				// Get word under mouse from text content
				const text = outputLine.textContent || '';
				const rect = outputLine.getBoundingClientRect();
				const x = e.clientX - rect.left;
				// Approximate character position (monospace)
				const charWidth = rect.width / (text.length || 1);
				const charPos = Math.floor(x / charWidth);
				const word = getWordAt(text, charPos);
				if (word && /^[A-Za-z_⍺⍵∆⍙⎕#][A-Za-z0-9_⍺⍵∆⍙⎕#.]*$/.test(word)) {
					vscode.postMessage({ command: 'valuetip', expression: word });
				}
			}, 500);
		});

		outputEl.addEventListener('mouseout', function() {
			clearTimeout(tipTimeout);
			dismissTip();
		});
	}

	function getWordAt(text, pos) {
		if (pos < 0 || pos > text.length) return '';
		// When cursor is at the right border of a word, step back into it
		if (pos >= text.length || !/[A-Za-z0-9_⍺⍵∆⍙⎕#.]/.test(text[pos])) {
			if (pos > 0 && /[A-Za-z0-9_⍺⍵∆⍙⎕#.]/.test(text[pos - 1])) {
				pos--;
			} else {
				return '';
			}
		}
		let start = pos;
		let end = pos;
		while (start > 0 && /[A-Za-z0-9_⍺⍵∆⍙⎕#.]/.test(text[start - 1])) start--;
		while (end < text.length && /[A-Za-z0-9_⍺⍵∆⍙⎕#.]/.test(text[end])) end++;
		return text.slice(start, end);
	}

	function showValueTip(expression, value) {
		dismissTip();
		tipEl = document.createElement('div');
		tipEl.className = 'value-tip';
		tipEl.textContent = expression + ' → ' + value;
		document.getElementById('repl-container').appendChild(tipEl);
	}

	function dismissTip() {
		if (tipEl) {
			tipEl.remove();
			tipEl = null;
		}
	}

	// Handle messages from extension
	window.addEventListener('message', event => {
		const message = event.data;

		switch (message.command) {
			case 'appendOutput':
				appendOutput(message.type, message.text);
				break;

			case 'setHistory':
				// Restore output history
				outputEl.innerHTML = '';
				if (message.history) {
					message.history.forEach(item => {
						appendOutput(item.type, item.text);
					});
				}
				// Restore input history
				if (message.inputHistory) {
					inputHistory = message.inputHistory;
				}
				break;

			case 'clear':
				outputEl.innerHTML = '';
				break;

			case 'setStatus':
				setStatus(message.status);
				break;

			case 'focus':
				inputEl.focus();
				break;

			case 'setDebugMode':
				setDebugMode(message.isDebug);
				break;

			case 'autocomplete':
				if (message.token === autocompleteToken) {
					showAutocomplete(message.options, message.skip);
				}
				break;

			case 'valuetip':
				showValueTip(message.expression, message.value);
				break;

			case 'showHtml':
				appendOutput('system', 'HTML output: ' + (message.title || 'Untitled'));
				break;

			case 'setTabs':
				renderTabs(message.tabs);
				break;

			case 'setAplKeys':
				aplKeyEntries = message.keys;
				aplKeyMap = new Map();
				if (message.backtickEnabled !== false) {
					aplKeyEntries.forEach(function(entry) {
						aplKeyMap.set(entry.key, entry);
					});
				} else {
					aplKeyMap = null;
				}
				if (message.languageBarEnabled !== false) {
					renderLanguageBar();
				}
				break;
		}
	});

	// Initialize when DOM is ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
