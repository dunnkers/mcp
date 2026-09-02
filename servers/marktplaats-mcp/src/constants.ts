export const REQUEST_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "application/json",
};

export const HTML_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml",
};

export const SEARCH_URL = "https://www.marktplaats.nl/lrp/api/search";
export const SELLER_URL = "https://www.marktplaats.nl/v/api/seller-profile";
export const LISTING_URL = "https://link.marktplaats.nl";

/** Traits that indicate a business seller. */
export const BUSINESS_TRAITS = new Set([
	"ADMARKT_CONSOLE",
	"CUSTOMER_SUPPORT_BUSINESS_LINE",
	"SELLER_PROFILE_URL",
	"VERIFIED_SELLER",
	"UNIQUE_SELLING_POINTS",
	"SHOPPING_CART",
]);

/** Business name patterns for improved seller type detection. */
export const BUSINESS_NAME_PATTERNS: RegExp[] = [
	/used products/,
	/buy\s*&?\s*sell/,
	/mediahoek/,
	/it[- ]?resale/,
	/\.nl$/,
	/\.com$/,
	/b\.?v\.?$/,
	/webshop/,
	/shop\b/,
	/store\b/,
	/handel/,
	/electronics/,
	/refurbished/,
	/outlet/,
];

export const L1_CATEGORIES: Record<string, number> = {
	"antiek en kunst": 1,
	"audio, tv en foto": 31,
	"auto's": 91,
	"auto-onderdelen": 2600,
	"auto diversen": 48,
	boeken: 201,
	"caravans en kamperen": 289,
	"cd's en dvd's": 1744,
	"computers en software": 322,
	"contacten en berichten": 378,
	"diensten en vakmensen": 1098,
	"dieren en toebehoren": 395,
	"doe-het-zelf en verbouw": 239,
	"fietsen en brommers": 445,
	"hobby en vrije tijd": 1099,
	"huis en inrichting": 504,
	"huizen en kamers": 1032,
	"kinderen en baby's": 565,
	"kleding | dames": 621,
	"kleding | heren": 1776,
	motoren: 678,
	"muziek en instrumenten": 728,
	"postzegels en munten": 1784,
	"sieraden, tassen en uiterlijk": 1826,
	"spelcomputers en games": 356,
	"sport en fitness": 784,
	telecommunicatie: 820,
	"tickets en kaartjes": 1984,
	"tuin en terras": 1847,
	vacatures: 167,
	vakantie: 856,
	verzamelen: 895,
	"watersport en boten": 976,
	"witgoed en apparatuur": 537,
	"zakelijke goederen": 1085,
	diversen: 428,
};

export interface L2Category {
	id: number;
	parent: number;
}

export const L2_CATEGORIES: Record<string, L2Category> = {
	laptops: { id: 339, parent: 322 },
	desktops: { id: 340, parent: 322 },
	tablets: { id: 2097, parent: 322 },
	"fietsen | dames": { id: 446, parent: 445 },
	"fietsen | heren": { id: 447, parent: 445 },
	"elektrische fietsen": { id: 1901, parent: 445 },
	kinderfietsen: { id: 449, parent: 445 },
	"mobiele telefoons": { id: 821, parent: 820 },
	iphone: { id: 1953, parent: 820 },
	samsung: { id: 1954, parent: 820 },
	bmw: { id: 92, parent: 91 },
	volkswagen: { id: 127, parent: 91 },
	audi: { id: 95, parent: 91 },
	"mercedes-benz": { id: 113, parent: 91 },
};

export const SORT_BY = {
	DATE: "SORT_INDEX",
	PRICE: "PRICE",
	OPTIMIZED: "OPTIMIZED",
	LOCATION: "LOCATION",
} as const;

export const SORT_ORDER = {
	ASC: "INCREASING",
	DESC: "DECREASING",
} as const;

export const CONDITION = {
	NEW: 30,
	REFURBISHED: 14050,
	AS_GOOD_AS_NEW: 31,
	USED: 32,
	NOT_WORKING: 13940,
} as const;
