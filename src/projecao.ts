// Projeções, cenários, contas previstas e ajustes, portados de app.py (seção "projeções").
// A projeção carrega tudo numa única db.batch e calcula em memória (limite de consultas do D1 gratuito).
import { ehErroDoBanco, existe, paraBanco } from "./cadastros";
import { consultasDados, montarDados, montarVisaoMes, numeroParcela } from "./mes";
import {
  ErroEntrada,
  MAX_AJUSTE_CENTAVOS,
  arredonda2,
  centavos,
  exigir,
  exigirMes,
  mesIdx,
  reais,
  repr,
  somarMeses,
} from "./util";

type Corpo = Record<string, any>;
type Linha = Record<string, any>;

export const MAX_PARCELAS_PROJECAO = 600;

/** Parcela arredondada ao centavo mais próximo (meio sobe). Em BigInt para ficar exata com totais enormes. */
export function parcelaCentavos(totalCentavos: number, n: number): number {
  return Number((BigInt(totalCentavos) * 2n + BigInt(n)) / (2n * BigInt(n)));
}

function contaProjetada(r: Linha, meses: string[]) {
  const parcela = parcelaCentavos(r.total_centavos, r.n_parcelas);
  const valores = meses.map((m) => {
    const k = numeroParcela(r.primeira_parcela, m);
    return k >= 1 && k <= r.n_parcelas ? reais(parcela) : 0;
  });
  return {
    id: r.id,
    descricao: r.descricao,
    total: reais(r.total_centavos),
    n_parcelas: r.n_parcelas,
    primeira_parcela: r.primeira_parcela,
    valores,
  };
}

/** Ajuste que vale para a despesa no mês: o do cenário vence o geral; no mesmo nível, o de maior ordem. */
function ajusteVigente(ajustes: Linha[], tipo: string, refId: number, mes: string, cenarioId: number | null): Linha | null {
  const candidatos = ajustes.filter(
    (a) =>
      a.tipo === tipo &&
      a.ref_id === refId &&
      a.mes_inicio <= mes &&
      (a.mes_fim === null || mes <= a.mes_fim) &&
      (a.cenario_id === null || a.cenario_id === cenarioId),
  );
  // max() do Python sobre a tupla (é de cenário?, ordem, id): compara na ordem, o primeiro que difere decide.
  const chave = (a: Linha) => [a.cenario_id !== null ? 1 : 0, a.ordem, a.id];
  const vence = (a: Linha, b: Linha) => {
    const [x, y] = [chave(a), chave(b)];
    const i = x.findIndex((v, k) => v !== y[k]);
    return i >= 0 && x[i] > y[i];
  };
  let melhor: Linha | null = null;
  for (const a of candidatos) if (melhor === null || vence(a, melhor)) melhor = a;
  return melhor;
}

const escopoDe = (a: Linha) => (a.cenario_id !== null ? "cenario" : "geral");

export const MAX_MESES_PROJECAO = 60;

/** [início, nº de meses] a partir de ?de=AAAA-MM&ate=AAAA-MM; o lado que faltar é completado
 *  (sem "de": mês atual; sem "ate": 12 meses a partir do "de"). */
export function periodoDaProjecao(q: Corpo, hoje: string): [string, number] {
  const de = exigirMes(q, "de", true) ?? hoje;
  const ate = exigirMes(q, "ate", true) ?? somarMeses(de, 11);
  const n = mesIdx(ate) - mesIdx(de) + 1;
  if (n < 1) throw new ErroEntrada("O mês final deve ser igual ou posterior ao inicial");
  if (n > MAX_MESES_PROJECAO) throw new ErroEntrada(`O período deve ter no máximo ${MAX_MESES_PROJECAO} meses`);
  return [de, n];
}

/** Projeta `nMeses` a partir de `inicio`. `hoje` (mês atual de verdade) decide como as provisões entram;
 *  por padrão é o próprio início. */
export async function projecao(db: D1Database, inicio: string, nMeses = 12, hoje: string = inicio) {
  const meses = Array.from({ length: nMeses }, (_, i) => somarMeses(inicio, i));
  const resultados = await db.batch<Linha>([
    ...consultasDados(db, inicio, meses[nMeses - 1]),
    db.prepare("SELECT * FROM projecao_ajustes ORDER BY id"),
    db.prepare("SELECT mes, valor_centavos FROM projecao_entradas"),
    db.prepare("SELECT * FROM projecao_contas ORDER BY id"),
    db.prepare("SELECT id, nome FROM cenarios ORDER BY ordem, id"),
  ]);
  const dados = montarDados(resultados.slice(0, 8));
  const ajustes = resultados[8].results;
  const digitadas = new Map<string, number>(resultados[9].results.map((r) => [r.mes, r.valor_centavos]));
  const todas = resultados[10].results;
  const cenariosDb = resultados[11].results;

  const vms = meses.map((m) => montarVisaoMes(dados, m, hoje));
  const visoes = vms.map((v) => v.totais);
  const entradas = meses.map((m, i) => {
    if (digitadas.has(m)) return { valor: reais(digitadas.get(m)!), origem: "digitada" };
    if (visoes[i].entradas) return { valor: visoes[i].entradas, origem: "real" };
    return { valor: 0, origem: "vazia" };
  });
  const base = {
    recorrencias: visoes.map((t) => t.recorrencias),
    parcelas: visoes.map((t) => t.parcelas),
    avulsos: visoes.map((t) => t.avulsos),
    provisoes: visoes.map((t) => t.provisoes),
  };
  const previstas = todas.filter((r) => r.cenario_id === null).map((r) => contaProjetada(r, meses));

  /** Itens (recorrências e parcelas) de cada mês, com o ajuste vigente aplicado. */
  const itensDoCenario = (cid: number | null) =>
    meses.map((m, i) =>
      [...vms[i].recorrencias, ...vms[i].parcelas].map((it: Linha) => {
        const a = ajusteVigente(ajustes, it.tipo, it.id, m, cid);
        // o que passaria a valer neste mês se o ajuste vigente fosse desfeito
        const b = a ? ajusteVigente(ajustes.filter((x) => x.id !== a.id), it.tipo, it.id, m, cid) : null;
        return {
          tipo: it.tipo,
          id: it.id,
          descricao: it.descricao,
          parcela: it.parcela ?? null,
          n_parcelas: it.n_parcelas ?? null,
          original: it.valor,
          valor: a ? reais(a.valor_centavos) : it.valor,
          ajuste: a ? { id: a.id, escopo: escopoDe(a), mes_inicio: a.mes_inicio, mes_fim: a.mes_fim } : null,
          ajuste_abaixo: b ? { id: b.id, escopo: escopoDe(b), valor: reais(b.valor_centavos) } : null,
        };
      }),
    );

  const resultado = (cid: number | null, nome: string, contas: ReturnType<typeof contaProjetada>[]) => {
    const itens = itensDoCenario(cid);
    const soma = (i: number, tipo: string) => arredonda2(itens[i].filter((x) => x.tipo === tipo).reduce((s, x) => s + x.valor, 0));
    const baseC = {
      recorrencias: meses.map((_, i) => soma(i, "rec")),
      parcelas: meses.map((_, i) => soma(i, "parc")),
    };
    const extras = meses.map((_, i) => [...previstas, ...contas].reduce((s, c) => s + c.valores[i], 0));

    const serie = (rec: number[], parc: number[]) => {
      const despesas = meses.map((_, i) => arredonda2(rec[i] + parc[i] + base.avulsos[i] + base.provisoes[i] + extras[i]));
      const saldo = meses.map((_, i) => arredonda2(entradas[i].valor - despesas[i]));
      const comp = meses.map((_, i) => (entradas[i].valor ? despesas[i] / entradas[i].valor : null));
      return { despesas, saldo, comp };
    };

    const { despesas, saldo, comp } = serie(baseC.recorrencias, baseC.parcelas);
    const sem = serie(base.recorrencias, base.parcelas);
    let total = 0;
    const acumulado = saldo.map((s) => (total = arredonda2(total + s)));
    let pior = 0;
    saldo.forEach((s, i) => {
      if (s < saldo[pior]) pior = i;
    });
    return {
      id: cid,
      nome,
      contas,
      base: baseC,
      itens,
      despesas,
      saldo,
      acumulado,
      comprometimento: comp,
      sem_ajustes: { despesas: sem.despesas, saldo: sem.saldo, comprometimento: sem.comp },
      pior_mes: { mes: meses[pior], saldo: saldo[pior] },
    };
  };

  const cenarios = [resultado(null, "Sem a compra", [])];
  for (const c of cenariosDb) {
    const contas = todas.filter((r) => r.cenario_id === c.id).map((r) => contaProjetada(r, meses));
    cenarios.push(resultado(c.id, c.nome, contas));
  }
  return { inicio, meses, entradas, base, previstas, cenarios };
}

// ---------------------------------------------------------------- entrada prevista

/** Apaga tudo que é hipotético na aba Projeções; os dados consolidados não são tocados. */
export async function resetarProjecoes(db: D1Database): Promise<void> {
  await db.batch(
    ["projecao_ajustes", "projecao_contas", "cenarios", "projecao_entradas"].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
}

export async function salvarEntradaProjetada(db: D1Database, d: Corpo): Promise<void> {
  const mes = exigirMes(d, "mes") as string;
  const valor = d.valor;
  if (valor === null || valor === undefined || valor === "") {
    await db.prepare("DELETE FROM projecao_entradas WHERE mes = ?").bind(mes).run();
    return;
  }
  const c = centavos(valor);
  if (c < 0) throw new ErroEntrada("A entrada prevista não pode ser negativa");
  await db
    .prepare(
      `INSERT INTO projecao_entradas (mes, valor_centavos) VALUES (?, ?)
       ON CONFLICT (mes) DO UPDATE SET valor_centavos = excluded.valor_centavos`,
    )
    .bind(mes, c)
    .run();
}

// ---------------------------------------------------------------- cenários

export async function salvarCenario(db: D1Database, d: Corpo, cid?: number): Promise<number> {
  const nome = exigir(d, "nome") as string;
  try {
    if (cid === undefined) {
      const r = await db
        .prepare("INSERT INTO cenarios (nome, ordem) SELECT ?, COALESCE(MAX(ordem), -1) + 1 FROM cenarios")
        .bind(nome)
        .run();
      return r.meta.last_row_id;
    }
    const r = await db.prepare("UPDATE cenarios SET nome = ? WHERE id = ?").bind(nome, cid).run();
    if (r.meta.changes === 0) throw new ErroEntrada("Cenário não encontrado");
    return cid;
  } catch (e) {
    if (ehErroDoBanco(e, "UNIQUE constraint failed")) throw new ErroEntrada(`Já existe o cenário ${repr(nome)}`);
    throw e;
  }
}

export async function duplicarCenario(db: D1Database, cid: number, _d: Corpo): Promise<number> {
  const orig = await db.prepare("SELECT nome FROM cenarios WHERE id = ?").bind(cid).first<{ nome: string }>();
  if (!orig) throw new ErroEntrada("Cenário não encontrado");
  let nome = `Cópia de ${orig.nome}`;
  for (let n = 2; await db.prepare("SELECT 1 FROM cenarios WHERE nome = ?").bind(nome).first(); n++) {
    nome = `Cópia de ${orig.nome} ${n}`;
  }
  // O nome é único, então serve para achar o cenário novo (last_insert_rowid() mudaria a cada linha copiada).
  const novo = "(SELECT id FROM cenarios WHERE nome = ?)";
  try {
    const resultados = await db.batch([
      db.prepare("INSERT INTO cenarios (nome, ordem) SELECT ?, COALESCE(MAX(ordem), -1) + 1 FROM cenarios").bind(nome),
      db
        .prepare(
          `INSERT INTO projecao_contas (cenario_id, descricao, total_centavos, n_parcelas, primeira_parcela)
           SELECT ${novo}, descricao, total_centavos, n_parcelas, primeira_parcela
           FROM projecao_contas WHERE cenario_id = ? ORDER BY id`,
        )
        .bind(nome, cid),
      db
        .prepare(
          `INSERT INTO projecao_ajustes (cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem)
           SELECT ${novo}, tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem
           FROM projecao_ajustes WHERE cenario_id = ? ORDER BY id`,
        )
        .bind(nome, cid),
    ]);
    return resultados[0].meta.last_row_id;
  } catch (e) {
    if (ehErroDoBanco(e, "UNIQUE constraint failed")) throw new ErroEntrada(`Já existe o cenário ${repr(nome)}`);
    throw e;
  }
}

// ---------------------------------------------------------------- contas previstas

interface CamposConta {
  descricao: string;
  total: number;
  n: number;
  primeira: string;
}

function dadosContaProjecao(d: Corpo): CamposConta {
  if (d === null || typeof d !== "object" || Array.isArray(d)) throw new ErroEntrada("Conta inválida");
  const total = centavos(exigir(d, "valor"));
  if (total <= 0) throw new ErroEntrada("Valor deve ser maior que zero");
  let n = d.n_parcelas;
  if (typeof n === "string" && /^\s*\d+\s*$/.test(n)) n = Number(n);
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new ErroEntrada("Número de parcelas deve ser um inteiro, pelo menos 1");
  }
  if (n > MAX_PARCELAS_PROJECAO) {
    throw new ErroEntrada(`Número de parcelas deve ser no máximo ${MAX_PARCELAS_PROJECAO}`);
  }
  if (parcelaCentavos(total, n) === 0) throw new ErroEntrada("Valor total pequeno demais para esse número de parcelas");
  return { descricao: exigir(d, "descricao"), total, n, primeira: exigirMes(d, "primeira_parcela") as string };
}

export async function salvarContasProjecao(db: D1Database, d: Corpo): Promise<number[]> {
  const cid = d.cenario_id;
  if (cid !== null && cid !== undefined && !(await existe(db, "cenarios", cid))) {
    throw new ErroEntrada("Cenário não encontrado");
  }
  const contas = d.contas;
  if (!Array.isArray(contas) || contas.length === 0) throw new ErroEntrada("Inclua pelo menos uma conta");
  const campos = contas.map(dadosContaProjecao); // valida tudo antes de gravar qualquer uma
  const resultados = await db.batch(
    campos.map((c) =>
      db
        .prepare(
          `INSERT INTO projecao_contas (cenario_id, descricao, total_centavos, n_parcelas, primeira_parcela)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(paraBanco(cid), c.descricao, c.total, c.n, c.primeira),
    ),
  );
  return resultados.map((r) => r.meta.last_row_id);
}

export async function salvarContaProjecao(db: D1Database, d: Corpo, contaId: number): Promise<number> {
  const c = dadosContaProjecao(d);
  const r = await db
    .prepare("UPDATE projecao_contas SET descricao=?, total_centavos=?, n_parcelas=?, primeira_parcela=? WHERE id = ?")
    .bind(c.descricao, c.total, c.n, c.primeira, contaId)
    .run();
  if (r.meta.changes === 0) throw new ErroEntrada("Conta não encontrada");
  return contaId;
}

// ---------------------------------------------------------------- ajustes

const ehInteiro = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export async function salvarAjuste(db: D1Database, d: Corpo): Promise<number> {
  const tipo = d.tipo;
  const tabela = tipo === "rec" ? "recorrencias" : tipo === "parc" ? "parcelamentos" : null;
  if (tabela === null) throw new ErroEntrada("Tipo inválido: use rec ou parc");
  const refId = d.ref_id;
  if (!ehInteiro(refId) || !(await existe(db, tabela, refId))) throw new ErroEntrada("Despesa não encontrada");
  const valor = centavos(exigir(d, "valor"));
  if (valor < 0) throw new ErroEntrada("Valor não pode ser negativo");
  if (valor === 0 && Number(String(d.valor).replace(",", ".").replaceAll("_", "")) !== 0) {
    throw new ErroEntrada("Valor pequeno demais: abaixo de um centavo (use 0 para cancelar)");
  }
  if (valor > MAX_AJUSTE_CENTAVOS) throw new ErroEntrada("Valor grande demais");
  const inicio = exigirMes(d, "mes_inicio") as string;
  const fim = exigirMes(d, "mes_fim", true);
  if (fim !== null && fim < inicio) throw new ErroEntrada("O mês final não pode ser anterior ao inicial");
  let cid: number | null;
  if (d.escopo === "geral") {
    cid = null;
  } else if (d.escopo === "cenario") {
    cid = d.cenario_id;
    if (!ehInteiro(cid) || !(await existe(db, "cenarios", cid))) throw new ErroEntrada("Cenário não encontrado");
  } else {
    throw new ErroEntrada("Escopo inválido: use geral ou cenario");
  }
  const r = await db
    .prepare(
      `INSERT INTO projecao_ajustes (cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem)
       SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(ordem), 0) + 1 FROM projecao_ajustes`,
    )
    .bind(cid, tipo, refId, inicio, fim, valor)
    .run();
  return r.meta.last_row_id;
}

/** Tira um mês do ajuste: apaga, encurta uma ponta ou divide em dois. */
export async function desfazerMesAjuste(db: D1Database, ajusteId: number, d: Corpo): Promise<void> {
  const mes = exigirMes(d, "mes") as string;
  const a = await db.prepare("SELECT * FROM projecao_ajustes WHERE id = ?").bind(ajusteId).first<Linha>();
  if (!a) throw new ErroEntrada("Ajuste não encontrado");
  const { mes_inicio: ini, mes_fim: fim } = a;
  if (mes < ini || (fim !== null && mes > fim)) throw new ErroEntrada("Esse mês não está no ajuste");
  if (mes === ini && mes === fim) {
    await db.prepare("DELETE FROM projecao_ajustes WHERE id = ?").bind(ajusteId).run();
  } else if (mes === ini) {
    await db.prepare("UPDATE projecao_ajustes SET mes_inicio = ? WHERE id = ?").bind(somarMeses(mes, 1), ajusteId).run();
  } else if (mes === fim) {
    await db.prepare("UPDATE projecao_ajustes SET mes_fim = ? WHERE id = ?").bind(somarMeses(mes, -1), ajusteId).run();
  } else {
    await db.batch([
      db.prepare("UPDATE projecao_ajustes SET mes_fim = ? WHERE id = ?").bind(somarMeses(mes, -1), ajusteId),
      db
        .prepare(
          `INSERT INTO projecao_ajustes (cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(a.cenario_id, a.tipo, a.ref_id, somarMeses(mes, 1), fim, a.valor_centavos, a.ordem),
    ]);
  }
}
