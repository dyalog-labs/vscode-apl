// APL REPL Webview JavaScript

(function() {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	// DOM elements
	const outputEl = document.getElementById('output');
	const inputEl = document.getElementById('input');
	const statusEl = document.getElementById('status');
	const clearBtn = document.getElementById('clear-btn');
	const interruptBtn = document.getElementById('interrupt-btn');

	// State
	let inputHistory = [];
	let historyIndex = -1;
	let currentInput = '';
	let autocompleteToken = 0;
	let autocompleteDropdown = null;
	let autocompleteIndex = -1;
	let autocompleteOptions = [];

	// Initialize
	function init() {
		// Request history from extension
		vscode.postMessage({ command: 'requestHistory' });

		// Set up event listeners
		inputEl.addEventListener('keydown', handleKeyDown);
		inputEl.addEventListener('input', handleInput);
		clearBtn.addEventListener('click', handleClear);
		interruptBtn.addEventListener('click', handleInterrupt);

		// Set up clickable error locations
		outputEl.addEventListener('click', function(e) {
			var location = e.target.closest('.apl-location');
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

	// Handle keyboard input
	function handleKeyDown(e) {
		// When autocomplete dropdown is open, intercept navigation keys
		if (autocompleteDropdown) {
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
				navigateAutocomplete(-1);
				return;
			} else if (e.key === 'ArrowDown') {
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

		if (e.key === 'Enter' && e.ctrlKey) {
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
		var result = html.replace(
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

	function showAutocomplete(options) {
		dismissAutocomplete();
		if (!options || options.length === 0) return;

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
		// Find the start of the current token (word boundary)
		let start = pos;
		while (start > 0 && /[A-Za-z0-9_⍺⍵∆⍙⎕#.]/.test(value[start - 1])) {
			start--;
		}
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
		if (pos < 0 || pos >= text.length) return '';
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
				showAutocomplete(message.options);
				break;

			case 'valuetip':
				showValueTip(message.expression, message.value);
				break;

			case 'showHtml':
				appendOutput('system', 'HTML output: ' + (message.title || 'Untitled'));
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
