/**
 * Catalog access for HVAC AI.
 *
 * Every product the agent can see is checked against the Parts collection
 * with `inCollection`, so the assistant can never recommend a condenser,
 * furnace system, or anything else outside the parts catalog.
 */

export type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type PartSummary = {
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  sku: string | null;
  price: string | null;
  compareAtPrice: string | null;
  currency: string;
  available: boolean;
  url: string;
  image: string | null;
};

export type PartDetail = PartSummary & {
  description: string;
  tags: string[];
  variants: { title: string; sku: string | null; price: string; available: boolean }[];
};

export const PARTS_COLLECTION_HANDLE =
  process.env.PARTS_COLLECTION_HANDLE || "parts";

const collectionIdCache = new Map<string, { id: string; at: number }>();
const COLLECTION_TTL_MS = 60 * 60 * 1000;

async function gql<T>(
  admin: AdminGraphql,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!json.data) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

export async function getPartsCollection(admin: AdminGraphql, shop: string) {
  const cached = collectionIdCache.get(shop);
  if (cached && Date.now() - cached.at < COLLECTION_TTL_MS) return cached.id;

  const data = await gql<{
    collectionByIdentifier: { id: string } | null;
  }>(
    admin,
    `#graphql
    query HvacAiPartsCollection($handle: String!) {
      collectionByIdentifier(identifier: { handle: $handle }) { id }
    }`,
    { handle: PARTS_COLLECTION_HANDLE },
  );
  const id = data.collectionByIdentifier?.id;
  if (!id) {
    throw new Error(
      `Parts collection "${PARTS_COLLECTION_HANDLE}" was not found on ${shop}.`,
    );
  }
  collectionIdCache.set(shop, { id, at: Date.now() });
  return id;
}

const PRODUCT_FIELDS = `#graphql
  fragment HvacAiPart on Product {
    handle
    title
    vendor
    productType
    status
    onlineStoreUrl
    inCollection(id: $collectionId)
    featuredMedia { preview { image { url(transform: { maxWidth: 240 }) } } }
    priceRangeV2 { minVariantPrice { amount currencyCode } }
    compareAtPriceRange { maxVariantCompareAtPrice { amount } }
    totalInventory
    tracksInventory
    variants(first: 10) {
      nodes { title sku price availableForSale }
    }
  }
`;

type RawProduct = {
  handle: string;
  title: string;
  vendor: string;
  productType: string;
  status: string;
  onlineStoreUrl: string | null;
  inCollection: boolean;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
  compareAtPriceRange: { maxVariantCompareAtPrice: { amount: string } | null } | null;
  totalInventory: number | null;
  tracksInventory: boolean;
  variants: {
    nodes: { title: string; sku: string | null; price: string; availableForSale: boolean }[];
  };
  description?: string;
  tags?: string[];
};

function toSummary(p: RawProduct, shopDomain: string): PartSummary {
  const compare = p.compareAtPriceRange?.maxVariantCompareAtPrice?.amount;
  const price = p.priceRangeV2?.minVariantPrice?.amount ?? null;
  return {
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.productType,
    sku: p.variants.nodes[0]?.sku ?? null,
    price,
    compareAtPrice:
      compare && price && Number(compare) > Number(price) ? compare : null,
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode ?? "USD",
    available: p.variants.nodes.some((v) => v.availableForSale),
    url: p.onlineStoreUrl || `https://${shopDomain}/products/${p.handle}`,
    image: p.featuredMedia?.preview?.image?.url ?? null,
  };
}

/** Escape characters that have meaning in Shopify search syntax. */
function clean(term: string) {
  return term
    .replace(/[\\:()"'*<>=]/g, " ")
    .replace(/\b(AND|OR|NOT)\b/g, " ")
    .replace(/(^|\s)-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function buildSearchQueries(input: {
  keywords?: string;
  part_number?: string;
  brand?: string;
}): string[] {
  const queries: string[] = [];
  const brand = input.brand ? clean(input.brand) : "";
  const brandFilter = brand ? ` AND vendor:"${brand}"` : "";
  const active = "status:active";

  if (input.part_number) {
    const pn = clean(input.part_number).replace(/\s/g, "");
    if (pn) {
      queries.push(`${active} AND (sku:"${pn}" OR tag:"${pn}" OR title:*${pn}*)`);
    }
  }
  if (input.keywords) {
    const kw = clean(input.keywords);
    if (kw) {
      // Title match first (most precise), then free text across fields.
      const titleTerms = kw
        .split(" ")
        .filter((w) => w.length > 1)
        .slice(0, 5)
        .map((w) => `title:*${w}*`)
        .join(" AND ");
      if (titleTerms) queries.push(`${active} AND ${titleTerms}${brandFilter}`);
      queries.push(`${active} AND ${kw}${brandFilter}`);
    }
  }
  return queries;
}

export async function searchParts(
  admin: AdminGraphql,
  shopDomain: string,
  collectionId: string,
  input: { keywords?: string; part_number?: string; brand?: string },
  limit = 6,
): Promise<PartSummary[]> {
  const results = new Map<string, PartSummary>();

  for (const query of buildSearchQueries(input)) {
    const data = await gql<{ products: { nodes: RawProduct[] } }>(
      admin,
      `#graphql
      ${PRODUCT_FIELDS}
      query HvacAiSearchParts($query: String!, $collectionId: ID!) {
        products(first: 40, query: $query, sortKey: RELEVANCE) {
          nodes { ...HvacAiPart }
        }
      }`,
      { query, collectionId },
    );
    for (const p of data.products.nodes) {
      if (!p.inCollection || p.status !== "ACTIVE") continue;
      if (!results.has(p.handle)) results.set(p.handle, toSummary(p, shopDomain));
      if (results.size >= limit) break;
    }
    if (results.size >= limit) break;
  }

  // In-stock parts first, keep relevance order otherwise.
  return [...results.values()].sort(
    (a, b) => Number(b.available) - Number(a.available),
  );
}

export async function getPart(
  admin: AdminGraphql,
  shopDomain: string,
  collectionId: string,
  handle: string,
): Promise<PartDetail | null> {
  const data = await gql<{ productByIdentifier: RawProduct | null }>(
    admin,
    `#graphql
    ${PRODUCT_FIELDS}
    query HvacAiGetPart($handle: String!, $collectionId: ID!) {
      productByIdentifier(identifier: { handle: $handle }) {
        ...HvacAiPart
        description
        tags
      }
    }`,
    { handle, collectionId },
  );
  const p = data.productByIdentifier;
  if (!p || !p.inCollection || p.status !== "ACTIVE") return null;

  return {
    ...toSummary(p, shopDomain),
    description: (p.description || "").slice(0, 2500),
    tags: (p.tags || []).filter((t) => !t.startsWith("_")).slice(0, 20),
    variants: p.variants.nodes.map((v) => ({
      title: v.title,
      sku: v.sku,
      price: v.price,
      available: v.availableForSale,
    })),
  };
}
