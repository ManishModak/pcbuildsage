export type Product = {
  id: string;
  name: string;
  normalized_name: string | null;
  registry_key: string | null;
  price_minor: number | null;
  currency: string;
  country_code: string;
  retailer: string;
  url: string;
  image_url: string | null;
  in_stock: 0 | 1;
  category: string;
  specs: string | null;
  first_seen: string;
  last_scraped: string;
};

export type ProductView = Omit<Product, "in_stock"> & {
  in_stock: boolean;
};

export function toProductView(product: Product): ProductView {
  return {
    ...product,
    in_stock: product.in_stock === 1
  };
}

export type AuditCacheEntry = {
  pair_key: string;
  verdict: string;
  checked_at: string;
};

export type RegistryResearchEntry = {
  key: string;
  category: string;
  specs: string;
  sources: string | null;
  confidence: "high" | "medium" | "low";
  researched_at: string;
};
