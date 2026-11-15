import { randomUUID } from "node:crypto";
import express from "express";
import { charge, releaseStock, reserveStock, OutOfStockError } from "./clients.js";
import { error, info } from "./log0.js";
import { normalizeSku, priceCart } from "./pricing.js";

/** Build the Express app around a Mongo database handle (injected so tests can pass a fake). */
export function createApp(db) {
  const app = express();
  app.use(express.json());

  const products = db.collection("products");
  const carts = db.collection("carts");
  const orders = db.collection("orders");

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/products", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      res.json(await products.find({}, { projection: { _id: 0 } }).limit(limit).toArray());
    } catch (err) {
      next(err);
    }
  });

  // The ten best sellers of the last 30 days, computed from the orders collection.
  app.get("/products/trending", async (_req, res, next) => {
    try {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const rows = await orders
        .aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $unwind: "$lines" },
          { $group: { _id: "$lines.sku", sold: { $sum: "$lines.qty" } } },
          { $sort: { sold: -1 } },
          { $limit: 10 },
        ])
        .toArray();
      res.json(rows.map((r) => ({ sku: r._id, sold: r.sold })));
    } catch (err) {
      next(err);
    }
  });

  app.post("/cart/:cartId/items", async (req, res, next) => {
    try {
      const { sku, qty } = req.body ?? {};
      if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 1000) return res.status(400).json({ error: "sku and a whole qty from 1 to 1000 are required" });
      await carts.updateOne({ _id: req.params.cartId }, { $push: { items: { sku, qty } } }, { upsert: true });
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/cart/:cartId", async (req, res, next) => {
    try {
      const cart = await carts.findOne({ _id: req.params.cartId });
      if (!cart) return res.status(404).json({ error: "cart not found" });
      const catalog = await products.find({}).toArray();
      res.json({ cartId: cart._id, ...priceCart(cart.items ?? [], catalog) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/checkout", async (req, res, next) => {
    const orderId = randomUUID();
    try {
      const cartId = req.body?.cartId;
      const cart = cartId && (await carts.findOne({ _id: cartId }));
      if (!cart) return res.status(404).json({ error: "cart not found" });

      const catalog = await products.find({}).toArray();
      const priced = priceCart(cart.items ?? [], catalog);

      // the reservation runs alongside the payment, so checkout is not slowed down by inventory
      try {
        await reserveStock(orderId, priced.lines);
      } catch (err) {
        if (err instanceof OutOfStockError) {
          return res.status(409).json({ error: err.message, sku: err.sku });
        }
        throw err;
      }

      const payment = await charge(orderId, priced.totalCents, `${cartId}:${priced.totalCents}`);
      if (!payment.ok) {
        await releaseStock(orderId);
        error(`payment failed for order ${orderId}: payments answered ${payment.status}`);
        return res.status(502).json({ error: "payment failed" });
      }

      await orders.insertOne({ _id: orderId, cartId, lines: priced.lines, totalCents: priced.totalCents, createdAt: new Date() });
      await carts.deleteOne({ _id: cartId });
      info(`order ${orderId} placed`);
      res.status(201).json({ orderId, totalCents: priced.totalCents });
    } catch (err) {
      next(err);
    }
  });

  // anything that reaches here is a bug or an outage: log it with its stack, tell the caller nothing internal
  app.use((err, req, res, _next) => {
    error(`${req.method} ${req.path} failed: ${err.message}`, err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

export { normalizeSku };
