import * as assert from 'assert';
import { isValidNamespace, injectCSP } from '../../utils';

suite('isValidNamespace', () => {

	test('accepts root namespace #', () => {
		assert.ok(isValidNamespace('#'));
	});

	test('accepts ⎕SE', () => {
		assert.ok(isValidNamespace('⎕SE'));
	});

	test('accepts dotted namespace #.MyNS', () => {
		assert.ok(isValidNamespace('#.MyNS'));
	});

	test('accepts dotted namespace ⎕SE.Utils', () => {
		assert.ok(isValidNamespace('⎕SE.Utils'));
	});

	test('accepts simple name', () => {
		assert.ok(isValidNamespace('MyNS'));
	});

	test('accepts nested namespace', () => {
		assert.ok(isValidNamespace('#.A.B.C'));
	});

	test('rejects single quote injection', () => {
		assert.ok(!isValidNamespace("foo'⋄⎕OFF"));
	});

	test('rejects semicolon injection', () => {
		assert.ok(!isValidNamespace("foo;⎕OFF"));
	});

	test('rejects space injection', () => {
		assert.ok(!isValidNamespace("foo ⎕OFF"));
	});

	test('rejects empty string', () => {
		assert.ok(!isValidNamespace(''));
	});

	test('rejects APL diamond separator', () => {
		assert.ok(!isValidNamespace('foo⋄⎕OFF'));
	});

	test('rejects parentheses', () => {
		assert.ok(!isValidNamespace('(⎕OFF)'));
	});
});

suite('injectCSP', () => {

	test('injects into existing <head>', () => {
		const html = '<html><head><title>Test</title></head><body>Hello</body></html>';
		const result = injectCSP(html);
		assert.ok(result.includes('Content-Security-Policy'));
		assert.ok(result.includes("default-src 'none'"));
		assert.ok(result.includes('<title>Test</title>'));
	});

	test('wraps bare HTML without <head>', () => {
		const html = '<p>Hello World</p>';
		const result = injectCSP(html);
		assert.ok(result.includes('Content-Security-Policy'));
		assert.ok(result.includes('<head>'));
		assert.ok(result.includes('<body><p>Hello World</p></body>'));
	});

	test('blocks network access', () => {
		const result = injectCSP('<head></head>');
		assert.ok(result.includes("default-src 'none'"));
	});

	test('allows inline scripts for interpreter content', () => {
		const result = injectCSP('<head></head>');
		assert.ok(result.includes("script-src 'unsafe-inline'"));
	});

	test('allows data: images', () => {
		const result = injectCSP('<head></head>');
		assert.ok(result.includes('img-src data:'));
	});

	test('CSP tag appears before other head content', () => {
		const html = '<html><head><script>alert(1)</script></head></html>';
		const result = injectCSP(html);
		const cspIdx = result.indexOf('Content-Security-Policy');
		const scriptIdx = result.indexOf('<script>');
		assert.ok(cspIdx < scriptIdx, 'CSP should appear before script');
	});
});
