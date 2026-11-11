import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parcelaCentavos, projecao } from "../../src/projecao";
import { chamar, entrar } from "./ajuda";
import { semear, semearProjecao } from "./semente";

const arquivos = import.meta.glob("../golden/projecao-*.json", { eager: true, import: "default" }) as Record<string, any>;
const golden = (nome: string) => arquivos[`../golden/${nome}.json`];

let cookie = "";
beforeAll(async () => {
  cookie = await entrar();
});
beforeEach(async () => {
  await semear(env.DB);
});

async function api(metodo: string, caminho: string, corpo?: unknown) {
  const resp = await chamar(metodo, caminho, { corpo, cookie });
  return { status: resp.status, corpo: (await resp.json()) as any };
}
const erro = (mensagem: string) => ({ status: 400, corpo: { erro: mensagem } });

async function contar(tabela: string, onde = "1 = 1"): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabela} WHERE ${onde}`).first<{ n: number }>())!.n;
}
const linha = <T = any>(sql: string, ...v: unknown[]) => env.DB.prepare(sql).bind(...v).first<T>();
const linhas = async (sql: string, ...v: unknown[]) => (await env.DB.prepare(sql).bind(...v).all()).results;

describe("parcelaCentavos", () => {
  it("arredonda ao centavo mais próximo, meio sobe, como o Python (um valor só, sem distribuir resto)", () => {
    expect(parcelaCentavos(10000, 3)).toBe(3333);
    expect(parcelaCentavos(10000, 1)).toBe(10000);
    expect(parcelaCentavos(10001, 2)).toBe(5001);
    expect(parcelaCentavos(1, 2)).toBe(1);
    expect(parcelaCentavos(1, 3)).toBe(0);
  });

  it("continua certo com totais muito grandes (acima de 2^53 centavos)", () => {
    expect(parcelaCentavos(1e17, 4)).toBe(2.5e16);
    expect(parcelaCentavos(1e17, 3)).toBe(33333333333333332); // 1e17/3 = 3,33…e16, arredondado ao centavo
  });
});

describe("projeção igual à do Python", () => {
  it("só com despesas reais (sem cenários)", async () => {
    expect(await projecao(env.DB, "2026-11")).toEqual(golden("projecao-base"));
  });

  it("com entradas digitadas, 2 cenários, contas previstas e 5 ajustes", async () => {
    await semearProjecao(env.DB);
    expect(await projecao(env.DB, "2026-11")).toEqual(golden("projecao-completa"));
  });

  it("começando em outro mês (muda quais meses estão 'fechados')", async () => {
    await semearProjecao(env.DB);
    expect(await projecao(env.DB, "2026-03")).toEqual(golden("projecao-2026-03"));
  });

  it("GET /api/projecao responde pela rota", async () => {
    await semearProjecao(env.DB);
    const r = await api("GET", "/api/projecao");
    expect(r.status).toBe(200);
    expect(r.corpo.cenarios.map((c: any) => c.nome)).toEqual(["Sem a compra", "Notebook novo", "Viagem"]);
    expect(r.corpo.meses).toHaveLength(12);
  });
});

describe("entrada prevista", () => {
  it("grava, troca, apaga; zero é um valor; negativo é recusado", async () => {
    const url = "/api/projecao/entradas";
    expect((await api("PUT", url, { mes: "2027-05", valor: "1000,50" })).corpo).toEqual({ ok: true, id: null });
    await api("PUT", url, { mes: "2027-05", valor: "2000" });
    expect(await linha("SELECT valor_centavos FROM projecao_entradas WHERE mes = '2027-05'")).toEqual({ valor_centavos: 200000 });
    await api("PUT", url, { mes: "2027-05", valor: 0 });
    expect(await linha("SELECT valor_centavos FROM projecao_entradas WHERE mes = '2027-05'")).toEqual({ valor_centavos: 0 });
    await api("PUT", url, { mes: "2027-05", valor: "" });
    expect(await contar("projecao_entradas")).toBe(0);
    expect(await api("PUT", url, { mes: "2027-05", valor: "-1" })).toEqual(erro("A entrada prevista não pode ser negativa"));
    expect(await api("PUT", url, { mes: "2027-13", valor: "1" })).toEqual(erro("Mês inválido em mes: use AAAA-MM"));
  });
});

describe("cenários", () => {
  beforeEach(async () => {
    await semearProjecao(env.DB);
  });

  it("criar usa a próxima ordem; nome repetido (sem diferenciar caixa) devolve 400", async () => {
    expect((await api("POST", "/api/projecao/cenarios", { nome: "Casamento" })).corpo).toEqual({ ok: true, id: 3 });
    expect(await linha("SELECT ordem FROM cenarios WHERE id = 3")).toEqual({ ordem: 2 });
    expect(await api("POST", "/api/projecao/cenarios", { nome: "notebook NOVO" })).toEqual(erro("Já existe o cenário 'notebook NOVO'"));
    expect(await api("POST", "/api/projecao/cenarios", { nome: " " })).toEqual(erro("Campo obrigatório: nome"));
  });

  it("renomear; inexistente e nome repetido devolvem 400; manter o próprio nome vale", async () => {
    expect((await api("PUT", "/api/projecao/cenarios/2", { nome: "Férias" })).corpo).toEqual({ ok: true, id: 2 });
    expect((await api("PUT", "/api/projecao/cenarios/2", { nome: "Férias" })).status).toBe(200);
    expect(await api("PUT", "/api/projecao/cenarios/999", { nome: "X" })).toEqual(erro("Cenário não encontrado"));
    expect(await api("PUT", "/api/projecao/cenarios/2", { nome: "Notebook novo" })).toEqual(erro("Já existe o cenário 'Notebook novo'"));
  });

  it("apagar leva as contas e os ajustes do cenário, mas não os gerais", async () => {
    expect((await api("DELETE", "/api/projecao/cenarios/1", {})).status).toBe(200);
    expect(await contar("cenarios", "id = 1")).toBe(0);
    expect(await contar("projecao_contas", "cenario_id = 1")).toBe(0);
    expect(await contar("projecao_ajustes", "cenario_id = 1")).toBe(0);
    expect(await contar("projecao_contas", "cenario_id IS NULL")).toBe(1);
    expect(await contar("projecao_ajustes", "cenario_id IS NULL")).toBe(2);
    expect(await contar("projecao_contas", "cenario_id = 2")).toBe(2);
  });

  it("duplicar copia contas e ajustes com ids novos e acha um nome livre", async () => {
    const r = await api("POST", "/api/projecao/cenarios/1/duplicar", {});
    expect(r.corpo).toEqual({ ok: true, id: 3 });
    expect(await linha("SELECT nome, ordem FROM cenarios WHERE id = 3")).toEqual({ nome: "Cópia de Notebook novo", ordem: 2 });
    expect(await linhas("SELECT descricao, total_centavos, n_parcelas, primeira_parcela FROM projecao_contas WHERE cenario_id = 3 ORDER BY id")).toEqual(
      await linhas("SELECT descricao, total_centavos, n_parcelas, primeira_parcela FROM projecao_contas WHERE cenario_id = 1 ORDER BY id"),
    );
    const copia = await linhas("SELECT tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem FROM projecao_ajustes WHERE cenario_id = 3 ORDER BY id");
    expect(copia).toEqual(await linhas("SELECT tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem FROM projecao_ajustes WHERE cenario_id = 1 ORDER BY id"));
    expect(copia).toHaveLength(2);
    // a cópia não mexe nos originais
    expect(await contar("projecao_contas", "cenario_id = 1")).toBe(2);
    expect(await contar("projecao_ajustes", "cenario_id = 1")).toBe(2);

    expect((await api("POST", "/api/projecao/cenarios/1/duplicar", {})).corpo.id).toBe(4);
    expect(await linha("SELECT nome FROM cenarios WHERE id = 4")).toEqual({ nome: "Cópia de Notebook novo 2" });
    expect(await api("POST", "/api/projecao/cenarios/999/duplicar", {})).toEqual(erro("Cenário não encontrado"));
  });
});

describe("contas de projeção", () => {
  const conta = { descricao: "Fogão", valor: "1200,00", n_parcelas: 6, primeira_parcela: "2027-03" };

  beforeEach(async () => {
    await semearProjecao(env.DB);
  });

  it("criar várias de uma vez devolve a lista de ids, num cenário ou em todos", async () => {
    const r = await api("POST", "/api/projecao/contas", { cenario_id: 1, contas: [conta, { ...conta, descricao: "Mesa", n_parcelas: "3" }] });
    expect(r.corpo).toEqual({ ok: true, id: [6, 7] });
    expect(await linha("SELECT cenario_id, total_centavos, n_parcelas FROM projecao_contas WHERE id = 7")).toEqual({ cenario_id: 1, total_centavos: 120000, n_parcelas: 3 });
    const geral = await api("POST", "/api/projecao/contas", { contas: [conta] });
    expect(geral.corpo.id).toEqual([8]);
    expect(await linha("SELECT cenario_id FROM projecao_contas WHERE id = 8")).toEqual({ cenario_id: null });
  });

  it("valida tudo antes de gravar qualquer uma", async () => {
    const antes = await contar("projecao_contas");
    const casos: [object, string][] = [
      [{ cenario_id: 999, contas: [conta] }, "Cenário não encontrado"],
      [{ contas: [] }, "Inclua pelo menos uma conta"],
      [{}, "Inclua pelo menos uma conta"],
      [{ contas: "x" }, "Inclua pelo menos uma conta"],
      [{ contas: [conta, { ...conta, valor: "0" }] }, "Valor deve ser maior que zero"],
      [{ contas: [conta, { ...conta, valor: "-5" }] }, "Valor deve ser maior que zero"],
      [{ contas: [conta, { ...conta, valor: "xyz" }] }, "Valor inválido: 'xyz'"],
      [{ contas: [{ ...conta, n_parcelas: 0 }] }, "Número de parcelas deve ser um inteiro, pelo menos 1"],
      [{ contas: [{ ...conta, n_parcelas: "2,5" }] }, "Número de parcelas deve ser um inteiro, pelo menos 1"],
      [{ contas: [{ ...conta, n_parcelas: true }] }, "Número de parcelas deve ser um inteiro, pelo menos 1"],
      [{ contas: [{ ...conta, n_parcelas: 601 }] }, "Número de parcelas deve ser no máximo 600"],
      [{ contas: [{ ...conta, valor: "0,01", n_parcelas: 3 }] }, "Valor total pequeno demais para esse número de parcelas"],
      [{ contas: [conta, { ...conta, descricao: "" }] }, "Campo obrigatório: descricao"],
      [{ contas: [conta, { ...conta, primeira_parcela: "2027-13" }] }, "Mês inválido em primeira_parcela: use AAAA-MM"],
      [{ contas: [conta, "texto"] }, "Conta inválida"],
    ];
    for (const [corpo, mensagem] of casos) {
      expect(await api("POST", "/api/projecao/contas", corpo), mensagem).toEqual(erro(mensagem));
    }
    expect(await contar("projecao_contas")).toBe(antes);
  });

  it("editar, editar inexistente e apagar", async () => {
    expect((await api("PUT", "/api/projecao/contas/1", { ...conta, descricao: "Notebook II" })).corpo).toEqual({ ok: true, id: 1 });
    expect(await linha("SELECT descricao, n_parcelas, primeira_parcela FROM projecao_contas WHERE id = 1")).toEqual({ descricao: "Notebook II", n_parcelas: 6, primeira_parcela: "2027-03" });
    expect(await api("PUT", "/api/projecao/contas/999", conta)).toEqual(erro("Conta não encontrada"));
    expect(await api("PUT", "/api/projecao/contas/1", { ...conta, valor: "0" })).toEqual(erro("Valor deve ser maior que zero"));
    expect((await api("DELETE", "/api/projecao/contas/1", {})).status).toBe(200);
    expect(await contar("projecao_contas", "id = 1")).toBe(0);
  });
});

describe("ajustes de projeção", () => {
  const ajuste = { tipo: "rec", ref_id: 2, valor: "0", mes_inicio: "2027-04", mes_fim: "2027-06", escopo: "geral" };

  beforeEach(async () => {
    await semearProjecao(env.DB);
  });

  it("criar geral e de cenário; a ordem é sempre a maior + 1", async () => {
    const a = await api("POST", "/api/projecao/ajustes", ajuste);
    expect(a.corpo).toEqual({ ok: true, id: 6 });
    expect(await linha("SELECT cenario_id, valor_centavos, ordem FROM projecao_ajustes WHERE id = 6")).toEqual({ cenario_id: null, valor_centavos: 0, ordem: 6 });
    const b = await api("POST", "/api/projecao/ajustes", { ...ajuste, tipo: "parc", ref_id: 1, valor: "99,90", mes_fim: null, escopo: "cenario", cenario_id: 2 });
    expect(b.corpo.id).toBe(7);
    expect(await linha("SELECT cenario_id, tipo, valor_centavos, mes_fim, ordem FROM projecao_ajustes WHERE id = 7")).toEqual({ cenario_id: 2, tipo: "parc", valor_centavos: 9990, mes_fim: null, ordem: 7 });
  });

  it("valida na ordem do Python e não grava", async () => {
    const antes = await contar("projecao_ajustes");
    const casos: [object, string][] = [
      [{ ...ajuste, tipo: "xx" }, "Tipo inválido: use rec ou parc"],
      [{ ...ajuste, ref_id: 999 }, "Despesa não encontrada"],
      [{ ...ajuste, ref_id: "2" }, "Despesa não encontrada"],
      [{ ...ajuste, ref_id: true }, "Despesa não encontrada"],
      [{ ...ajuste, tipo: "parc", ref_id: 6 }, "Despesa não encontrada"], // 6 é uma recorrência, não um parcelamento
      [{ ...ajuste, valor: undefined }, "Campo obrigatório: valor"],
      [{ ...ajuste, valor: "xyz" }, "Valor inválido: 'xyz'"],
      [{ ...ajuste, valor: "-1" }, "Valor não pode ser negativo"],
      [{ ...ajuste, valor: "0,004" }, "Valor pequeno demais: abaixo de um centavo (use 0 para cancelar)"],
      [{ ...ajuste, valor: "1e11" }, "Valor grande demais"],
      [{ ...ajuste, mes_inicio: "2027-13" }, "Mês inválido em mes_inicio: use AAAA-MM"],
      [{ ...ajuste, mes_fim: "2027-03" }, "O mês final não pode ser anterior ao inicial"],
      [{ ...ajuste, escopo: "outro" }, "Escopo inválido: use geral ou cenario"],
      [{ ...ajuste, escopo: undefined }, "Escopo inválido: use geral ou cenario"],
      [{ ...ajuste, escopo: "cenario" }, "Cenário não encontrado"],
      [{ ...ajuste, escopo: "cenario", cenario_id: 999 }, "Cenário não encontrado"],
      [{ ...ajuste, escopo: "cenario", cenario_id: "1" }, "Cenário não encontrado"],
    ];
    for (const [corpo, mensagem] of casos) {
      expect(await api("POST", "/api/projecao/ajustes", corpo), mensagem).toEqual(erro(mensagem));
    }
    expect(await contar("projecao_ajustes")).toBe(antes);
  });

  it("zero é um valor válido (pausa), e vírgula decimal vale", async () => {
    expect((await api("POST", "/api/projecao/ajustes", { ...ajuste, valor: 0 })).status).toBe(200);
    expect((await api("POST", "/api/projecao/ajustes", { ...ajuste, valor: "0,00" })).status).toBe(200);
    expect((await api("POST", "/api/projecao/ajustes", { ...ajuste, valor: "0,01" })).status).toBe(200);
  });

  it("apagar", async () => {
    expect((await api("DELETE", "/api/projecao/ajustes/3", {})).status).toBe(200);
    expect(await contar("projecao_ajustes", "id = 3")).toBe(0);
  });

  describe("desfazer um mês", () => {
    const desfazer = (id: number, mes: string) => api("POST", `/api/projecao/ajustes/${id}/desfazer-mes`, { mes });
    const intervalo = (id: number) => linha("SELECT mes_inicio, mes_fim FROM projecao_ajustes WHERE id = ?", id);

    it("de um ajuste de um mês só, apaga o ajuste", async () => {
      await env.DB.prepare("UPDATE projecao_ajustes SET mes_inicio = '2027-01', mes_fim = '2027-01' WHERE id = 2").run();
      expect((await desfazer(2, "2027-01")).status).toBe(200);
      expect(await contar("projecao_ajustes", "id = 2")).toBe(0);
    });

    it("no primeiro mês, encurta o começo", async () => {
      await desfazer(2, "2027-01"); // ajuste 2: 2027-01 a 2027-03
      expect(await intervalo(2)).toEqual({ mes_inicio: "2027-02", mes_fim: "2027-03" });
    });

    it("no último mês, encurta o fim", async () => {
      await desfazer(2, "2027-03");
      expect(await intervalo(2)).toEqual({ mes_inicio: "2027-01", mes_fim: "2027-02" });
    });

    it("no meio, divide em dois com os mesmos dados e a mesma ordem", async () => {
      expect((await desfazer(2, "2027-02")).status).toBe(200);
      expect(await intervalo(2)).toEqual({ mes_inicio: "2027-01", mes_fim: "2027-01" });
      expect(await linha("SELECT cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem FROM projecao_ajustes WHERE id = 6")).toEqual({
        cenario_id: 1, tipo: "rec", ref_id: 2, mes_inicio: "2027-03", mes_fim: "2027-03", valor_centavos: 0, ordem: 2,
      });
    });

    it("num ajuste sem fim, no meio, a metade nova continua sem fim", async () => {
      await desfazer(5, "2027-06"); // ajuste 5: de 2027-02 em diante
      expect(await intervalo(5)).toEqual({ mes_inicio: "2027-02", mes_fim: "2027-05" });
      expect(await linha("SELECT mes_inicio, mes_fim FROM projecao_ajustes WHERE id = 6")).toEqual({ mes_inicio: "2027-07", mes_fim: null });
    });

    it("mês fora do ajuste, ajuste inexistente e mês inválido devolvem 400", async () => {
      expect(await desfazer(2, "2027-04")).toEqual(erro("Esse mês não está no ajuste"));
      expect(await desfazer(2, "2026-12")).toEqual(erro("Esse mês não está no ajuste"));
      expect(await desfazer(999, "2027-02")).toEqual(erro("Ajuste não encontrado"));
      expect(await desfazer(2, "2027-13")).toEqual(erro("Mês inválido em mes: use AAAA-MM"));
      expect(await intervalo(2)).toEqual({ mes_inicio: "2027-01", mes_fim: "2027-03" });
    });
  });
});
