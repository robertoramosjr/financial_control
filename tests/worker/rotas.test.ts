import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../src/index";
import { ROTAS } from "../../src/rotas";
import { chamar, entrar } from "./ajuda";
import { semear } from "./semente";

import rotasPython from "../golden/rotas.json";

let cookie = "";
beforeAll(async () => {
  cookie = await entrar();
});
beforeEach(async () => {
  await semear(env.DB);
});

const SEGURANCA = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Troca cada grupo capturado do padrão por um valor que ele aceita. */
const urlDeExemplo = (padrao: string) =>
  padrao
    .replace(/^\^|\$$/g, "")
    .replace(/\((.*?)\)/g, (_, grupo: string) => (grupo.includes("-") ? "2026-11" : grupo.includes("{4}") ? "2026" : "1"));

describe("tabela de rotas", () => {
  const doWorker = ROTAS.map(([metodo, padrao]) => `${metodo} ${padrao.source.replaceAll("\\/", "/")}`);
  const doPython = (rotasPython as [string, string][]).map(([metodo, padrao]) => `${metodo} ${padrao}`);

  it("tem exatamente as 40 rotas do app.py, com os mesmos padrões", () => {
    expect(doPython).toHaveLength(40);
    expect([...doWorker].sort()).toEqual([...doPython].sort());
  });

  it.each(rotasPython as [string, string][])("%s %s responde (nem 404 de rota, nem 500)", async (metodo, padrao) => {
    const caminho = urlDeExemplo(padrao);
    const resp = await chamar(metodo, caminho, { cookie, corpo: metodo === "GET" ? undefined : {} });
    const corpo: any = await resp.json();
    expect(corpo.erro, `${metodo} ${caminho}`).not.toBe("Rota não encontrada");
    expect([200, 400], `${metodo} ${caminho}: ${JSON.stringify(corpo)}`).toContain(resp.status);
  });

  it("método errado numa rota conhecida, ou caminho desconhecido, devolve 404 em JSON", async () => {
    for (const [metodo, caminho] of [["PATCH", "/api/categorias"], ["DELETE", "/api/mes/2026-11"], ["GET", "/api/xyz"]]) {
      const resp = await chamar(metodo, caminho, { cookie });
      expect(resp.status, `${metodo} ${caminho}`).toBe(404);
      expect(await resp.json()).toEqual({ erro: "Rota não encontrada" });
    }
  });
});

describe("corpo da requisição", () => {
  it("corpo acima de 1.000.000 de bytes devolve 400", async () => {
    const resp = await chamar("POST", "/api/lancamentos", { cookie, corpo: { descricao: "x".repeat(1_000_001) } });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ erro: "Requisição grande demais" });
  });

  it("JSON quebrado devolve 400", async () => {
    const resp = await worker.fetch(
      new Request("https://exemplo.test/api/categorias/1", { method: "PUT", headers: { Cookie: cookie }, body: "{quebrado" }),
      env,
    );
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ erro: "JSON inválido" });
  });
});

describe("cabeçalhos de segurança", () => {
  it("toda resposta de /api/* traz os cabeçalhos, qualquer que seja o status", async () => {
    const respostas = [
      await chamar("GET", "/api/categorias", { cookie }), // 200
      await chamar("GET", "/api/mes/2026-13", { cookie }), // 400
      await chamar("GET", "/api/categorias"), // 401
      await chamar("GET", "/api/xyz", { cookie }), // 404
      await chamar("POST", "/api/login", { corpo: { usuario: "ninguem", senha: "x" } }), // 401 do login
    ];
    expect(respostas.map((r) => r.status)).toEqual([200, 400, 401, 404, 401]);
    for (const r of respostas) {
      for (const [nome, valor] of Object.entries(SEGURANCA)) expect(r.headers.get(nome), nome).toBe(valor);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});

describe("erro inesperado", () => {
  it("devolve 500 genérico, sem vazar a mensagem, e registra no log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const quebrado = {
      ASSETS: env.ASSETS,
      DB: {
        prepare() {
          throw new Error("segredo-interno-do-banco");
        },
      },
    } as unknown as Env;
    const resp = await worker.fetch(new Request("https://exemplo.test/api/categorias", { headers: { Cookie: "sessao=x" } }), quebrado);
    expect(resp.status).toBe(500);
    const texto = await resp.text();
    expect(JSON.parse(texto)).toEqual({ erro: "Erro interno no servidor" });
    expect(texto).not.toContain("segredo");
    for (const [nome, valor] of Object.entries(SEGURANCA)) expect(resp.headers.get(nome), nome).toBe(valor);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("arquivos estáticos (o que chegar ao Worker fora de /api/)", () => {
  it("POST em / devolve 405", async () => {
    const resp = await worker.fetch(new Request("https://exemplo.test/", { method: "POST" }), env);
    expect(resp.status).toBe(405);
    expect(await resp.json()).toEqual({ erro: "Método não permitido" });
  });

  it("GET / devolve o index.html, sem cache e com os cabeçalhos de segurança", async () => {
    const resp = await worker.fetch(new Request("https://exemplo.test/"), env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/html");
    expect(resp.headers.get("cache-control")).toBe("no-cache");
    for (const [nome, valor] of Object.entries(SEGURANCA)) expect(resp.headers.get(nome), nome).toBe(valor);
    expect(await resp.text()).toContain("<html");
  });

  it("arquivo que não existe devolve 404", async () => {
    const resp = await worker.fetch(new Request("https://exemplo.test/nao-existe.js"), env);
    expect(resp.status).toBe(404);
  });
});
