import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Roda antes de cada arquivo de teste: cria o esquema no D1 de teste.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
