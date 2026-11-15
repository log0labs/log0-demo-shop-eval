// Turns cart lines into priced lines. Pure functions: no database, easy to test.

export function normalizeSku(sku) {
  return String(sku).trim().toUpperCase();
}

/** Price every cart line from the catalog (an array of products). Throws if the cart is empty. */
export function priceCart(items, catalog) {
  if (!items.length) throw new Error("cart is empty");
  const bySku = new Map(catalog.map((p) => [normalizeSku(p.sku), p]));
  const lines = items.map((item) => {
    const normalized = normalizeSku(item.sku);
    const product = bySku.get(normalized);
    if (!product) throw new Error(`unknown sku ${item.sku}`);
    return { sku: product.sku, qty: item.qty, unitPriceCents: product.priceCents, totalCents: product.priceCents * item.qty };
  });
  return { lines, totalCents: lines.reduce((sum, l) => sum + l.totalCents, 0) };
}
