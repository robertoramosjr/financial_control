import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { mesAtual, resumoAno, visaoMes } from "../../src/mes";
import { chamar, entrar } from "./ajuda";
import { semear } from "./semente";

// Respostas que o app.py (Python) deu para os mesmos dados, com "hoje" = 2026-11-11.
// Geradas por scripts/gerar_golden.py; o Worker tem de reproduzi-las exatamente.
const goldenMes = import.meta.glob("../golden/mes-*.json", { eager: true, import: "default" }) as Record<string, any>;
const goldenResumo = import.meta.glob("../golden/resumo-*.json", { eager: true, import: "default" }) as Record<string, any>;
const nomeDe = (caminho: string) => caminho.split("/").pop()!.replace(/\.json$/, "");
const HOJE = "2026-11";

beforeAll(async () => {
  await semear(env.DB);
});

describe("paridade com o Python", () => {
  const meses = Object.entries(goldenMes).map(([caminho, esperado]) => [nomeDe(caminho).replace("mes-", ""), esperado]);
  const anos = Object.entries(goldenResumo).map(([caminho, esperado]) => [nomeDe(caminho).replace("resumo-", ""), esperado]);

  it("há golden de 2026-01 a 2027-12 e dos anos 2026 e 2027", () => {
    expect(meses.length).toBe(24);
    expect(anos.map(([a]) => a)).toEqual(["2026", "2027"]);
  });

  it.each(meses)("visão do mês %s", async (mes, esperado) => {
    expect(await visaoMes(env.DB, mes as string, HOJE)).toEqual(esperado);
  });

  it.each(anos)("resumo do ano %s", async (ano, esperado) => {
    expect(await resumoAno(env.DB, Number(ano), HOJE)).toEqual(esperado);
  });

  it("a ordem de por_categoria (desempate pela primeira aparição) é a do Python", async () => {
    const v = await visaoMes(env.DB, "2026-11", HOJE);
    expect(v.por_categoria).toEqual(goldenMes["../golden/mes-2026-11.json"].por_categoria);
  });
});

describe("mesAtual", () => {
  it("usa o fuso de São Paulo, não UTC", () => {
    // 01:30 UTC de 1º/dez ainda é 22:30 de 30/nov em São Paulo.
    expect(mesAtual(new Date("2026-12-01T01:30:00Z"))).toBe("2026-11");
    expect(mesAtual(new Date("2026-11-15T12:00:00Z"))).toBe("2026-11");
    expect(mesAtual(new Date("2027-01-01T02:59:00Z"))).toBe("2026-12");
    expect(mesAtual(new Date("2027-01-01T03:00:00Z"))).toBe("2027-01");
  });
});

describe("rotas de leitura", () => {
  it("GET /api/mes/:mes devolve a visão do mês", async () => {
    const cookie = await entrar();
    const resp = await chamar("GET", "/api/mes/2026-11", { cookie });
    expect(resp.status).toBe(200);
    const corpo: any = await resp.json();
    expect(corpo.mes).toBe("2026-11");
    expect(Object.keys(corpo)).toEqual(Object.keys(goldenMes["../golden/mes-2026-11.json"]));
  });

  it("GET /api/resumo/:ano devolve 12 meses", async () => {
    const cookie = await entrar();
    const corpo: any = await (await chamar("GET", "/api/resumo/2026", { cookie })).json();
    expect(corpo.ano).toBe(2026);
    expect(corpo.meses).toHaveLength(12);
  });

  it("mês inválido devolve 400 com a mensagem do Python", async () => {
    const cookie = await entrar();
    const resp = await chamar("GET", "/api/mes/2026-13", { cookie });
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ erro: "Mês inválido em m: use AAAA-MM" });
  });

  it("ano que não tem 4 dígitos cai em 404, como no Python", async () => {
    const cookie = await entrar();
    for (const caminho of ["/api/resumo/abcd", "/api/resumo/202", "/api/mes/2026-1"]) {
      const resp = await chamar("GET", caminho, { cookie });
      expect(resp.status).toBe(404);
      expect(await resp.json()).toEqual({ erro: "Rota não encontrada" });
    }
  });

  it("sem sessão devolve 401", async () => {
    expect((await chamar("GET", "/api/mes/2026-11")).status).toBe(401);
  });
});
