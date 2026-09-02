const ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	apos: "'",
	nbsp: " ",
};

function decodeEntities(input: string): string {
	return input.replace(/&(#39|amp|lt|gt|quot|apos|nbsp|#(\d+));/g, (whole, name, code) => {
		if (code) return String.fromCharCode(Number(code));
		return ENTITY_MAP[name] ?? whole;
	});
}

/**
 * Flatten HTML into a "|||"-separated text string, mirroring
 * BeautifulSoup's `soup.get_text(separator="|||")` closely enough for the
 * regex-based extraction below: each tag boundary becomes a separator, and
 * `<script>`/`<style>` contents are dropped (unlike BeautifulSoup, which
 * would otherwise leak raw JS/CSS into the text).
 */
export function htmlToText(html: string): string {
	const withoutScripts = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "|||")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "|||");
	const withSeparators = withoutScripts.replace(/<[^>]+>/g, "|||");
	const decoded = decodeEntities(withSeparators);
	return decoded
		.split("|||")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part.length > 0)
		.join("|||");
}

export interface JsonLdProduct {
	"@type"?: string;
	name?: string;
	description?: string;
	image?: string | string[];
	offers?: {
		price?: number | string;
		availability?: string;
	};
	[key: string]: unknown;
}

/** Extract all `<script type="application/ld+json">` blocks and parse them as JSON. */
export function extractJsonLd(html: string): JsonLdProduct[] {
	const results: JsonLdProduct[] = [];
	const scriptRegex =
		/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
	while ((match = scriptRegex.exec(html)) !== null) {
		if (!match[1]) continue;
		try {
			const parsed = JSON.parse(match[1]);
			if (Array.isArray(parsed)) {
				results.push(...parsed);
			} else {
				results.push(parsed);
			}
		} catch {
			// Ignore malformed JSON-LD blocks.
		}
	}
	return results;
}
