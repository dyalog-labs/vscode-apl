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

	// Initialize
	function init() {
		// Request history from extension
		vscode.postMessage({ command: 'requestHistory' });

		// Set up event listeners
		inputEl.addEventListener('keydown', handleKeyDown);
		inputEl.addEventListener('input', handleInput);
		clearBtn.addEventListener('click', handleClear);
		interruptBtn.addEventListener('click', handleInterrupt);

		// Focus input
		inputEl.focus();
	}

	// Handle keyboard input
	function handleKeyDown(e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			e.stopPropagation(); // Prevent bubbling to VS Code debug keybindings
			executeInput();
		} else if (e.key === 'ArrowUp' && inputEl.selectionStart === 0) {
			e.preventDefault();
			e.stopPropagation();
			navigateHistory(-1);
		} else if (e.key === 'ArrowDown' && inputEl.selectionStart === inputEl.value.length) {
			e.preventDefault();
			e.stopPropagation();
			navigateHistory(1);
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
		handleInput();
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

	// Append a line to output
	function appendOutput(type, text) {
		const line = document.createElement('div');
		line.className = 'output-line ' + type;
		line.textContent = text;
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
		}
	});

	// Initialize when DOM is ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
