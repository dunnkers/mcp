/**
 * Best-effort policy check for Sieve scripts. This is a guard against
 * accidents and prompt injection, not a security boundary: the server's own
 * validation is the authority on syntax, and a script created elsewhere (e.g.
 * in a mail client) is only checked when it is activated through this server.
 */

/** Blank out comments, quoted strings and `text:` blocks so only code remains. */
export function stripSieve(source: string): string {
	let out = "";
	let i = 0;
	const n = source.length;
	while (i < n) {
		const c = source[i] as string;
		if (c === "#") {
			while (i < n && source[i] !== "\n") i++;
		} else if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? n : end + 2;
			out += " ";
		} else if (c === '"') {
			i++;
			while (i < n && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
			i++;
			out += " ";
		} else if (/^text:/i.test(source.slice(i, i + 5)) && !/\w/.test(source[i - 1] ?? " ")) {
			const header = /^text:[ \t]*(?:#[^\n]*)?\r?\n/i.exec(source.slice(i));
			if (header) {
				const body = source.slice(i + header[0].length);
				const end = /(^|\n)\.\r?(\n|$)/.exec(body);
				i += header[0].length + (end ? end.index + end[0].length : body.length);
				out += " ";
			} else {
				out += c;
				i++;
			}
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

/** Extension names listed in `require` commands. */
function requiredExtensions(source: string): string[] {
	const names: string[] = [];
	for (const match of source.matchAll(/\brequire\s*(\[[^\]]*\]|"[^"]*")\s*;/gi)) {
		for (const name of (match[1] as string).matchAll(/"([^"]*)"/g)) {
			names.push((name[1] as string).toLowerCase());
		}
	}
	return names;
}

/** Which of `denied` the script uses, as a command/test token or a required extension. */
export function findDeniedActions(source: string, denied: string[]): string[] {
	if (denied.length === 0) return [];
	const tokens = new Set(stripSieve(source).toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
	const extensions = requiredExtensions(source);
	return denied.filter(
		(name) =>
			tokens.has(name) ||
			extensions.some(
				(ext) =>
					ext === name ||
					ext === `e${name}` ||
					ext.startsWith(`${name}-`) ||
					ext.startsWith(`e${name}-`),
			),
	);
}
