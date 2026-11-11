import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ErroEntrada,
  centavos,
  dataNoMes,
  exigir,
  exigirCategoria,
  exigirData,
  exigirMes,
  idxMes,
  lerJson,
  mesIdx,
  reais,
  somarMeses,
} from "../../src/util";

const erro = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ErroEntrada);
    return (e as Error).message;
  }
  throw new Error("não lançou");
};

describe("centavos", () => {
  it("aceita vírgula e ponto decimais", () => {
    expect(centavos("12,34")).toBe(1234);
    expect(centavos("12.34")).toBe(1234);
    expect(centavos(12.34)).toBe(1234);
    expect(centavos(0.1 + 0.2)).toBe(30);
  });

  it("arredonda empates para o par, como o round() do Python", () => {
    expect(centavos("0.125")).toBe(12);
    expect(centavos("0.375")).toBe(38);
    expect(centavos("-0.125")).toBe(-12);
  });

  it("aceita os formatos de float do Python (notação científica e sublinhado)", () => {
    expect(centavos("1e2")).toBe(10000);
    expect(centavos("1_0")).toBe(1000);
  });

  it("nunca devolve -0", () => {
    expect(Object.is(centavos("-0"), 0)).toBe(true);
  });

  it("recusa lixo com a mensagem do Python", () => {
    expect(erro(() => centavos("abc"))).toBe("Valor inválido: 'abc'");
    expect(erro(() => centavos(""))).toBe("Valor inválido: ''");
    expect(erro(() => centavos(null))).toBe("Valor inválido: None");
    expect(erro(() => centavos(true))).toBe("Valor inválido: True");
    expect(erro(() => centavos("1.000,50"))).toBe("Valor inválido: '1.000,50'");
    expect(erro(() => centavos("inf"))).toBe("Valor inválido: 'inf'");
    expect(erro(() => centavos(Infinity))).toBe("Valor inválido: inf");
  });
});

describe("reais", () => {
  it("converte centavos em reais com duas casas", () => {
    expect(reais(1234)).toBe(12.34);
    expect(reais(5)).toBe(0.05);
    expect(reais(-5)).toBe(-0.05);
  });
});

describe("meses", () => {
  it("mesIdx e idxMes são inversos", () => {
    expect(mesIdx("2026-11")).toBe(2026 * 12 + 10);
    expect(idxMes(mesIdx("2026-11"))).toBe("2026-11");
    expect(idxMes(mesIdx("0999-01"))).toBe("0999-01");
  });

  it("somarMeses atravessa o ano nos dois sentidos", () => {
    expect(somarMeses("2026-11", 2)).toBe("2027-01");
    expect(somarMeses("2026-01", -1)).toBe("2025-12");
    expect(somarMeses("2026-05", 0)).toBe("2026-05");
  });

  it("dataNoMes limita ao último dia do mês", () => {
    expect(dataNoMes("2026-02", 31)).toBe("2026-02-28");
    expect(dataNoMes("2024-02", 31)).toBe("2024-02-29");
    expect(dataNoMes("2026-11", 5)).toBe("2026-11-05");
  });
});

describe("exigir", () => {
  it("recusa ausente ou em branco", () => {
    expect(erro(() => exigir({}, "nome"))).toBe("Campo obrigatório: nome");
    expect(erro(() => exigir({ nome: "   " }, "nome"))).toBe("Campo obrigatório: nome");
    expect(erro(() => exigir({ nome: null }, "nome"))).toBe("Campo obrigatório: nome");
  });

  it("texto vem sem espaços nas pontas", () => {
    expect(exigir({ nome: "  Luz " }, "nome")).toBe("Luz");
  });

  it('tipo "number" converte para inteiro como int() do Python', () => {
    expect(exigir({ dia: "15" }, "dia", "number")).toBe(15);
    expect(exigir({ dia: 15.9 }, "dia", "number")).toBe(15);
    expect(erro(() => exigir({ dia: "abc" }, "dia", "number"))).toBe("Valor inválido: 'abc'");
    expect(erro(() => exigir({ dia: "1.5" }, "dia", "number"))).toBe("Valor inválido: '1.5'");
  });
});

describe("exigirMes", () => {
  it("aceita AAAA-MM e recusa o resto", () => {
    expect(exigirMes({ m: "2026-11" }, "m")).toBe("2026-11");
    expect(erro(() => exigirMes({ m: "2026-13" }, "m"))).toBe("Mês inválido em m: use AAAA-MM");
    expect(erro(() => exigirMes({}, "m"))).toBe("Mês inválido em m: use AAAA-MM");
    expect(erro(() => exigirMes({ m: 202611 }, "m"))).toBe("Mês inválido em m: use AAAA-MM");
  });

  it("opcional vazio vira null", () => {
    expect(exigirMes({ m: "" }, "m", true)).toBeNull();
    expect(exigirMes({}, "m", true)).toBeNull();
  });
});

describe("exigirData", () => {
  it("valida o calendário", () => {
    expect(exigirData({ d: "2024-02-29" }, "d")).toBe("2024-02-29");
    expect(erro(() => exigirData({ d: "2026-02-30" }, "d"))).toBe("Data inválida em d: 2026-02-30");
    expect(erro(() => exigirData({ d: "26-02-03" }, "d"))).toBe("Data inválida em d: use AAAA-MM-DD");
  });

  it("opcional vazio vira null", () => {
    expect(exigirData({}, "d", true)).toBeNull();
    expect(exigirData({ d: null }, "d", true)).toBeNull();
  });
});

describe("exigirCategoria", () => {
  it("devolve o id quando a categoria existe", async () => {
    expect(await exigirCategoria(env.DB, { categoria_id: 1 })).toBe(1);
  });

  it("recusa categoria inexistente ou ausente", async () => {
    await expect(exigirCategoria(env.DB, { categoria_id: 999 })).rejects.toThrow("Escolha uma categoria válida");
    await expect(exigirCategoria(env.DB, {})).rejects.toBeInstanceOf(ErroEntrada);
  });
});

describe("lerJson", () => {
  const req = (corpo?: string, headers: Record<string, string> = {}) =>
    new Request("https://exemplo.test/x", { method: "POST", body: corpo, headers });

  it("corpo vazio vira objeto vazio", async () => {
    expect(await lerJson(req())).toEqual({});
  });

  it("lê um objeto JSON", async () => {
    expect(await lerJson(req('{"a": 1}'))).toEqual({ a: 1 });
  });

  it("recusa JSON quebrado e o que não é objeto", async () => {
    await expect(lerJson(req("{quebrado"))).rejects.toThrow("JSON inválido");
    await expect(lerJson(req("[1, 2]"))).rejects.toThrow("JSON inválido");
    await expect(lerJson(req("null"))).rejects.toThrow("JSON inválido");
  });

  it("recusa corpo acima de 1.000.000 de bytes, com ou sem Content-Length", async () => {
    const grande = JSON.stringify({ x: "a".repeat(1_000_001) });
    await expect(lerJson(req(grande))).rejects.toThrow("Requisição grande demais");
    await expect(lerJson(req("{}", { "Content-Length": "1000001" }))).rejects.toThrow("Requisição grande demais");
  });

  it("aceita corpo de exatamente 1.000.000 de bytes", async () => {
    const corpo = JSON.stringify({ x: "a".repeat(1_000_000 - 8) });
    expect(corpo.length).toBe(1_000_000);
    expect(Object.keys(await lerJson(req(corpo)))).toEqual(["x"]);
  });
});
