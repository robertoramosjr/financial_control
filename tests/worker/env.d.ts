/// <reference types="vite/client" />
// Tipos dos bindings usados nos testes (os de produção estão em wrangler.jsonc).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
