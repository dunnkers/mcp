import {
	CONDITION,
	HTML_HEADERS,
	L1_CATEGORIES,
	L2_CATEGORIES,
	LISTING_URL,
	REQUEST_HEADERS,
	SEARCH_URL,
	SELLER_URL,
	SORT_BY,
	SORT_ORDER,
} from "./constants.js";
import { formatListing, formatListingCompact, extractSpecsFromDescription } from "./format.js";
import { extractJsonLd, htmlToText } from "./html.js";
import type { ApiError, RawFacet, RawSearchResponse, RawSellerProfile } from "./types.js";

async function getJson<T>(url: string, params?: URLSearchParams): Promise<T> {
	const fullUrl = params ? `${url}?${params.toString()}` : url;
	const response = await fetch(fullUrl, { headers: REQUEST_HEADERS });
	if (!response.ok) {
		throw new Error(`Request failed with status ${response.status}`);
	}
	return (await response.json()) as T;
}

export interface SearchListingsParams {
	query?: string;
	category?: string;
	subcategory?: string;
	zipCode?: string;
	distanceKm?: number;
	priceFrom?: number;
	priceTo?: number;
	condition?: string;
	sellerType?: string;
	sortBy?: string;
	sortOrder?: string;
	limit?: number;
	offset?: number;
	offeredSinceDays?: number;
	attributeIds?: number[];
	extractSpecs?: boolean;
	compact?: boolean;
}

const CONDITION_MAP: Record<string, number> = {
	new: CONDITION.NEW,
	as_good_as_new: CONDITION.AS_GOOD_AS_NEW,
	used: CONDITION.USED,
	refurbished: CONDITION.REFURBISHED,
	not_working: CONDITION.NOT_WORKING,
};

/** Search for listings on Marktplaats.nl. */
export async function searchListings(
	params: SearchListingsParams,
): Promise<Record<string, unknown> | ApiError> {
	const {
		query = "",
		category,
		subcategory,
		zipCode = "",
		distanceKm = 1000,
		priceFrom,
		priceTo,
		condition,
		sellerType,
		sortBy = "optimized",
		sortOrder = "asc",
		limit = 10,
		offset = 0,
		offeredSinceDays,
		attributeIds,
		extractSpecs = false,
		compact = false,
	} = params;

	if (!query && !category && !subcategory) {
		return { error: "Please provide a search query or category" };
	}

	const search = new URLSearchParams();
	search.set("limit", String(Math.min(Math.max(1, limit), 100)));
	search.set("offset", String(offset));
	search.set("query", query);
	search.set("searchInTitleAndDescription", "true");
	search.set("viewOptions", "list-view");
	search.set("distanceMeters", String(distanceKm * 1000));
	search.set("postcode", zipCode);

	const sortByKey = sortBy.toUpperCase();
	search.set(
		"sortBy",
		sortByKey in SORT_BY ? SORT_BY[sortByKey as keyof typeof SORT_BY] : SORT_BY.OPTIMIZED,
	);
	const sortOrderKey = sortOrder.toUpperCase();
	search.set(
		"sortOrder",
		sortOrderKey in SORT_ORDER
			? SORT_ORDER[sortOrderKey as keyof typeof SORT_ORDER]
			: SORT_ORDER.ASC,
	);

	if (subcategory) {
		const subcat = L2_CATEGORIES[subcategory.toLowerCase()];
		if (!subcat) {
			return {
				error: `Unknown subcategory: ${subcategory}. Use list_categories to see available categories.`,
			};
		}
		search.set("l2CategoryId", String(subcat.id));
		search.set("l1CategoryId", String(subcat.parent));
	} else if (category) {
		const catId = L1_CATEGORIES[category.toLowerCase()];
		if (catId === undefined) {
			return {
				error: `Unknown category: ${category}. Use list_categories to see available categories.`,
			};
		}
		search.set("l1CategoryId", String(catId));
	}

	if (priceFrom !== undefined || priceTo !== undefined) {
		const from = priceFrom !== undefined ? String(priceFrom * 100) : "null";
		const to = priceTo !== undefined ? String(priceTo * 100) : "null";
		search.append("attributeRanges[]", `PriceCents:${from}:${to}`);
	}

	const attributeList: number[] = [];
	const conditionValue = condition ? CONDITION_MAP[condition.toLowerCase()] : undefined;
	if (conditionValue !== undefined) {
		attributeList.push(conditionValue);
	}
	if (attributeIds) {
		attributeList.push(...attributeIds);
	}
	for (const id of attributeList) {
		search.append("attributesById[]", String(id));
	}

	if (offeredSinceDays) {
		const since = Date.now() - offeredSinceDays * 24 * 60 * 60 * 1000;
		search.append("attributesByKey[]", `offeredSince:${since}`);
	}

	let data: RawSearchResponse;
	try {
		data = await getJson<RawSearchResponse>(SEARCH_URL, search);
	} catch (e) {
		return { error: `Request failed: ${(e as Error).message}` };
	}

	let listings = compact
		? (data.listings ?? []).map(formatListingCompact)
		: (data.listings ?? []).map((listing) => formatListing(listing, extractSpecs));

	if (sellerType) {
		const sellerTypeLower = sellerType.toLowerCase();
		if (compact) {
			if (["business", "zakelijk"].includes(sellerTypeLower)) {
				listings = (listings as ReturnType<typeof formatListingCompact>[]).filter(
					(l) => l.seller === "B",
				);
			} else if (["private", "particulier"].includes(sellerTypeLower)) {
				listings = (listings as ReturnType<typeof formatListingCompact>[]).filter(
					(l) => l.seller === "P",
				);
			}
		} else if (["business", "zakelijk"].includes(sellerTypeLower)) {
			listings = (listings as ReturnType<typeof formatListing>[]).filter(
				(l) => l.seller.type === "business",
			);
		} else if (["private", "particulier"].includes(sellerTypeLower)) {
			listings = (listings as ReturnType<typeof formatListing>[]).filter(
				(l) => l.seller.type === "private",
			);
		}
	}

	const totalCount = data.totalResultCount ?? 0;

	if (compact) {
		const result: Record<string, unknown> = { total: totalCount, listings };
		if (offset + listings.length < totalCount) {
			result.next = offset + listings.length;
		}
		return result;
	}

	const result: Record<string, unknown> = {
		total_count: totalCount,
		returned_count: listings.length,
		offset,
		listings,
	};
	if (!zipCode) {
		result.note =
			"Provide zipCode parameter (e.g., '1016LV') to enable distance filtering and see distances";
	}
	if (offset + listings.length < totalCount) {
		result.next_offset = offset + listings.length;
	}
	return result;
}

const DESCRIPTION_STOP_HEADINGS = new Set([
	"Kenmerken",
	"Locatie",
	"Bied nu",
	"Bericht",
	"Vragen aan verkoper",
]);

// \b-anchored on the label so e.g. "Merk" doesn't false-match inside the
// "Kenmerken" section heading that always precedes these attributes.
const ATTRIBUTE_PATTERNS: [RegExp, string][] = [
	[/\bConditie\b\s*(\w+)/i, "conditie"],
	[/\bMerk\b\s*(\w+)/i, "merk"],
	[/\bFramehoogte\b\s*([\d\s\-totcm]+)/i, "framehoogte"],
	[/\bSchermgrootte\b\s*([\d\s\-inch]+)/i, "schermgrootte"],
	[/\bWerkgeheugen\b[^\d]*(\d+\s*GB)/i, "werkgeheugen"],
	[/\bProcessorsnelheid\b[^\d]*([\d,.]+\s*GHz)/i, "processorsnelheid"],
	[/\bType opslag\b\s*(\w+)/i, "type_opslag"],
];

/** Get full details of a specific listing including complete description and images. */
export async function getListingDetails(
	rawListingId: string,
): Promise<Record<string, unknown> | ApiError> {
	if (!rawListingId) {
		return { error: "Please provide a listing_id" };
	}

	const listingId = rawListingId.startsWith("m") ? rawListingId : `m${rawListingId}`;

	let response: Response;
	try {
		response = await fetch(`${LISTING_URL}/${listingId}`, { headers: HTML_HEADERS });
	} catch (e) {
		return { error: `Request failed: ${(e as Error).message}` };
	}

	const html = await response.text();
	if (response.status === 404 || html.toLowerCase().includes("niet gevonden")) {
		return { error: "Listing not found" };
	}

	if (!response.ok) {
		return { error: `Request failed with status ${response.status}` };
	}

	const result: Record<string, unknown> = { id: listingId, url: response.url };

	for (const item of extractJsonLd(html)) {
		if (item["@type"] === "Product") {
			result.title = item.name;
			result.description_short = item.description;

			const offers = item.offers ?? {};
			const price = Number(offers.price ?? 0);
			result.price = `€ ${price}`;
			result.price_cents = Math.round(price * 100);
			result.availability = String(offers.availability ?? "").includes("InStock")
				? "In Stock"
				: "Unknown";

			const images = Array.isArray(item.image) ? item.image : item.image ? [item.image] : [];
			result.images = images.map((img) => (img.startsWith("http") ? img : `https:${img}`));
			result.image_count = images.length;
		}
	}

	const text = htmlToText(html);
	if (text.includes("Beschrijving")) {
		const parts = text.split("|||");
		let inDescription = false;
		const descriptionLines: string[] = [];

		for (const rawPart of parts) {
			const part = rawPart.trim();
			if (!part) continue;
			if (part === "Beschrijving") {
				inDescription = true;
				continue;
			}
			if (inDescription) {
				if (DESCRIPTION_STOP_HEADINGS.has(part)) break;
				descriptionLines.push(part);
			}
		}

		if (descriptionLines.length > 0) {
			result.description_full = descriptionLines.join(" ");
			const specs = extractSpecsFromDescription(
				result.description_full as string,
				(result.title as string) ?? "",
			);
			if (Object.keys(specs).length > 0) {
				result.specs = specs;
			}
		}
	}

	const attributes: Record<string, string> = {};
	for (const [pattern, key] of ATTRIBUTE_PATTERNS) {
		const match = text.match(pattern);
		if (match?.[1]) {
			attributes[key] = match[1].trim();
		}
	}
	if (Object.keys(attributes).length > 0) {
		result.attributes = attributes;
	}

	const viewsMatch = text.match(/([\d.]+)x bekeken/);
	const savedMatch = text.match(/(\d+)x bewaard/);
	const dateMatch = text.match(/Sinds (\d+ \w+ '\d+)/);

	const stats: Record<string, string | number> = {};
	if (viewsMatch?.[1]) stats.views = viewsMatch[1];
	if (savedMatch?.[1]) stats.saved = Number(savedMatch[1]);
	if (dateMatch?.[1]) stats.online_since = dateMatch[1];
	if (Object.keys(stats).length > 0) {
		result.statistics = stats;
	}

	const locationMatch = text.match(
		/Locatie[^\w]*(\w[\w\s]+?)(?:[\d.]+x bekeken|Toon|Op de kaart)/,
	);
	if (locationMatch?.[1]) {
		result.location = locationMatch[1].trim();
	}

	return result;
}

/** Get detailed information about a seller including ratings and verification status. */
export async function getSellerInfo(
	sellerId: number,
): Promise<Record<string, unknown> | ApiError> {
	if (!sellerId) {
		return { error: "Please provide a seller_id" };
	}

	let data: RawSellerProfile;
	try {
		data = await getJson<RawSellerProfile>(`${SELLER_URL}/${sellerId}`);
	} catch (e) {
		return { error: `Request failed: ${(e as Error).message}` };
	}

	return {
		id: data.sellerId,
		name: data.sellerName,
		is_verified: data.isVerified ?? false,
		average_score: data.averageScore,
		number_of_reviews: data.numberOfReviews ?? 0,
		verification: {
			bank_account: data.bankAccountVerified ?? false,
			identification: data.identificationVerified ?? false,
			phone_number: data.phoneNumberVerified ?? false,
		},
	};
}

/** List all available main categories and common subcategories on Marktplaats. */
export function listCategories(): Record<string, unknown> {
	const mainCategories = Object.entries(L1_CATEGORIES)
		.map(([name, id]) => ({ name: titleCase(name), id }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const subcategories = Object.entries(L2_CATEGORIES)
		.map(([name, info]) => ({ name: titleCase(name), id: info.id, parent_id: info.parent }))
		.sort((a, b) => a.name.localeCompare(b.name));

	return {
		main_categories: mainCategories,
		subcategories,
		note: "Use category names (not IDs) in search_listings. For more subcategories, search with a main category first.",
	};
}

function titleCase(input: string): string {
	return input.replace(/\b\w/g, (c) => c.toUpperCase());
}

const FILTER_SKIP_KEYS = new Set(["PriceCents", "RelevantCategories", "offeredSince"]);

/** Get available filter options for a specific category (RAM, brand, screen size, etc). */
export async function getCategoryFilters(
	category?: string,
	subcategory?: string,
): Promise<Record<string, unknown> | ApiError> {
	if (!category && !subcategory) {
		return { error: "Please provide a category or subcategory" };
	}

	const search = new URLSearchParams({ limit: "1", query: "" });

	if (subcategory) {
		const subcat = L2_CATEGORIES[subcategory.toLowerCase()];
		if (!subcat) {
			return { error: `Unknown subcategory: ${subcategory}` };
		}
		search.set("l2CategoryId", String(subcat.id));
		search.set("l1CategoryId", String(subcat.parent));
	} else if (category) {
		const catId = L1_CATEGORIES[category.toLowerCase()];
		if (catId === undefined) {
			return { error: `Unknown category: ${category}` };
		}
		search.set("l1CategoryId", String(catId));
	}

	let data: RawSearchResponse;
	try {
		data = await getJson<RawSearchResponse>(SEARCH_URL, search);
	} catch (e) {
		return { error: `Request failed: ${(e as Error).message}` };
	}

	const filters: Record<string, unknown> = {};
	for (const facet of data.facets ?? ([] as RawFacet[])) {
		const key = facet.key;
		const label = facet.label ?? key;
		if (!key || !label || FILTER_SKIP_KEYS.has(key)) continue;

		if (facet.attributeGroup && facet.attributeGroup.length > 0) {
			const options = facet.attributeGroup
				.filter((attr) => attr.attributeValueId !== undefined)
				.map((attr) => ({
					name: attr.attributeValueLabel ?? attr.attributeValueKey,
					id: attr.attributeValueId,
					count: attr.histogramCount ?? 0,
				}));
			if (options.length > 0) {
				filters[label] = options;
			}
		}
	}

	return {
		category: subcategory ?? category,
		filters,
		usage: "Use the 'id' values in the 'attribute_ids' parameter of search_listings",
	};
}
