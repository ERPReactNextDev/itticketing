import mongoose from "mongoose";

/**
 * Single cached Mongoose connection.
 *
 * Next.js hot-reloads modules in development and re-evaluates route handlers
 * per request in serverless, so the connection (and its socket pool) is cached
 * on globalThis to avoid opening a new pool on every invocation.
 */

const MONGODB_URI = process.env.MONGODB_URI;

/** Database name for THIS app. Never share a DB with another product. */
export const DB_NAME = process.env.MONGODB_DB?.trim() || "it_ticketing";

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as unknown as {
  __itTicketingMongoose?: MongooseCache;
};

const cache: MongooseCache = globalForMongoose.__itTicketingMongoose ?? {
  conn: null,
  promise: null,
};
globalForMongoose.__itTicketingMongoose = cache;

export async function connectDB(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. Add it to .env.local before starting the app.",
    );
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        dbName: DB_NAME,
        bufferCommands: false,
        // Fail fast instead of hanging a request for 30s when Mongo is down.
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 10,
      })
      .then((m) => m)
      .catch((err) => {
        // Reset so the next request can retry instead of caching the failure.
        cache.promise = null;
        throw err;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}

/** Alias kept short for call sites. */
export const db = connectDB;

export default connectDB;