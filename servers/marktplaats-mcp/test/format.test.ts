import { describe, expect, it } from "vitest";
import {
	detectSellerType,
	extractSpecsFromDescription,
	formatConditionShort,
	formatDateShort,
	formatListing,
	formatListingCompact,
	parsePriceType,
} from "../src/format.js";
import type { RawListing } from "../src/types.js";

describe("parsePriceType", () => {
	it("formats a fixed price with comma thousands separator", () => {
		expect(parsePriceType("FIXED", 123456)).toBe("€ 1,234.56");
	});

	it("formats a plain fixed price", () => {
		expect(parsePriceType("FIXED", 1250)).toBe("€ 12.50");
	});

	it("maps known non-fixed price types to Dutch labels", () => {
		expect(parsePriceType("BID", 0)).toBe("Bieden");
		expect(parsePriceType("FREE", 0)).toBe("Gratis");
		expect(parsePriceType("BID_FROM", 5000)).toBe("Bieden vanaf € 50.00");
	});

	it("falls back to a euro amount for unknown price types", () => {
		expect(parsePriceType("SOMETHING_ELSE", 1000)).toBe("€ 10.00");
	});
});

describe("detectSellerType", () => {
	it("detects business sellers by trait", () => {
		expect(detectSellerType(["VERIFIED_SELLER"], "Jan")).toBe("business");
	});

	it("detects business sellers by name pattern", () => {
		expect(detectSellerType([], "ACME Webshop")).toBe("business");
		expect(detectSellerType([], "Electronics Outlet")).toBe("business");
	});

	it("defaults to private when no trait or pattern matches", () => {
		expect(detectSellerType([], "Jan de Vries")).toBe("private");
	});
});

describe("formatDateShort", () => {
	const now = new Date(2026, 8, 2); // 2026-09-02, matches session date

	it("handles relative Dutch date words", () => {
		expect(formatDateShort("Vandaag", now)).toBe("0d");
		expect(formatDateShort("Gisteren", now)).toBe("1d");
		// "Eergisteren" contains "gisteren" as a substring, so the "gisteren"
		// check (checked first, matching the original Python's check order)
		// matches before "eergisteren" is ever tested — faithfully ported.
		expect(formatDateShort("Eergisteren", now)).toBe("1d");
	});

	it("parses absolute dates into days/weeks/months ago", () => {
		expect(formatDateShort("31 aug '26", now)).toBe("2d");
		expect(formatDateShort("15 aug '26", now)).toBe("2w");
		expect(formatDateShort("1 jun '26", now)).toBe("3m");
	});

	it("returns an empty string for an empty input", () => {
		expect(formatDateShort("", now)).toBe("");
	});
});

describe("formatConditionShort", () => {
	it("maps known Dutch condition strings to single letters", () => {
		expect(formatConditionShort("Nieuw")).toBe("N");
		expect(formatConditionShort("Zo goed als nieuw")).toBe("Z");
		expect(formatConditionShort("Gebruikt")).toBe("G");
		expect(formatConditionShort("Refurbished")).toBe("R");
		expect(formatConditionShort("Defect")).toBe("D");
	});

	it("returns an empty string for unknown or missing condition", () => {
		expect(formatConditionShort(undefined)).toBe("");
		expect(formatConditionShort("Onbekend")).toBe("");
	});
});

describe("extractSpecsFromDescription", () => {
	it("extracts RAM, storage, CPU, and screen size", () => {
		const specs = extractSpecsFromDescription(
			"Mooie laptop met 16GB RAM, 512GB SSD, Intel Core i7-1165G7 en 15 inch scherm",
		);
		expect(specs).toEqual({
			ram: "16GB",
			storage: "512GB SSD",
			cpu: "I7-1165G7",
			screen: '15"',
		});
	});

	it("returns an empty object when nothing matches", () => {
		expect(extractSpecsFromDescription("Een leuke fiets in goede staat")).toEqual({});
	});
});

function makeListing(overrides: Partial<RawListing> = {}): RawListing {
	return {
		itemId: "m123",
		title: "MacBook Pro 16GB RAM 512GB SSD",
		description: "Een prima laptop met 16GB RAM en 512GB SSD, weinig gebruikt.",
		date: "Vandaag",
		priceInfo: { priceType: "FIXED", priceCents: 150000 },
		location: { cityName: "Amsterdam", distanceMeters: 2500 },
		sellerInformation: { sellerId: 42, sellerName: "Jan", isVerified: true },
		traits: [],
		pictures: [{ mediumUrl: "//images.marktplaats.nl/pic.jpg" }],
		attributes: [{ key: "condition", value: "Gebruikt" }],
		...overrides,
	};
}

describe("formatListing", () => {
	it("formats a full listing with an absolute image URL and distance", () => {
		const result = formatListing(makeListing());
		expect(result.id).toBe("m123");
		expect(result.price).toBe("€ 1,500.00");
		expect(result.image).toBe("https://images.marktplaats.nl/pic.jpg");
		expect(result.location).toEqual({ city: "Amsterdam", distance_km: 2.5 });
		expect(result.seller).toEqual({
			id: 42,
			name: "Jan",
			is_verified: true,
			type: "private",
		});
		expect(result.link).toBe("https://link.marktplaats.nl/m123");
		expect(result.specs).toBeUndefined();
	});

	it("includes specs only when requested", () => {
		const result = formatListing(makeListing(), true);
		expect(result.specs).toEqual({ ram: "16GB", storage: "512GB SSD" });
	});

	it("truncates long descriptions to 200 characters", () => {
		const longDescription = "a".repeat(250);
		const result = formatListing(makeListing({ description: longDescription }));
		expect(result.description).toBe(`${"a".repeat(200)}...`);
	});
});

describe("formatListingCompact", () => {
	it("produces a minimal shape with short codes", () => {
		const result = formatListingCompact(makeListing());
		expect(result).toEqual({
			id: "m123",
			title: "MacBook Pro 16GB RAM 512GB SSD",
			price: 1500,
			city: "Amsterdam",
			seller: "P",
			km: 2.5,
			cond: "G",
			age: "0d",
			specs: { ram: "16GB", storage: "512GB SSD" },
		});
	});

	it("represents a bid listing with the 'bid' price token", () => {
		// A BID with priceCents: 0 falls into the "free" branch (matches the
		// original Python's `elif price_type == "FREE" or price_cents == 0`),
		// so a non-zero placeholder is needed to reach the BID branch.
		const result = formatListingCompact(
			makeListing({ priceInfo: { priceType: "BID", priceCents: 100 } }),
		);
		expect(result.price).toBe("bid");
	});

	it("treats a zero-cent bid as free, matching the original price-branch order", () => {
		const result = formatListingCompact(
			makeListing({ priceInfo: { priceType: "BID", priceCents: 0 } }),
		);
		expect(result.price).toBe(0);
	});
});
