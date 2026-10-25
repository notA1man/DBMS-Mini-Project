import neo4j, { type Driver } from "neo4j-driver";
import { env } from "@/lib/env";

const globalForNeo4j = globalThis as unknown as { neo4jDriver?: Driver };

export const neo4jDriver =
  globalForNeo4j.neo4jDriver ??
  neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));

if (process.env.NODE_ENV !== "production") globalForNeo4j.neo4jDriver = neo4jDriver;
