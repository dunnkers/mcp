import { describe, expect, it } from "vitest";
import { extractJsonLd, htmlToText } from "../src/html.js";

describe("htmlToText", () => {
	it("flattens tags into '|||'-separated text parts", () => {
		const html = "<div><h2>Beschrijving</h2><p>Een mooie fiets.</p><h2>Kenmerken</h2></div>";
		expect(htmlToText(html)).toBe("Beschrijving|||Een mooie fiets.|||Kenmerken");
	});

	it("drops script and style content instead of leaking it as text", () => {
		const html = "<p>Titel</p><script>var x = 1;</script><style>.a{color:red}</style><p>Einde</p>";
		expect(htmlToText(html)).toBe("Titel|||Einde");
	});

	it("decodes common HTML entities", () => {
		const html = "<p>Prijs &amp; korting &euro;</p>";
		expect(htmlToText(html)).toContain("Prijs & korting");
	});
});

describe("extractJsonLd", () => {
	it("parses a single JSON-LD script block", () => {
		const html = `
			<script type="application/ld+json">
				{"@type": "Product", "name": "Racefiets", "offers": {"price": 250, "availability": "https://schema.org/InStock"}}
			</script>
		`;
		const items = extractJsonLd(html);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ "@type": "Product", name: "Racefiets" });
	});

	it("skips malformed JSON-LD blocks without throwing", () => {
		const html = `<script type="application/ld+json">{not valid json}</script>`;
		expect(extractJsonLd(html)).toEqual([]);
	});

	it("flattens a JSON-LD array into individual items", () => {
		const html = `<script type="application/ld+json">[{"@type": "Product"}, {"@type": "BreadcrumbList"}]</script>`;
		const items = extractJsonLd(html);
		expect(items).toHaveLength(2);
		expect(items.map((i) => i["@type"])).toEqual(["Product", "BreadcrumbList"]);
	});
});
