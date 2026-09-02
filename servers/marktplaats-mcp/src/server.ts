import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	getCategoryFilters,
	getListingDetails,
	getSellerInfo,
	listCategories,
	searchListings,
} from "./api.js";

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Build a fresh MCP server instance with all Marktplaats tools registered. */
export function createMarktplaatsServer(): McpServer {
	const server = new McpServer({ name: "marktplaats", version: "0.1.0" });

	server.registerTool(
		"search_listings",
		{
			description: "Search for listings on Marktplaats.nl.",
			inputSchema: {
				query: z.string().optional().default("").describe(
					"Search query text (required if no category specified)",
				),
				category: z
					.string()
					.optional()
					.describe(
						'Main category name (e.g., "computers en software", "fietsen en brommers")',
					),
				subcategory: z
					.string()
					.optional()
					.describe('Subcategory name (e.g., "laptops", "elektrische fietsen")'),
				zip_code: z
					.string()
					.optional()
					.default("")
					.describe(
						'Dutch postal code for distance calculations (e.g., "1016LV"). Required for distance filtering!',
					),
				distance_km: z
					.number()
					.int()
					.optional()
					.default(1000)
					.describe("Maximum distance in kilometers. Only works with zip_code."),
				price_from: z.number().optional().describe("Minimum price in euros"),
				price_to: z.number().optional().describe("Maximum price in euros"),
				condition: z
					.string()
					.optional()
					.describe(
						'Item condition: "new", "as_good_as_new", "used", "refurbished", "not_working"',
					),
				seller_type: z
					.string()
					.optional()
					.describe(
						'Filter by seller type: "business" (zakelijk, for VAT invoices) or "private" (particulier)',
					),
				sort_by: z
					.string()
					.optional()
					.default("optimized")
					.describe('Sort method: "date", "price", "optimized", "location"'),
				sort_order: z.string().optional().default("asc").describe('Sort order: "asc" or "desc"'),
				limit: z.number().int().min(1).max(100).optional().default(10).describe(
					"Number of results (1-100)",
				),
				offset: z.number().int().optional().default(0).describe("Pagination offset"),
				offered_since_days: z
					.number()
					.int()
					.optional()
					.describe("Only show items posted within the last X days"),
				attribute_ids: z
					.array(z.number())
					.optional()
					.describe(
						"List of attribute filter IDs (use get_category_filters to find these)",
					),
				extract_specs: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Try to extract hardware specs (RAM, storage, CPU) from descriptions (for laptops/tablets)",
					),
				compact: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Return minimal response format (~75% smaller). Omits description, image, links. Use get_listing_details(id) for full info. Seller: B=business, P=private. Condition: N=new, Z=as good as new, G=used, R=refurbished, D=defect.",
					),
			},
		},
		async (args) =>
			textResult(
				await searchListings({
					query: args.query,
					category: args.category,
					subcategory: args.subcategory,
					zipCode: args.zip_code,
					distanceKm: args.distance_km,
					priceFrom: args.price_from,
					priceTo: args.price_to,
					condition: args.condition,
					sellerType: args.seller_type,
					sortBy: args.sort_by,
					sortOrder: args.sort_order,
					limit: args.limit,
					offset: args.offset,
					offeredSinceDays: args.offered_since_days,
					attributeIds: args.attribute_ids,
					extractSpecs: args.extract_specs,
					compact: args.compact,
				}),
			),
	);

	server.registerTool(
		"get_listing_details",
		{
			description:
				"Get full details of a specific listing including complete description and all images.",
			inputSchema: {
				listing_id: z.string().describe('The listing ID (e.g., "m2340580395")'),
			},
		},
		async (args) => textResult(await getListingDetails(args.listing_id)),
	);

	server.registerTool(
		"get_seller_info",
		{
			description:
				"Get detailed information about a seller including ratings and verification status.",
			inputSchema: {
				seller_id: z.number().describe("The seller's numeric ID"),
			},
		},
		async (args) => textResult(await getSellerInfo(args.seller_id)),
	);

	server.registerTool(
		"list_categories",
		{
			description: "List all available main categories and common subcategories on Marktplaats.",
			inputSchema: {},
		},
		async () => textResult(listCategories()),
	);

	server.registerTool(
		"get_category_filters",
		{
			description:
				"Get available filter options for a specific category (like RAM, brand, screen size, etc.).",
			inputSchema: {
				category: z.string().optional().describe('Main category name (e.g., "computers en software")'),
				subcategory: z.string().optional().describe('Subcategory name (e.g., "laptops")'),
			},
		},
		async (args) => textResult(await getCategoryFilters(args.category, args.subcategory)),
	);

	return server;
}
