/**
 * Standard Dyalog APL backtick keyboard mapping.
 * Used by both the REPL webview (via postMessage) and the editor-side backtick handler.
 */

export type AplCategory =
	| 'arithmetic'
	| 'comparison'
	| 'logical'
	| 'structural'
	| 'selection'
	| 'assignment'
	| 'flow'
	| 'io'
	| 'other';

export interface AplKeyEntry {
	/** The key to press after backtick (e.g., 'a', '1', '!') */
	key: string;
	/** The resulting APL character */
	char: string;
	/** Human-readable name */
	name: string;
	/** Category for language bar grouping */
	category: AplCategory;
}

// Mapping sourced from Dyalog RIDE src/kbds.js (en_US layout)
// https://github.com/Dyalog/ride/blob/master/src/kbds.js
export const APL_KEYS: AplKeyEntry[] = [
	// Number row (unshifted)
	{ key: '`', char: '\u22C4', name: 'Diamond', category: 'other' },           // ⋄
	{ key: '1', char: '\u00A8', name: 'Diaeresis', category: 'other' },         // ¨
	{ key: '2', char: '\u00AF', name: 'High Minus', category: 'arithmetic' },   // ¯
	{ key: '3', char: '<',      name: 'Less Than', category: 'comparison' },
	{ key: '4', char: '\u2264', name: 'Less Or Equal', category: 'comparison' },// ≤
	{ key: '5', char: '=',      name: 'Equal', category: 'comparison' },
	{ key: '6', char: '\u2265', name: 'Greater Or Equal', category: 'comparison' }, // ≥
	{ key: '7', char: '>',      name: 'Greater Than', category: 'comparison' },
	{ key: '8', char: '\u2260', name: 'Not Equal', category: 'comparison' },    // ≠
	{ key: '9', char: '\u2228', name: 'Or', category: 'logical' },              // ∨
	{ key: '0', char: '\u2227', name: 'And', category: 'logical' },             // ∧
	{ key: '-', char: '\u00D7', name: 'Times', category: 'arithmetic' },        // ×
	{ key: '=', char: '\u00F7', name: 'Divide', category: 'arithmetic' },       // ÷

	// Number row (shifted)
	{ key: '~', char: '\u233A', name: 'Quad Diamond', category: 'other' },      // ⌺
	{ key: '!', char: '\u2336', name: 'I-Beam', category: 'io' },               // ⌶
	{ key: '@', char: '\u236B', name: 'Del Tilde', category: 'other' },         // ⍫
	{ key: '#', char: '\u2352', name: 'Grade Down', category: 'selection' },     // ⍒
	{ key: '$', char: '\u234B', name: 'Grade Up', category: 'selection' },       // ⍋
	{ key: '%', char: '\u233D', name: 'Circle Stile', category: 'structural' }, // ⌽
	{ key: '^', char: '\u2349', name: 'Transpose', category: 'structural' },    // ⍉
	{ key: '&', char: '\u2296', name: 'Circle Bar', category: 'structural' },   // ⊖
	{ key: '*', char: '\u235F', name: 'Circle Star', category: 'arithmetic' },  // ⍟
	{ key: '(', char: '\u2371', name: 'Nor', category: 'logical' },             // ⍱
	{ key: ')', char: '\u2372', name: 'Nand', category: 'logical' },            // ⍲
	{ key: '_', char: '!',      name: 'Factorial', category: 'arithmetic' },
	{ key: '+', char: '\u2339', name: 'Domino', category: 'arithmetic' },       // ⌹

	// QWERTY row (unshifted)
	{ key: 'q', char: '?',      name: 'Roll', category: 'arithmetic' },
	{ key: 'w', char: '\u2375', name: 'Omega', category: 'other' },             // ⍵
	{ key: 'e', char: '\u220A', name: 'Epsilon', category: 'structural' },      // ∊
	{ key: 'r', char: '\u2374', name: 'Rho', category: 'structural' },          // ⍴
	{ key: 't', char: '~',      name: 'Tilde', category: 'logical' },           // ~
	{ key: 'y', char: '\u2191', name: 'Up Arrow', category: 'selection' },      // ↑
	{ key: 'u', char: '\u2193', name: 'Down Arrow', category: 'selection' },    // ↓
	{ key: 'i', char: '\u2373', name: 'Iota', category: 'structural' },         // ⍳
	{ key: 'o', char: '\u25CB', name: 'Circle', category: 'arithmetic' },       // ○
	{ key: 'p', char: '*',      name: 'Star', category: 'arithmetic' },         // *
	{ key: '[', char: '\u2190', name: 'Left Arrow', category: 'assignment' },   // ←
	{ key: ']', char: '\u2192', name: 'Right Arrow', category: 'flow' },        // →
	{ key: '\\', char: '\u22A2', name: 'Right Tack', category: 'structural' },  // ⊢

	// QWERTY row (shifted)
	{ key: 'E', char: '\u2377', name: 'Epsilon Underbar', category: 'structural' }, // ⍷
	{ key: 'T', char: '\u2368', name: 'Tilde Diaeresis', category: 'other' },   // ⍨
	{ key: 'I', char: '\u2378', name: 'Iota Underbar', category: 'structural' },// ⍸
	{ key: 'O', char: '\u2365', name: 'Circle Diaeresis', category: 'arithmetic' }, // ⍥
	{ key: 'P', char: '\u2363', name: 'Star Diaeresis', category: 'other' },    // ⍣
	{ key: '{', char: '\u235E', name: 'Quote Quad', category: 'io' },           // ⍞
	{ key: '}', char: '\u236C', name: 'Zilde', category: 'other' },             // ⍬
	{ key: '|', char: '\u22A3', name: 'Left Tack', category: 'structural' },    // ⊣

	// Home row (unshifted)
	{ key: 'a', char: '\u237A', name: 'Alpha', category: 'other' },             // ⍺
	{ key: 's', char: '\u2308', name: 'Ceiling', category: 'arithmetic' },      // ⌈
	{ key: 'd', char: '\u230A', name: 'Floor', category: 'arithmetic' },        // ⌊
	{ key: 'f', char: '_',      name: 'Underscore', category: 'other' },
	{ key: 'g', char: '\u2207', name: 'Del', category: 'other' },               // ∇
	{ key: 'h', char: '\u2206', name: 'Delta', category: 'other' },             // ∆
	{ key: 'j', char: '\u2218', name: 'Jot', category: 'other' },               // ∘
	{ key: 'k', char: '\'',     name: 'Quote', category: 'other' },
	{ key: 'l', char: '\u2395', name: 'Quad', category: 'io' },                 // ⎕
	{ key: ';', char: '\u234E', name: 'Execute', category: 'io' },              // ⍎
	{ key: '\'', char: '\u2355', name: 'Format', category: 'io' },              // ⍕

	// Home row (shifted)
	{ key: 'F', char: '\u235B', name: 'Semicolon Underbar', category: 'other' },// ⍟
	{ key: 'J', char: '\u2364', name: 'Jot Diaeresis', category: 'other' },     // ⍤
	{ key: 'K', char: '\u2338', name: 'Quad Equal', category: 'io' },           // ⌸
	{ key: 'L', char: '\u2337', name: 'Squish Quad', category: 'io' },          // ⌷
	{ key: ':', char: '\u2261', name: 'Identical To', category: 'comparison' }, // ≡
	{ key: '"', char: '\u2262', name: 'Not Identical To', category: 'comparison' }, // ≢

	// Bottom row (unshifted)
	{ key: 'z', char: '\u2282', name: 'Left Shoe', category: 'structural' },    // ⊂
	{ key: 'x', char: '\u2283', name: 'Right Shoe', category: 'structural' },   // ⊃
	{ key: 'c', char: '\u2229', name: 'Intersection', category: 'structural' }, // ∩
	{ key: 'v', char: '\u222A', name: 'Union', category: 'structural' },        // ∪
	{ key: 'b', char: '\u22A5', name: 'Up Tack', category: 'arithmetic' },      // ⊥
	{ key: 'n', char: '\u22A4', name: 'Down Tack', category: 'arithmetic' },    // ⊤
	{ key: 'm', char: '|',      name: 'Stile', category: 'arithmetic' },
	{ key: ',', char: '\u235D', name: 'Lamp', category: 'other' },              // ⍝
	{ key: '.', char: '\u2340', name: 'Backslash Bar', category: 'structural' },// ⍀
	{ key: '/', char: '\u233F', name: 'Slash Bar', category: 'structural' },    // ⌿

	// Bottom row (shifted)
	{ key: 'Z', char: '\u2286', name: 'Left Shoe Underbar', category: 'structural' }, // ⊆
	{ key: '<', char: '\u236A', name: 'Comma Bar', category: 'structural' },    // ⍪
	{ key: '>', char: '\u2359', name: 'Delta Underbar', category: 'other' },    // ⍙
	{ key: '?', char: '\u2360', name: 'Quad Colon', category: 'io' },           // ⍠
];

/** Build a lookup map: key → AplKeyEntry for quick lookup */
export function buildAplKeyMap(): Map<string, AplKeyEntry> {
	const map = new Map<string, AplKeyEntry>();
	for (const entry of APL_KEYS) {
		map.set(entry.key, entry);
	}
	return map;
}

/** Serializable form for sending to webview via postMessage */
export function getAplKeysForWebview(): Array<{ key: string; char: string; name: string; category: string }> {
	return APL_KEYS.map(e => ({
		key: e.key,
		char: e.char,
		name: e.name,
		category: e.category
	}));
}
