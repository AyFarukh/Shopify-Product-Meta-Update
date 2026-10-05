import { config } from '../lib/config.js';

type ShopifySession = { shop: string; accessToken: string };
type GraphqlResponse<T> = { data?: T; errors?: Array<{message:string}>; extensions?: { cost?: { throttleStatus?: { currentlyAvailable:number; restoreRate:number } } } };

async function graphql<T>(session: ShopifySession, query: string, variables: Record<string,unknown> = {}, attempt=0): Promise<GraphqlResponse<T>> {
  const response = await fetch(`https://${session.shop}/admin/api/${config.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Shopify-Access-Token': session.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 429 || response.status >= 500) {
    if (attempt >= 5) throw new Error(`Shopify request failed after retries: ${response.status}`);
    await new Promise(r=>setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
    return graphql(session, query, variables, attempt+1);
  }
  const json = await response.json() as GraphqlResponse<T>;
  if (!response.ok || json.errors?.length) throw new Error(json.errors?.map(e=>e.message).join('; ') || `Shopify HTTP ${response.status}`);
  const available = json.extensions?.cost?.throttleStatus?.currentlyAvailable;
  if (available !== undefined && available < 100) await new Promise(r=>setTimeout(r, 500));
  return json;
}

export async function fetchProductsPage(session: ShopifySession, after?: string|null) {
  const query = `query Products($after: String) { products(first: 100, after: $after, sortKey: UPDATED_AT) { nodes { id handle title vendor productType status updatedAt } pageInfo { hasNextPage endCursor } } }`;
  const result = await graphql<{products:{nodes:Array<{id:string;handle:string;title:string;vendor:string;productType:string;status:string;updatedAt:string}>;pageInfo:{hasNextPage:boolean;endCursor:string|null}}}>(session, query, {after});
  if (!result.data) throw new Error('Shopify returned no product data');
  return result.data.products;
}

// SECURITY INVARIANT: this mutation accepts and sends only id + vendor.
export async function updateProductVendor(session: ShopifySession, productId: string, vendor: string) {
  const mutation = `mutation UpdateProductVendor($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id vendor } userErrors { field message } } }`;
  const result = await graphql<{productUpdate:{product:{id:string;vendor:string}|null;userErrors:Array<{field:string[];message:string}>}}>(session, mutation, { product: { id: productId, vendor } });
  if (!result.data) throw new Error('Shopify returned no mutation data');
  const errors = result.data.productUpdate.userErrors;
  if (errors.length) throw new Error(errors.map(e=>e.message).join('; '));
  return result.data.productUpdate.product;
}
