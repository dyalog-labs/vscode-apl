import { AplSession, LinkInfoRow } from '../../aplSession';

/**
 * Seed an `AplSession`'s Link cache directly, bypassing the 5177⌶
 * round-trip. Test-only — pokes into private fields via `as unknown`.
 *
 * Use when a test needs `session.linkInfo` / `linkedFileFor()` /
 * `getLinkedFile()` populated without standing up a mock RIDE server
 * that responds to the bulk-fetch query.
 */
export function seedLinkInfo(session: AplSession, rows: LinkInfoRow[]): void {
	const internals = session as unknown as {
		_linkInfo: LinkInfoRow[];
		_linkMap: Map<string, string>;
		_linkInfoLoaded: boolean;
	};
	internals._linkInfo = rows.slice();
	internals._linkMap = new Map();
	for (const r of rows) {
		internals._linkMap.set(r.aplName, r.filePath);
		internals._linkMap.set(r.filePath, r.aplName);
	}
	internals._linkInfoLoaded = true;
}
