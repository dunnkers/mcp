import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getCategoryFilters,
	getListingDetails,
	getSellerInfo,
	listCategories,
	searchListings,
} from "../src/api.js";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("searchListings", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("rejects a search with no query or category", async () => {
		const result = await searchListings({});
		expect(result).toEqual({ error: "Please provide a search query or category" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects an unknown category before making a request", async () => {
		const result = await searchListings({ category: "not-a-real-category" });
		expect(result).toHaveProperty("error");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("builds the expected query params and formats results", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			jsonResponse({
				totalResultCount: 1,
				listings: [
					{
						itemId: "m1",
						title: "Racefiets",
						description: "Mooie racefiets",
						priceInfo: { priceType: "FIXED", priceCents: 20000 },
						location: { cityName: "Utrecht" },
						sellerInformation: { sellerId: 1, sellerName: "Jan" },
						traits: [],
						pictures: [],
					},
				],
			}),
		);

		const result = (await searchListings({
			query: "racefiets",
			subcategory: "laptops",
			priceFrom: 10,
			priceTo: 500,
			limit: 5,
		})) as Record<string, unknown>;

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(mockFetch.mock.calls[0]![0] as string);
		expect(requestedUrl.searchParams.get("query")).toBe("racefiets");
		expect(requestedUrl.searchParams.get("l2CategoryId")).toBe("339");
		expect(requestedUrl.searchParams.get("l1CategoryId")).toBe("322");
		expect(requestedUrl.searchParams.get("limit")).toBe("5");
		expect(requestedUrl.searchParams.getAll("attributeRanges[]")).toEqual([
			"PriceCents:1000:50000",
		]);

		expect(result.total_count).toBe(1);
		expect(result.returned_count).toBe(1);
		expect((result.listings as unknown[])[0]).toMatchObject({ id: "m1", price: "€ 200.00" });
	});

	it("returns compact listings and filters by seller type", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			jsonResponse({
				totalResultCount: 2,
				listings: [
					{
						itemId: "m1",
						title: "Zakelijk item",
						priceInfo: { priceType: "FIXED", priceCents: 1000 },
						location: {},
						sellerInformation: { sellerName: "ACME Webshop" },
						traits: [],
						pictures: [],
					},
					{
						itemId: "m2",
						title: "Particulier item",
						priceInfo: { priceType: "FIXED", priceCents: 1000 },
						location: {},
						sellerInformation: { sellerName: "Jan" },
						traits: [],
						pictures: [],
					},
				],
			}),
		);

		const result = (await searchListings({
			query: "iets",
			compact: true,
			sellerType: "business",
		})) as Record<string, unknown>;

		const listings = result.listings as { id: string; seller: string }[];
		expect(listings).toHaveLength(1);
		expect(listings[0]!.id).toBe("m1");
		expect(listings[0]!.seller).toBe("B");
	});

	it("surfaces network failures as an error payload instead of throwing", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockRejectedValue(new Error("network down"));

		const result = await searchListings({ query: "test" });
		expect(result).toEqual({ error: "Request failed: network down" });
	});
});

describe("getSellerInfo", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires a seller_id", async () => {
		const result = await getSellerInfo(0);
		expect(result).toEqual({ error: "Please provide a seller_id" });
	});

	it("maps the seller profile response", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			jsonResponse({
				sellerId: 42,
				sellerName: "Jan",
				isVerified: true,
				averageScore: 4.8,
				numberOfReviews: 12,
				bankAccountVerified: true,
			}),
		);

		const result = await getSellerInfo(42);
		expect(result).toEqual({
			id: 42,
			name: "Jan",
			is_verified: true,
			average_score: 4.8,
			number_of_reviews: 12,
			verification: {
				bank_account: true,
				identification: false,
				phone_number: false,
			},
		});
	});
});

describe("listCategories", () => {
	it("returns sorted main categories and subcategories", () => {
		const result = listCategories() as {
			main_categories: { name: string; id: number }[];
			subcategories: { name: string; id: number; parent_id: number }[];
		};
		expect(result.main_categories.length).toBeGreaterThan(10);
		expect(result.main_categories).toContainEqual({ name: "Boeken", id: 201 });
		expect(result.subcategories).toContainEqual({ name: "Laptops", id: 339, parent_id: 322 });
	});
});

describe("getCategoryFilters", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires a category or subcategory", async () => {
		const result = await getCategoryFilters();
		expect(result).toEqual({ error: "Please provide a category or subcategory" });
	});

	it("converts facets into a filter map, skipping noise keys", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			jsonResponse({
				facets: [
					{ key: "PriceCents", label: "Price", attributeGroup: [] },
					{
						key: "Ram",
						label: "RAM",
						attributeGroup: [
							{ attributeValueId: 1, attributeValueLabel: "8GB", histogramCount: 10 },
							{ attributeValueLabel: "no id, should be skipped" },
						],
					},
				],
			}),
		);

		const result = (await getCategoryFilters("computers en software")) as Record<
			string,
			unknown
		>;
		expect(result.filters).toEqual({
			RAM: [{ name: "8GB", id: 1, count: 10 }],
		});
	});
});

describe("getListingDetails", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("requires a listing_id", async () => {
		const result = await getListingDetails("");
		expect(result).toEqual({ error: "Please provide a listing_id" });
	});

	it("prefixes bare numeric ids with 'm'", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			new Response("<html><body>Niet gevonden</body></html>", {
				status: 404,
				headers: { "content-type": "text/html" },
			}),
		);

		await getListingDetails("2340580395");
		const requestedUrl = mockFetch.mock.calls[0]![0] as string;
		expect(requestedUrl).toBe("https://link.marktplaats.nl/m2340580395");
	});

	it("returns an error for a missing listing", async () => {
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(
			new Response("<html><body>Advertentie niet gevonden</body></html>", { status: 404 }),
		);

		const result = await getListingDetails("m999");
		expect(result).toEqual({ error: "Listing not found" });
	});

	it("parses JSON-LD, description, attributes, and statistics from a listing page", async () => {
		const html = `
			<html><body>
				<script type="application/ld+json">
					{"@type": "Product", "name": "Racefiets", "description": "Mooie fiets",
					 "image": ["//images.marktplaats.nl/a.jpg"],
					 "offers": {"price": "250", "availability": "https://schema.org/InStock"}}
				</script>
				<h2>Beschrijving</h2>
				<p>Nette racefiets, 21 gears, weinig gebruikt.</p>
				<h2>Kenmerken</h2>
				<ul>
					<li>Conditie Gebruikt</li>
					<li>Merk Batavus</li>
				</ul>
				<p>1.234x bekeken</p>
				<p>7x bewaard</p>
				<p>Sinds 3 jan '26</p>
			</body></html>
		`;
		const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
		mockFetch.mockResolvedValue(new Response(html, { status: 200 }));

		const result = (await getListingDetails("m1")) as Record<string, unknown>;

		expect(result.title).toBe("Racefiets");
		expect(result.price_cents).toBe(25000);
		expect(result.availability).toBe("In Stock");
		expect(result.images).toEqual(["https://images.marktplaats.nl/a.jpg"]);
		expect(result.description_full).toContain("Nette racefiets");
		expect(result.attributes).toEqual({ conditie: "Gebruikt", merk: "Batavus" });
		expect(result.statistics).toEqual({
			views: "1.234",
			saved: 7,
			online_since: "3 jan '26",
		});
	});
});
