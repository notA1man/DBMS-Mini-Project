import { MongoClient, type Db } from "mongodb";
import { env } from "@/lib/env";

const globalForMongo = globalThis as unknown as { mongoClient?: MongoClient };

export const mongoClient = globalForMongo.mongoClient ?? new MongoClient(env.MONGODB_URI);

if (process.env.NODE_ENV !== "production") globalForMongo.mongoClient = mongoClient;

export async function mongoDb(): Promise<Db> {
  await mongoClient.connect(); // no-op when already connected
  return mongoClient.db(env.MONGODB_DB);
}
