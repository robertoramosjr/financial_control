// Regras do mês e resumo anual, portadas de app.py (seção "regras do mês").
//
// O Python consultava o banco a cada pedaço; aqui as regras são funções puras sobre um retrato dos dados
// (`Dados`) carregado de uma vez, porque o plano gratuito do D1 limita as consultas por requisição (50) e
// o resumo anual precisaria de ~60. As respostas são iguais às do Python (tests/golden).
import { arredonda2, dataNoMes, mesIdx, reais } from "./util";

type Linha = Record<string, any>;
type Item = Record<string, any>;

export interface Dados {
  categorias: { id: number; nome: string }[]; // ordenadas por ordem, nome
  recorrencias: Linha[];
  parcelamentos: Linha[];
  provisoes: Linha[];
  provisaoMeses: Linha[];
  lancamentos: Linha[];
  pagamentos: Linha[];
  entradas: Linha[];
}

/** Mês corrente (AAAA-MM) no fuso de São Paulo. */
export function mesAtual(agora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" })
    .formatToParts(agora)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${partes.year}-${partes.month}`;
}

/** As 8 consultas de `carregarDados`, para quem quiser juntá-las a outras numa única db.batch. */
export function consultasDados(db: D1Database, de: string, ate: string): D1PreparedStatement[] {
  return [
    db.prepare("SELECT id, nome FROM categorias ORDER BY ordem, nome"),
    db.prepare("SELECT * FROM recorrencias ORDER BY id"),
    db.prepare("SELECT * FROM parcelamentos ORDER BY id"),
    db.prepare("SELECT * FROM provisoes ORDER BY id"),
    db.prepare("SELECT * FROM provisao_meses WHERE mes BETWEEN ? AND ?").bind(de, ate),
    db.prepare("SELECT * FROM lancamentos WHERE mes BETWEEN ? AND ? ORDER BY id").bind(de, ate),
    db.prepare("SELECT * FROM pagamentos WHERE mes BETWEEN ? AND ?").bind(de, ate),
    db.prepare("SELECT * FROM entradas WHERE mes BETWEEN ? AND ?").bind(de, ate),
  ];
}

/** Carrega o que as regras precisam para os meses de `de` a `ate` (AAAA-MM, inclusive), em poucas consultas. */
export async function carregarDados(db: D1Database, de: string, ate: string): Promise<Dados> {
  return montarDados(await db.batch<Linha>(consultasDados(db, de, ate)));
}

/** Monta o retrato a partir dos 8 resultados de `consultasDados`, na mesma ordem. */
export function montarDados(resultados: D1Result<Linha>[]): Dados {
  const [categorias, recorrencias, parcelamentos, provisoes, provisaoMeses, lancamentos, pagamentos, entradas] = resultados;
  return {
    categorias: categorias.results as Dados["categorias"],
    recorrencias: recorrencias.results,
    parcelamentos: parcelamentos.results,
    provisoes: provisoes.results,
    provisaoMeses: provisaoMeses.results,
    lancamentos: lancamentos.results,
    pagamentos: pagamentos.results,
    entradas: entradas.results,
  };
}

// ---------------------------------------------------------------- ordenação

/** Comparação por unidade de código, como o COLLATE BINARY do SQLite e o sort() do Python. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** COLLATE NOCASE do SQLite: só as letras ASCII são tratadas sem diferença de caixa. */
const nocase = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const nomeCategoria = (d: Dados, id: number) => d.categorias.find((c) => c.id === id)?.nome;
const pagou = (d: Dados, tipo: "rec" | "parc", id: number, mes: string) =>
  d.pagamentos.some((p) => p.tipo === tipo && p.ref_id === id && p.mes === mes);

// ---------------------------------------------------------------- regras do mês

export function recorrenciasDoMes(d: Dados, mes: string): Item[] {
  return d.recorrencias
    .filter((r) => r.inicio <= mes && (r.fim === null || r.fim >= mes))
    .sort((a, b) => a.dia - b.dia || cmp(a.descricao, b.descricao))
    .map((r) => ({
      tipo: "rec",
      id: r.id,
      descricao: r.descricao,
      data: dataNoMes(mes, r.dia),
      valor: reais(r.valor_centavos),
      categoria_id: r.categoria_id,
      categoria: nomeCategoria(d, r.categoria_id),
      pago: pagou(d, "rec", r.id, mes),
    }));
}

export function numeroParcela(primeira: string, mes: string): number {
  return mesIdx(mes) - mesIdx(primeira.slice(0, 7)) + 1;
}

export function parcelasDoMes(d: Dados, mes: string): Item[] {
  const saida: Item[] = [];
  for (const r of d.parcelamentos) {
    const k = numeroParcela(r.primeira_parcela, mes);
    if (k >= 1 && k <= r.n_parcelas) {
      saida.push({
        tipo: "parc",
        id: r.id,
        descricao: r.descricao,
        parcela: k,
        n_parcelas: r.n_parcelas,
        data: dataNoMes(mes, Number(r.primeira_parcela.slice(8, 10))),
        valor: reais(r.valor_parcela_centavos),
        categoria_id: r.categoria_id,
        categoria: nomeCategoria(d, r.categoria_id),
        pago: pagou(d, "parc", r.id, mes),
      });
    }
  }
  return saida.sort((a, b) => cmp(a.data, b.data) || cmp(a.descricao.toLowerCase(), b.descricao.toLowerCase()));
}

export function avulsosDoMes(d: Dados, mes: string): Item[] {
  // ORDER BY data, id: no SQLite o NULL vem antes de qualquer data.
  const porData = (a: Linha, b: Linha) =>
    a.data === b.data ? 0 : a.data === null ? -1 : b.data === null ? 1 : cmp(a.data, b.data);
  return d.lancamentos
    .filter((l) => l.mes === mes)
    .sort((a, b) => porData(a, b) || a.id - b.id)
    .map((l) => ({
      tipo: "avulso",
      id: l.id,
      descricao: l.descricao,
      data: l.data,
      valor: reais(l.valor_centavos),
      categoria_id: l.categoria_id,
      categoria: nomeCategoria(d, l.categoria_id),
      pago: Boolean(l.pago),
      provisao_id: l.provisao_id,
      provisao: d.provisoes.find((p) => p.id === l.provisao_id)?.descricao ?? null,
    }));
}

/**
 * Provisões vigentes no mês (ou com valor do mês nele). Contam só o disponível, e só em mês não terminado:
 * as compras ligadas já entram como avulsos.
 */
export function provisoesDoMes(d: Dados, mes: string, hoje: string): Item[] {
  return d.provisoes
    .map((pr) => ({ pr, vm: d.provisaoMeses.find((m) => m.provisao_id === pr.id && m.mes === mes) }))
    .filter(({ pr, vm }) => vm !== undefined || (pr.inicio <= mes && (pr.fim === null || pr.fim >= mes)))
    .sort((a, b) => cmp(nocase(a.pr.descricao), nocase(b.pr.descricao)) || a.pr.id - b.pr.id)
    .map(({ pr, vm }) => {
      const valorMes: number | null = vm ? vm.valor_centavos : null;
      const prov = valorMes !== null ? valorMes : pr.valor_centavos;
      const gasto = d.lancamentos
        .filter((l) => l.provisao_id === pr.id && l.mes === mes)
        .reduce((soma, l) => soma + l.valor_centavos, 0);
      const fechado = mes < hoje;
      const disponivel = Math.max(prov - gasto, 0);
      return {
        tipo: "prov",
        id: pr.id,
        descricao: pr.descricao,
        categoria_id: pr.categoria_id,
        categoria: nomeCategoria(d, pr.categoria_id),
        provisionado: reais(prov),
        valor_do_mes: valorMes !== null,
        gasto: reais(gasto),
        disponivel: reais(disponivel),
        estouro: reais(Math.max(gasto - prov, 0)),
        fechado,
        valor: fechado ? 0 : reais(disponivel),
      };
    });
}

export function entradasDoMes(d: Dados, mes: string): number {
  return reais(d.entradas.filter((e) => e.mes === mes).reduce((soma, e) => soma + e.valor_centavos, 0));
}

const total = (itens: Item[]) => arredonda2(itens.reduce((soma, i) => soma + i.valor, 0));

export function montarVisaoMes(d: Dados, mes: string, hoje: string) {
  const av = avulsosDoMes(d, mes);
  const rec = recorrenciasDoMes(d, mes);
  const parc = parcelasDoMes(d, mes);
  const prov = provisoesDoMes(d, mes, hoje);
  const todos = [...av, ...rec, ...parc];
  const porCat = new Map<string, number>();
  for (const i of [...todos, ...prov.filter((p) => p.valor)]) {
    porCat.set(i.categoria, arredonda2((porCat.get(i.categoria) ?? 0) + i.valor));
  }
  const despesas = total([...todos, ...prov]);
  const entradas = entradasDoMes(d, mes);
  return {
    mes,
    avulsos: av,
    provisoes: prov,
    recorrencias: rec,
    parcelas: parc,
    totais: {
      avulsos: total(av),
      provisoes: total(prov),
      recorrencias: total(rec),
      parcelas: total(parc),
      despesas,
      entradas,
      saldo: arredonda2(entradas - despesas),
      a_pagar: arredonda2(todos.filter((i) => !i.pago).reduce((soma, i) => soma + i.valor, 0) + total(prov)),
    },
    // Lista de pares [categoria, valor], do maior para o menor; empate mantém a ordem de aparição.
    por_categoria: [...porCat.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export async function visaoMes(db: D1Database, mes: string, hoje: string = mesAtual()) {
  return montarVisaoMes(await carregarDados(db, mes, mes), mes, hoje);
}

export async function resumoAno(db: D1Database, ano: number, hoje: string = mesAtual()) {
  const prefixo = String(ano).padStart(4, "0");
  const d = await carregarDados(db, `${prefixo}-01`, `${prefixo}-12`);
  const meses: Item[] = [];
  const matriz = new Map<string, number[]>(d.categorias.map((c) => [c.nome, Array(12).fill(0)]));
  let acumulado = 0;
  for (let m = 1; m <= 12; m++) {
    const v = montarVisaoMes(d, `${prefixo}-${String(m).padStart(2, "0")}`, hoje);
    acumulado = arredonda2(acumulado + v.totais.saldo);
    meses.push({
      mes: v.mes,
      despesas: v.totais.despesas,
      entradas: v.totais.entradas,
      saldo: v.totais.saldo,
      acumulado,
    });
    for (const [cat, valor] of v.por_categoria) {
      if (!matriz.has(cat)) matriz.set(cat, Array(12).fill(0));
      matriz.get(cat)![m - 1] = valor;
    }
  }
  return { ano, meses, categorias: [...matriz.entries()].map(([nome, valores]) => ({ nome, valores })) };
}
