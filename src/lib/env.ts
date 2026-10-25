import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default("skyops"),
  NEO4J_URI: z.string().min(1),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.string().min(1),
});

// Validated once at first import; fails fast with a clear message if .env is incomplete.
export const env = schema.parse(process.env);
