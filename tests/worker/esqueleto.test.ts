import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";

describe("esqueleto do Worker", () => {
  it("GET /api/eu sem sessão devolve usuario null e exige_login true", async () => {
    const resp = await worker.fetch(new Request("https://exemplo.test/api/eu"), env);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ usuario: null, exige_login: true });
  });

  it("a migração cria as 9 categorias padrão", async () => {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM categorias").first<{ n: number }>();
    expect(r?.n).toBe(9);
  });

  it("chaves estrangeiras estão ligadas", async () => {
    const r = await env.DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
    expect(r?.foreign_keys).toBe(1);
  });
});

describe("limite do PBKDF2 na plataforma", () => {
  async function pbkdf2(iteracoes: number) {
    const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode("senha"), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations: iteracoes },
      chave,
      256,
    );
  }

  it("aceita 100000 iterações", async () => {
    expect((await pbkdf2(100_000)).byteLength).toBe(32);
  });

  // Em produção a Cloudflare limita o PBKDF2 a 100000 iterações (issue workerd #1346), mas o runtime
  // local não aplica esse limite, então nenhum teste local prova a recusa. Por isso as senhas novas
  // usam 100000 (Task 3) e o comportamento real é conferido no deploy (Task 9).
});
