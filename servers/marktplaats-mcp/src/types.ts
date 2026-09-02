export interface RawPriceInfo {
	priceType?: string;
	priceCents?: number;
}

export interface RawLocation {
	cityName?: string;
	distanceMeters?: number;
}

export interface RawSeller {
	sellerId?: number;
	sellerName?: string;
	isVerified?: boolean;
}

export interface RawPicture {
	mediumUrl?: string;
}

export interface RawAttribute {
	key?: string;
	value?: string;
}

export interface RawListing {
	itemId?: string;
	title?: string;
	description?: string;
	date?: string;
	priceInfo?: RawPriceInfo;
	location?: RawLocation;
	sellerInformation?: RawSeller;
	traits?: string[];
	pictures?: RawPicture[];
	attributes?: RawAttribute[];
}

export interface RawSearchResponse {
	listings?: RawListing[];
	totalResultCount?: number;
	facets?: RawFacet[];
}

export interface RawFacetAttribute {
	attributeValueId?: number;
	attributeValueLabel?: string;
	attributeValueKey?: string;
	histogramCount?: number;
}

export interface RawFacet {
	key?: string;
	label?: string;
	attributeGroup?: RawFacetAttribute[];
}

export interface RawSellerProfile {
	sellerId?: number;
	sellerName?: string;
	isVerified?: boolean;
	averageScore?: number;
	numberOfReviews?: number;
	bankAccountVerified?: boolean;
	identificationVerified?: boolean;
	phoneNumberVerified?: boolean;
}

export type SellerType = "business" | "private";

export interface FormattedListing {
	id?: string;
	title: string;
	description: string;
	price: string;
	price_cents: number;
	condition: string | null;
	location: {
		city?: string;
		distance_km: number | null;
	};
	seller: {
		id?: number;
		name: string;
		is_verified: boolean;
		type: SellerType;
	};
	date?: string;
	image: string;
	link: string;
	specs?: Record<string, string>;
}

export interface CompactListing {
	id?: string;
	title: string;
	price: number | string;
	city?: string;
	seller: "B" | "P";
	km?: number;
	cond?: string;
	age?: string;
	specs?: Record<string, string>;
}

export interface ApiError {
	error: string;
}
