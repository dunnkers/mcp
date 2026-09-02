import { BUSINESS_NAME_PATTERNS, BUSINESS_TRAITS } from "./constants.js";
import type {
	CompactListing,
	FormattedListing,
	RawListing,
	SellerType,
} from "./types.js";

const PRICE_TYPE_LABELS: Record<string, (euros: string) => string> = {
	FIXED: (euros) => `€ ${euros}`,
	BID: () => "Bieden",
	BID_FROM: (euros) => `Bieden vanaf € ${euros}`,
	FREE: () => "Gratis",
	RESERVED: () => "Gereserveerd",
	SEE_DESCRIPTION: () => "Zie omschrijving",
	TO_BE_AGREED_UPON: () => "N.o.t.k.",
	ON_REQUEST: () => "Op aanvraag",
	EXCHANGE: () => "Ruilen",
};

function formatEuros(priceCents: number): string {
	// Matches Python's f"{price_cents / 100:,.2f}": comma thousands separator,
	// period decimal point (not Dutch locale formatting).
	return (priceCents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

/** Convert price type and cents to a readable Dutch string, e.g. "€ 12,50". */
export function parsePriceType(priceType: string, priceCents: number): string {
	const euros = formatEuros(priceCents);
	const formatter = PRICE_TYPE_LABELS[priceType];
	return formatter ? formatter(euros) : `€ ${euros}`;
}

/** Detect whether a seller is a business or private individual. */
export function detectSellerType(
	traits: string[],
	sellerName = "",
): SellerType {
	if (traits.some((trait) => BUSINESS_TRAITS.has(trait))) {
		return "business";
	}

	if (sellerName) {
		const nameLower = sellerName.toLowerCase();
		if (BUSINESS_NAME_PATTERNS.some((pattern) => pattern.test(nameLower))) {
			return "business";
		}
	}

	return "private";
}

const MONTH_MAP: Record<string, number> = {
	jan: 1,
	feb: 2,
	mrt: 3,
	apr: 4,
	mei: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	okt: 10,
	nov: 11,
	dec: 12,
};

/** Convert a Marktplaats date string to a short format (e.g. "2d", "1w", "3m"). */
export function formatDateShort(dateStr: string, now: Date = new Date()): string {
	if (!dateStr) return "";

	const dateLower = dateStr.toLowerCase();
	if (dateLower.includes("vandaag")) return "0d";
	if (dateLower.includes("gisteren")) return "1d";
	if (dateLower.includes("eergisteren")) return "2d";

	const match = dateStr.match(/(\d{1,2})\s+(\w{3})\s+'?(\d{2})/);
	if (match?.[1] && match[2] && match[3]) {
		const [, day, monthStr, year] = match;
		const month = MONTH_MAP[monthStr.toLowerCase()];
		if (month) {
			const listingDate = new Date(2000 + Number(year), month - 1, Number(day));
			if (!Number.isNaN(listingDate.getTime())) {
				const daysAgo = Math.floor(
					(now.getTime() - listingDate.getTime()) / (1000 * 60 * 60 * 24),
				);
				if (daysAgo < 7) return `${daysAgo}d`;
				if (daysAgo < 30) return `${Math.floor(daysAgo / 7)}w`;
				return `${Math.floor(daysAgo / 30)}m`;
			}
		}
	}

	return dateStr;
}

/** Convert condition to a single character: N=new, Z=as good as new, G=used, R=refurbished, D=defect. */
export function formatConditionShort(condition: string | null | undefined): string {
	if (!condition) return "";

	const condLower = condition.toLowerCase();
	if (condLower.includes("nieuw") && !condLower.includes("zo goed")) return "N";
	if (condLower.includes("zo goed als nieuw")) return "Z";
	if (condLower.includes("gebruikt")) return "G";
	if (condLower.includes("refurbished")) return "R";
	if (condLower.includes("defect") || condLower.includes("niet werkend")) return "D";
	return "";
}

const RAM_PATTERNS = [
	/(\d+)\s*gb\s*ram/,
	/ram[:\s]*(\d+)\s*gb/,
	/(\d+)gb\s*geheugen/,
	/werkgeheugen[:\s]*(\d+)\s*gb/,
];

interface StoragePattern {
	regex: RegExp;
	isSsd: boolean;
	isHdd: boolean;
	isTb: boolean;
}

const STORAGE_PATTERNS: StoragePattern[] = [
	{ regex: /(\d+)\s*gb\s*ssd/, isSsd: true, isHdd: false, isTb: false },
	{ regex: /(\d+)\s*tb\s*ssd/, isSsd: true, isHdd: false, isTb: true },
	{ regex: /ssd[:\s]*(\d+)\s*gb/, isSsd: true, isHdd: false, isTb: false },
	{ regex: /(\d+)\s*gb\s*opslag/, isSsd: false, isHdd: false, isTb: false },
	{ regex: /(\d+)\s*tb\s*opslag/, isSsd: false, isHdd: false, isTb: true },
	{ regex: /(\d+)\s*gb\s*hdd/, isSsd: false, isHdd: true, isTb: false },
	{ regex: /(\d+)\s*tb\s*hdd/, isSsd: false, isHdd: true, isTb: true },
];

const CPU_PATTERNS = [
	/(i[3579][-\s]?\d{4,5}\w*)/,
	/(intel\s+core\s+i[3579])/,
	/(ryzen\s*[3579]\s*\d{4}\w*)/,
	/(m[123]\s*(pro|max)?)/,
	/(apple\s+m[123])/,
];

const SCREEN_PATTERNS = [
	/(\d{2})['"]?\s*inch/,
	/(\d{2})[,.]?\d?\s*inch/,
	/scherm[:\s]*(\d{2})/,
];

/** Extract hardware specs (RAM, storage, CPU, screen size) from a listing's title/description. */
export function extractSpecsFromDescription(
	description: string,
	title = "",
): Record<string, string> {
	const specs: Record<string, string> = {};
	const text = `${title} ${description}`.toLowerCase();

	for (const pattern of RAM_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			specs.ram = `${match[1]}GB`;
			break;
		}
	}

	for (const pattern of STORAGE_PATTERNS) {
		const match = text.match(pattern.regex);
		if (match) {
			const size = match[1];
			const storageType = pattern.isSsd ? "SSD" : pattern.isHdd ? "HDD" : "";
			const unit = pattern.isTb ? "TB" : "GB";
			specs.storage = `${size}${unit} ${storageType}`.trim();
			break;
		}
	}

	for (const pattern of CPU_PATTERNS) {
		const match = text.match(pattern);
		if (match?.[1]) {
			specs.cpu = match[1].trim().toUpperCase();
			break;
		}
	}

	for (const pattern of SCREEN_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			specs.screen = `${match[1]}"`;
			break;
		}
	}

	return specs;
}

function getConditionAttribute(listing: RawListing): string | null {
	const attr = (listing.attributes ?? []).find((a) => a.key === "condition");
	return attr?.value ?? null;
}

function firstImageUrl(listing: RawListing): string {
	const pictures = listing.pictures ?? [];
	let url = pictures[0]?.mediumUrl ?? "";
	if (url && !url.startsWith("http")) {
		url = `https:${url}`;
	}
	return url;
}

function distanceKm(listing: RawListing): number | null {
	const distanceMeters = listing.location?.distanceMeters;
	if (distanceMeters !== undefined && distanceMeters !== null && distanceMeters >= 0) {
		return Math.round((distanceMeters / 1000) * 10) / 10;
	}
	return null;
}

/** Format a raw search-result listing into a clean, full-detail object. */
export function formatListing(
	listing: RawListing,
	includeSpecs = false,
): FormattedListing {
	const priceInfo = listing.priceInfo ?? {};
	const location = listing.location ?? {};
	const seller = listing.sellerInformation ?? {};
	const traits = listing.traits ?? [];
	const sellerName = seller.sellerName ?? "";
	const description = listing.description ?? "";
	const title = listing.title ?? "";

	const result: FormattedListing = {
		id: listing.itemId,
		title,
		description: description.length > 200 ? `${description.slice(0, 200)}...` : description,
		price: parsePriceType(priceInfo.priceType ?? "", priceInfo.priceCents ?? 0),
		price_cents: priceInfo.priceCents ?? 0,
		condition: getConditionAttribute(listing),
		location: {
			city: location.cityName,
			distance_km: distanceKm(listing),
		},
		seller: {
			id: seller.sellerId,
			name: sellerName,
			is_verified: seller.isVerified ?? false,
			type: detectSellerType(traits, sellerName),
		},
		date: listing.date,
		image: firstImageUrl(listing),
		link: `https://link.marktplaats.nl/${listing.itemId}`,
	};

	if (includeSpecs) {
		const specs = extractSpecsFromDescription(description, title);
		if (Object.keys(specs).length > 0) {
			result.specs = specs;
		}
	}

	return result;
}

/** Format a raw search-result listing into a minimal, token-efficient object. */
export function formatListingCompact(listing: RawListing): CompactListing {
	const priceInfo = listing.priceInfo ?? {};
	const location = listing.location ?? {};
	const seller = listing.sellerInformation ?? {};
	const traits = listing.traits ?? [];
	const sellerName = seller.sellerName ?? "";
	const description = listing.description ?? "";
	const title = listing.title ?? "";
	const condition = getConditionAttribute(listing);

	const priceType = priceInfo.priceType ?? "";
	const priceCents = priceInfo.priceCents ?? 0;
	let price: number | string;
	if ((priceType === "FIXED" || priceType === "RESERVED") && priceCents > 0) {
		price = Math.floor(priceCents / 100);
	} else if (priceType === "FREE" || priceCents === 0) {
		price = 0;
	} else if (priceType === "BID") {
		price = "bid";
	} else if (priceType === "BID_FROM") {
		price = `>${Math.floor(priceCents / 100)}`;
	} else if (priceType === "SEE_DESCRIPTION") {
		price = "?";
	} else if (priceType === "TO_BE_AGREED_UPON") {
		price = "notk";
	} else if (priceType === "EXCHANGE") {
		price = "ruil";
	} else if (priceCents > 0) {
		price = Math.floor(priceCents / 100);
	} else {
		price = "?";
	}

	const specs = extractSpecsFromDescription(description, title);

	const result: CompactListing = {
		id: listing.itemId,
		title: title.trim(),
		price,
		city: location.cityName,
		seller: detectSellerType(traits, sellerName) === "business" ? "B" : "P",
	};

	const km = distanceKm(listing);
	if (km !== null) result.km = km;

	const cond = formatConditionShort(condition);
	if (cond) result.cond = cond;

	const age = formatDateShort(listing.date ?? "");
	if (age) result.age = age;

	if (Object.keys(specs).length > 0) result.specs = specs;

	return result;
}
