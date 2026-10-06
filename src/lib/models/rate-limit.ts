import { Schema, model, models, type InferSchemaType } from "mongoose";

/**
 * Mongo-backed store for express-rate-limit.
 *
 * A TTL index expires each window record exactly when its window ends, so the
 * collection self-prunes. The unique key is `key + windowStart` - each window
 * gets its own document, which keeps concurrent increments atomic.
 */
const RateLimitSchema = new Schema(
  {
    key: { type: String, required: true, index: true },
    windowStart: { type: Number, required: true },
    totalHits: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

RateLimitSchema.index({ key: 1, windowStart: 1 }, { unique: true });
// expireAfterSeconds: 0 => expire at the end of the window itself.
RateLimitSchema.index({ windowStart: 1 }, { expireAfterSeconds: 0 });

export type RateLimitAttrs = InferSchemaType<typeof RateLimitSchema>;
export const RateLimit = models.RateLimit ?? model("RateLimit", RateLimitSchema);
export default RateLimit;