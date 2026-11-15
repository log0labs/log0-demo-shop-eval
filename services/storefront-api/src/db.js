import { MongoClient } from "mongodb";

const URI = process.env.MONGO_URL || "mongodb://localhost:27017";

let client;

export async function connect() {
  client = new MongoClient(URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  return client.db("shop");
}

export async function close() {
  await client?.close();
}
