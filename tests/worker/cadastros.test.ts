import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entradasAno, listarCategorias, listarParcelamentos, listarProvisoes, listarRecorrencias } from "../../src/cadastros";
import { chamar, entrar } from "./ajuda";
import { semear } from "./semente";

const HOJE = "2026-11";
const golden = (nome: string) => (goldenArquivos as Record<string, any>)[`../golden/${nome}.json`];
const goldenArquivos = import.meta.glob("../golden/*.json", { eager: true, import: "default" });

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

async function contar(tabela: string, onde = "1 = 1", ...valores: unknown[]): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabela} WHERE ${onde}`).bind(...valores).first<{ n: number }>();
  return r!.n;
}

const linha = <T = any>(sql: string, ...valores: unknown[]) => env.DB.prepare(sql).bind(...valores).first<T>();

describe("listagens iguais às do Python", () => {
  it("categorias", async () => expect(await listarCategorias(env.DB)).toEqual(golden("lista-categorias")));
  it("recorrências", async () => expect(await listarRecorrencias(env.DB, HOJE)).toEqual(golden("lista-recorrencias")));
  it("parcelamentos", async () => expect(await listarParcelamentos(env.DB, HOJE)).toEqual(golden("lista-parcelamentos")));
  it("provisões", async () => expect(await listarProvisoes(env.DB, HOJE)).toEqual(golden("lista-provisoes")));
  it("entradas de 2026 e 2027", async () => {
    expect(await entradasAno(env.DB, 2026)).toEqual(golden("entradas-2026"));
    expect(await entradasAno(env.DB, 2027)).toEqual(golden("entradas-2027"));
  });
  it("as listagens respondem pelas rotas GET", async () => {
    for (const rota of ["categorias", "recorrencias", "parcelamentos", "provisoes", "entradas/2026"]) {
      const r = await api("GET", `/api/${rota}`);
      expect(r.status, rota).toBe(200);
    }
  });
});

describe("recorrências", () => {
  const nova = { descricao: "Luz", dia: 10, valor: "150,50", categoria_id: 1, inicio: "2026-01" };

  it("criar devolve {ok, id} e a recorrência aparece na listagem", async () => {
    const r = await api("POST", "/api/recorrencias", nova);
    expect(r).toEqual({ status: 200, corpo: { ok: true, id: 7 } });
    const lista = (await api("GET", "/api/recorrencias")).corpo;
    expect(lista.find((x: any) => x.id === 7)).toMatchObject({ descricao: "Luz", dia: 10, valor: 150.5, fim: null });
  });

  it("valida na ordem do Python e não grava nada", async () => {
    const antes = await contar("recorrencias");
    const casos: [object, string][] = [
      [{ ...nova, dia: undefined }, "Campo obrigatório: dia"],
      [{ ...nova, dia: 32 }, "Dia deve estar entre 1 e 31"],
      [{ ...nova, dia: 0 }, "Dia deve estar entre 1 e 31"],
      [{ ...nova, inicio: "2026-13" }, "Mês inválido em inicio: use AAAA-MM"],
      [{ ...nova, fim: "2025-12" }, "O mês final não pode ser antes do inicial"],
      [{ ...nova, valor: "xyz" }, "Valor inválido: 'xyz'"],
      [{ ...nova, categoria_id: 999 }, "Escolha uma categoria válida"],
      [{ ...nova, descricao: "  " }, "Campo obrigatório: descricao"],
      [{ ...nova, dia: 40, descricao: "" }, "Dia deve estar entre 1 e 31"], // dia vem antes de descricao
    ];
    for (const [corpo, erro] of casos) {
      expect(await api("POST", "/api/recorrencias", corpo), erro).toEqual({ status: 400, corpo: { erro } });
    }
    expect(await contar("recorrencias")).toBe(antes);
  });

  it("editar uma inexistente devolve 400", async () => {
    expect(await api("PUT", "/api/recorrencias/999", nova)).toEqual({ status: 400, corpo: { erro: "Recorrência não encontrada" } });
  });

  it("editar sem a_partir_de muda no lugar e devolve o mesmo id", async () => {
    const r = await api("PUT", "/api/recorrencias/1", { ...nova, descricao: "Aluguel novo", valor: 1600, inicio: "2026-01" });
    expect(r.corpo).toEqual({ ok: true, id: 1 });
    expect(await linha("SELECT descricao, valor_centavos FROM recorrencias WHERE id = 1")).toEqual({ descricao: "Aluguel novo", valor_centavos: 160000 });
    expect(await contar("recorrencias")).toBe(6);
  });

  it("editar com a_partir_de encerra a versão antiga, cria a nova e leva os 'pago' do futuro", async () => {
    const corpo = { descricao: "Aluguel", dia: 5, valor: 1800, categoria_id: 1, inicio: "2026-01", a_partir_de: "2026-11" };
    const r = await api("PUT", "/api/recorrencias/1", corpo);
    expect(r.status).toBe(200);
    expect(r.corpo.id).toBe(7);
    expect(await linha("SELECT fim FROM recorrencias WHERE id = 1")).toEqual({ fim: "2026-10" });
    expect(await linha("SELECT inicio, fim, valor_centavos FROM recorrencias WHERE id = 7")).toEqual({
      inicio: "2026-11",
      fim: null,
      valor_centavos: 180000,
    });
    // 'pago' de 2026-10 fica na versão antiga; o de 2026-11 vai para a nova
    const pagos = await env.DB.prepare("SELECT ref_id, mes FROM pagamentos WHERE tipo = 'rec' AND ref_id IN (1, 7) ORDER BY mes").all();
    expect(pagos.results).toEqual([
      { ref_id: 1, mes: "2026-10" },
      { ref_id: 7, mes: "2026-11" },
    ]);
  });

  it("a_partir_de sem mudança de conteúdo não divide a recorrência", async () => {
    const corpo = { descricao: "Aluguel", dia: 5, valor: 1500, categoria_id: 1, inicio: "2026-01", a_partir_de: "2026-11" };
    expect((await api("PUT", "/api/recorrencias/1", corpo)).corpo).toEqual({ ok: true, id: 1 });
    expect(await contar("recorrencias")).toBe(6);
  });

  it("apagar remove também 'pago' e ajustes de projeção da recorrência", async () => {
    await env.DB.prepare(
      "INSERT INTO projecao_ajustes (cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos) VALUES (NULL, 'rec', 1, '2026-12', NULL, 0), (NULL, 'parc', 1, '2026-12', NULL, 0)",
    ).run();
    expect((await api("DELETE", "/api/recorrencias/1", {})).corpo).toEqual({ ok: true, id: null });
    expect(await contar("recorrencias", "id = 1")).toBe(0);
    expect(await contar("pagamentos", "tipo = 'rec' AND ref_id = 1")).toBe(0);
    expect(await contar("projecao_ajustes", "tipo = 'rec' AND ref_id = 1")).toBe(0);
    // o parcelamento 1 não foi tocado
    expect(await contar("projecao_ajustes", "tipo = 'parc' AND ref_id = 1")).toBe(1);
    expect(await contar("pagamentos", "tipo = 'parc' AND ref_id = 1")).toBe(1);
  });
});

describe("parcelamentos", () => {
  const novo = { descricao: "TV", primeira_parcela: "2026-12-10", valor: "200", n_parcelas: 5, categoria_id: 9 };

  it("criar, editar e apagar", async () => {
    expect((await api("POST", "/api/parcelamentos", novo)).corpo).toEqual({ ok: true, id: 5 });
    expect((await api("PUT", "/api/parcelamentos/5", { ...novo, n_parcelas: 6 })).corpo).toEqual({ ok: true, id: 5 });
    expect(await linha("SELECT n_parcelas, valor_parcela_centavos FROM parcelamentos WHERE id = 5")).toEqual({ n_parcelas: 6, valor_parcela_centavos: 20000 });
    await api("DELETE", "/api/parcelamentos/2", {});
    expect(await contar("parcelamentos", "id = 2")).toBe(0);
    expect(await contar("pagamentos", "tipo = 'parc' AND ref_id = 2")).toBe(0);
    expect(await contar("pagamentos", "tipo = 'rec'")).toBe(3);
  });

  it("valida na ordem do Python", async () => {
    const casos: [object, string][] = [
      [{ ...novo, n_parcelas: 0 }, "Número de parcelas deve ser pelo menos 1"],
      [{ ...novo, n_parcelas: "abc" }, "Valor inválido: 'abc'"],
      [{ ...novo, primeira_parcela: "2026-02-30" }, "Data inválida em primeira_parcela: 2026-02-30"],
      [{ ...novo, primeira_parcela: "2026-12" }, "Data inválida em primeira_parcela: use AAAA-MM-DD"],
      [{ ...novo, valor: "" }, "Campo obrigatório: valor"],
      [{ ...novo, categoria_id: 999 }, "Escolha uma categoria válida"],
    ];
    for (const [corpo, erro] of casos) {
      expect(await api("POST", "/api/parcelamentos", corpo), erro).toEqual({ status: 400, corpo: { erro } });
    }
    expect(await contar("parcelamentos")).toBe(4);
  });

  it("editar um id que não existe não dá erro (como no Python)", async () => {
    expect((await api("PUT", "/api/parcelamentos/999", novo)).corpo).toEqual({ ok: true, id: 999 });
    expect(await contar("parcelamentos")).toBe(4);
  });
});

describe("lançamentos", () => {
  const novo = { mes: "2026-12", descricao: "Jantar", valor: 150, categoria_id: 6, provisao_id: 1 };

  it("compra ligada à provisão desconta dela, e soltar a ligação devolve a reserva", async () => {
    const r = await api("POST", "/api/lancamentos", novo);
    expect(r.corpo).toEqual({ ok: true, id: 13 });
    const antes = (await api("GET", "/api/mes/2026-12")).corpo;
    const prov = antes.provisoes.find((p: any) => p.id === 1);
    expect(prov.gasto).toBe(350); // Show 200 (semente) + Jantar 150
    expect((await api("PUT", "/api/lancamentos/13", { ...novo, provisao_id: null })).status).toBe(200);
    expect((await api("GET", "/api/mes/2026-12")).corpo.provisoes.find((p: any) => p.id === 1).gasto).toBe(200);
    expect(await linha("SELECT provisao_id, pago, data FROM lancamentos WHERE id = 13")).toEqual({ provisao_id: null, pago: 0, data: null });
  });

  it("pago aceita qualquer valor verdadeiro do Python", async () => {
    await api("POST", "/api/lancamentos", { ...novo, provisao_id: undefined, pago: true });
    await api("POST", "/api/lancamentos", { ...novo, provisao_id: undefined, pago: "sim" });
    await api("POST", "/api/lancamentos", { ...novo, provisao_id: undefined, pago: 0 });
    await api("POST", "/api/lancamentos", { ...novo, provisao_id: undefined, pago: [] });
    const pagos = await env.DB.prepare("SELECT pago FROM lancamentos WHERE id > 12 ORDER BY id").all();
    expect(pagos.results.map((r: any) => r.pago)).toEqual([1, 1, 0, 0]);
  });

  it("provisão inexistente, em texto ou booleana devolve 400 e não grava", async () => {
    for (const provisao_id of [999, "1", true, 1.5]) {
      const r = await api("POST", "/api/lancamentos", { ...novo, provisao_id });
      expect(r, String(provisao_id)).toEqual({ status: 400, corpo: { erro: "Provisão não encontrada" } });
    }
    expect(await contar("lancamentos")).toBe(12);
  });

  it("valida mês, data, valor e categoria", async () => {
    const casos: [object, string][] = [
      [{ ...novo, mes: "2026-1" }, "Mês inválido em mes: use AAAA-MM"],
      [{ ...novo, data: "31/12/2026" }, "Data inválida em data: use AAAA-MM-DD"],
      [{ ...novo, valor: "xyz" }, "Valor inválido: 'xyz'"],
      [{ ...novo, categoria_id: 999 }, "Escolha uma categoria válida"],
    ];
    for (const [corpo, erro] of casos) {
      expect(await api("POST", "/api/lancamentos", corpo), erro).toEqual({ status: 400, corpo: { erro } });
    }
  });

  it("apagar", async () => {
    await api("DELETE", "/api/lancamentos/1", {});
    expect(await contar("lancamentos", "id = 1")).toBe(0);
    expect(await contar("lancamentos")).toBe(11);
  });
});

describe("provisões", () => {
  const nova = { descricao: "Roupas", categoria_id: 8, valor: "300", inicio: "2027-02", fim: "2027-12" };

  it("criar, editar e apagar", async () => {
    expect((await api("POST", "/api/provisoes", nova)).corpo).toEqual({ ok: true, id: 5 });
    expect((await api("PUT", "/api/provisoes/5", { ...nova, valor: "350" })).status).toBe(200);
    expect(await linha("SELECT valor_centavos FROM provisoes WHERE id = 5")).toEqual({ valor_centavos: 35000 });
    expect((await api("DELETE", "/api/provisoes/5", {})).status).toBe(200);
    expect(await contar("provisoes", "id = 5")).toBe(0);
  });

  it("editar uma inexistente devolve 400", async () => {
    expect(await api("PUT", "/api/provisoes/999", nova)).toEqual({ status: 400, corpo: { erro: "Provisão não encontrada" } });
  });

  it("valida e não grava", async () => {
    const casos: [object, string][] = [
      [{ ...nova, valor: "-1" }, "Valor não pode ser negativo"],
      [{ ...nova, valor: "inf" }, "Valor inválido: 'inf'"],
      [{ ...nova, valor: "abc" }, "Valor inválido: 'abc'"],
      [{ ...nova, valor: "1e11" }, "Valor grande demais"],
      [{ ...nova, fim: "2027-01" }, "O mês final não pode ser antes do inicial"],
      [{ ...nova, inicio: "2026-13" }, "Mês inválido em inicio: use AAAA-MM"],
      [{ ...nova, categoria_id: 999 }, "Escolha uma categoria válida"],
      [{ ...nova, descricao: "" }, "Campo obrigatório: descricao"],
    ];
    for (const [corpo, erro] of casos) {
      expect(await api("POST", "/api/provisoes", corpo), erro).toEqual({ status: 400, corpo: { erro } });
    }
    expect(await contar("provisoes")).toBe(4);
  });

  it("valor do mês: grava, troca e apaga, e só mexe naquele mês", async () => {
    const url = "/api/provisoes/2/meses"; // Mercado, 1200 por mês de 2026-05 a 2027-06
    const provisionado = async (mes: string) =>
      (await api("GET", `/api/mes/${mes}`)).corpo.provisoes.find((p: any) => p.id === 2).provisionado;
    expect((await api("PUT", url, { mes: "2027-03", valor: "1000" })).corpo).toEqual({ ok: true, id: null });
    expect(await provisionado("2027-03")).toBe(1000);
    expect(await provisionado("2027-04")).toBe(1200);
    await api("PUT", url, { mes: "2027-03", valor: "800" });
    expect(await provisionado("2027-03")).toBe(800);
    expect(await contar("provisao_meses", "provisao_id = 2")).toBe(1);
    await api("PUT", url, { mes: "2027-03", valor: "" });
    expect(await provisionado("2027-03")).toBe(1200);
    expect(await contar("provisao_meses", "provisao_id = 2")).toBe(0);
  });

  it("valor do mês: recusa mês ruim, valor negativo e provisão inexistente", async () => {
    expect((await api("PUT", "/api/provisoes/2/meses", { mes: "2026-13", valor: "5" })).corpo).toEqual({ erro: "Mês inválido em mes: use AAAA-MM" });
    expect((await api("PUT", "/api/provisoes/2/meses", { mes: "2027-03", valor: "-5" })).corpo).toEqual({ erro: "Valor não pode ser negativo" });
    expect((await api("PUT", "/api/provisoes/999/meses", { mes: "2027-03", valor: "5" })).corpo).toEqual({ erro: "Provisão não encontrada" });
    expect(await contar("provisao_meses")).toBe(3);
  });

  it("apagar mantém as compras (soltas da provisão) e leva os valores do mês", async () => {
    expect((await api("DELETE", "/api/provisoes/1", {})).status).toBe(200);
    expect(await contar("provisoes", "id = 1")).toBe(0);
    expect(await contar("provisao_meses", "provisao_id = 1")).toBe(0);
    expect(await contar("lancamentos", "provisao_id = 1")).toBe(0);
    expect(await contar("lancamentos")).toBe(12);
    expect(await contar("provisao_meses")).toBe(1); // a da Viagem fica
  });
});

describe("marcar como pago", () => {
  it("avulso alterna o pago do lançamento", async () => {
    await api("POST", "/api/pago", { tipo: "avulso", id: 4, mes: "2026-11", pago: true });
    expect(await linha("SELECT pago FROM lancamentos WHERE id = 4")).toEqual({ pago: 1 });
    await api("POST", "/api/pago", { tipo: "avulso", id: 4, mes: "2026-11", pago: false });
    expect(await linha("SELECT pago FROM lancamentos WHERE id = 4")).toEqual({ pago: 0 });
  });

  it("recorrência e parcela gravam e apagam em pagamentos, sem duplicar", async () => {
    const corpo = { tipo: "rec", id: 3, mes: "2026-08", pago: true };
    await api("POST", "/api/pago", corpo);
    await api("POST", "/api/pago", corpo);
    expect(await contar("pagamentos", "tipo = 'rec' AND ref_id = 3")).toBe(1);
    await api("POST", "/api/pago", { ...corpo, pago: false });
    expect(await contar("pagamentos", "tipo = 'rec' AND ref_id = 3")).toBe(0);
    await api("POST", "/api/pago", { tipo: "parc", id: 3, mes: "2026-11", pago: true });
    expect(await contar("pagamentos", "tipo = 'parc' AND ref_id = 3")).toBe(1);
  });

  it("tipo inválido e mês inválido (o mês é conferido primeiro)", async () => {
    expect((await api("POST", "/api/pago", { tipo: "xx", id: 1, mes: "2026-11" })).corpo).toEqual({ erro: "Tipo inválido" });
    expect((await api("POST", "/api/pago", { tipo: "xx", id: 1, mes: "2026-13" })).corpo).toEqual({ erro: "Mês inválido em mes: use AAAA-MM" });
  });
});

describe("categorias", () => {
  it("criar usa a próxima ordem; nome repetido devolve 400", async () => {
    expect((await api("POST", "/api/categorias", { nome: "Pets" })).corpo).toEqual({ ok: true, id: 10 });
    expect(await linha("SELECT ordem FROM categorias WHERE id = 10")).toEqual({ ordem: 9 });
    expect(await api("POST", "/api/categorias", { nome: "Moradia" })).toEqual({
      status: 400,
      corpo: { erro: "Já existe a categoria 'Moradia'" },
    });
    expect(await api("POST", "/api/categorias", { nome: "   " })).toEqual({ status: 400, corpo: { erro: "Campo obrigatório: nome" } });
  });

  it("renomear, e renomear para um nome que já existe devolve 400", async () => {
    expect((await api("PUT", "/api/categorias/3", { nome: "Carro" })).corpo).toEqual({ ok: true, id: 3 });
    expect(await linha("SELECT nome FROM categorias WHERE id = 3")).toEqual({ nome: "Carro" });
    expect((await api("PUT", "/api/categorias/3", { nome: "Lazer" })).corpo).toEqual({ erro: "Já existe a categoria 'Lazer'" });
  });

  it("apagar categoria em uso sem destino devolve 400 e não muda nada", async () => {
    const r = await api("DELETE", "/api/categorias/1", {});
    expect(r).toEqual({ status: 400, corpo: { erro: "Categoria em uso: escolha para qual categoria mover os itens" } });
    expect(await contar("categorias", "id = 1")).toBe(1);
  });

  it("apagar com mover_para leva os itens das quatro tabelas para a outra categoria", async () => {
    const usosAntes = (await listarCategorias(env.DB)).filter((c: any) => [1, 9].includes(c.id)).reduce((s: number, c: any) => s + c.usos, 0);
    expect((await api("DELETE", "/api/categorias/1", { mover_para: 9 })).status).toBe(200);
    expect(await contar("categorias", "id = 1")).toBe(0);
    for (const t of ["recorrencias", "parcelamentos", "lancamentos", "provisoes"]) {
      expect(await contar(t, "categoria_id = 1"), t).toBe(0);
    }
    const nove = (await listarCategorias(env.DB)).find((c: any) => c.id === 9);
    expect(nove!.usos).toBe(usosAntes);
  });

  it("mover_para igual à própria categoria, ou inexistente, devolve 400 e não muda nada", async () => {
    expect((await api("DELETE", "/api/categorias/1", { mover_para: 1 })).corpo).toEqual({ erro: "Escolha outra categoria para receber os itens" });
    expect((await api("DELETE", "/api/categorias/1", { mover_para: 999 })).corpo).toEqual({ erro: "Escolha uma categoria válida" });
    expect((await api("DELETE", "/api/categorias/1", { mover_para: "abc" })).status).toBe(400);
    expect(await contar("categorias", "id = 1")).toBe(1);
    expect(await contar("recorrencias", "categoria_id = 1")).toBe(3);
  });

  it("apagar categoria sem uso", async () => {
    expect((await api("DELETE", "/api/categorias/3", {})).status).toBe(200);
    expect(await contar("categorias", "id = 3")).toBe(0);
  });
});

describe("premissa de atomicidade", () => {
  it("db.batch desfaz os passos anteriores quando um passo viola uma chave estrangeira", async () => {
    const antes = await contar("parcelamentos", "categoria_id = 1");
    expect(antes).toBeGreaterThan(0);
    await expect(
      env.DB.batch([
        env.DB.prepare("UPDATE parcelamentos SET categoria_id = 9 WHERE categoria_id = 1"),
        env.DB.prepare("DELETE FROM categorias WHERE id = 1"), // ainda há recorrências nela
      ]),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(await contar("parcelamentos", "categoria_id = 1")).toBe(antes);
  });
});

describe("entradas e fontes de renda", () => {
  it("gravar, trocar e apagar o valor de um mês; zero é um valor", async () => {
    await api("PUT", "/api/entradas", { fonte_id: 2, mes: "2027-05", valor: "1.234,5" });
    expect((await api("PUT", "/api/entradas", { fonte_id: 2, mes: "2027-05", valor: "100,25" })).status).toBe(200);
    expect(await linha("SELECT valor_centavos FROM entradas WHERE fonte_id = 2 AND mes = '2027-05'")).toEqual({ valor_centavos: 10025 });
    await api("PUT", "/api/entradas", { fonte_id: 2, mes: "2027-05", valor: 0 });
    expect(await linha("SELECT valor_centavos FROM entradas WHERE fonte_id = 2 AND mes = '2027-05'")).toEqual({ valor_centavos: 0 });
    await api("PUT", "/api/entradas", { fonte_id: 2, mes: "2027-05", valor: "" });
    expect(await contar("entradas", "fonte_id = 2 AND mes = '2027-05'")).toBe(0);
  });

  it("valor ruim e mês ruim devolvem 400", async () => {
    expect((await api("PUT", "/api/entradas", { fonte_id: 2, mes: "2027-05", valor: "xyz" })).corpo).toEqual({ erro: "Valor inválido: 'xyz'" });
    expect((await api("PUT", "/api/entradas", { fonte_id: 2, mes: "2027-5", valor: "1" })).corpo).toEqual({ erro: "Mês inválido em mes: use AAAA-MM" });
  });

  it("fonte nova usa a próxima ordem; nome repetido devolve 400; renomear; apagar leva as entradas", async () => {
    expect((await api("POST", "/api/fontes", { nome: "Aluguel recebido" })).corpo).toEqual({ ok: true, id: 3 });
    expect(await linha("SELECT ordem FROM fontes_renda WHERE id = 3")).toEqual({ ordem: 2 });
    expect((await api("POST", "/api/fontes", { nome: "Extra" })).corpo).toEqual({ erro: "Já existe a fonte 'Extra'" });
    expect((await api("PUT", "/api/fontes/3", { nome: "Renda extra" })).corpo).toEqual({ ok: true, id: 3 });
    expect((await api("PUT", "/api/fontes/3", { nome: "Salário" })).corpo).toEqual({ erro: "Já existe a fonte 'Salário'" });
    expect((await api("DELETE", "/api/fontes/2", {})).status).toBe(200);
    expect(await contar("fontes_renda", "id = 2")).toBe(0);
    expect(await contar("entradas", "fonte_id = 2")).toBe(0);
    expect(await contar("entradas", "fonte_id = 1")).toBe(18);
  });
});
