// Fills an empty database with a catalog and some order history (the history feeds /products/trending).

export const SKUS = Array.from({ length: 40 }, (_, i) => `SKU-${1001 + i}`);

export function catalog() {
  return SKUS.map((sku, i) => ({ sku, name: `Product ${i + 1}`, priceCents: 500 + (i % 8) * 125 }));
}

export async function seed(db, { orderCount = 60000 } = {}) {
  const products = db.collection("products");
  if ((await products.countDocuments()) === 0) await products.insertMany(catalog());

  const orders = db.collection("orders");
  await orders.createIndex({ createdAt: 1 });
  if ((await orders.countDocuments()) === 0) {
    const day = 24 * 3600 * 1000;
    for (let batchStart = 0; batchStart < orderCount; batchStart += 5000) {
      const batch = [];
      for (let i = 0; i < 5000 && batchStart + i < orderCount; i++) {
        const n = batchStart + i;
        batch.push({
          _id: `seed-${n}`,
          cartId: `seed-cart-${n}`,
          lines: [
            { sku: SKUS[n % SKUS.length], qty: 1 + (n % 3) },
            { sku: SKUS[(n * 7) % SKUS.length], qty: 1 },
          ],
          totalCents: 1000 + (n % 50) * 10,
          createdAt: new Date(Date.now() - (n % 25) * day),
        });
      }
      await orders.insertMany(batch);
    }
  }
}
