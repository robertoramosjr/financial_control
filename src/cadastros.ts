// Cadastros (categorias, recorrências, parcelamentos, lançamentos, provisões, pagamentos, entradas e fontes),
// portados de app.py (seção "cadastros"). Onde o Python fazia vários passos numa transação só, aqui eles vão
// juntos em db.batch (que também é uma transação).
import { mesAtual, numeroParcela } from "./mes";
import {
  ErroEntrada,
  MAX_AJUSTE_CENTAVOS,
  centavos,
  exigir,
  exigirCategoria,
  exigirData,
  exigirMes,
  repr,
  reais,
  somarMeses,
} from "./util";

type Corpo = Record<string, any>;
type Linha = Record<string, any>;

// ---------------------------------------------------------------- ajudantes

/** Verdadeiro como no Python: vazio, zero, false e null são falsos (inclusive [] e {}). */
const verdadeiro = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v);

/** Valor aceito pelo banco: undefined vira null, booleano vira 0/1, o resto que não é número ou texto é recusado. */
export function paraBanco(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  throw new ErroEntrada(`Valor inválido: ${repr(v)}`);
}

/** int() do Python para um valor que veio do cliente; o que não é inteiro vira erro 400. */
function inteiro(v: unknown): number {
  return exigir({ v }, "v", "number");
}

export function ehErroDoBanco(e: unknown, trecho: string): boolean {
  const mensagens = [(e as Error)?.message, ((e as Error)?.cause as Error | undefined)?.message];
  return mensagens.some((m) => typeof m === "string" && m.includes(trecho));
}

export async function existe(
  db: D1Database,
  tabela: "provisoes" | "categorias" | "cenarios" | "recorrencias" | "parcelamentos",
  id: unknown,
): Promise<boolean> {
  return (await db.prepare(`SELECT 1 FROM ${tabela} WHERE id = ?`).bind(paraBanco(id)).first()) !== null;
}

// ---------------------------------------------------------------- recorrências

export async function listarRecorrencias(db: D1Database, hoje: string = mesAtual()) {
  const { results } = await db
    .prepare(
      `SELECT r.*, c.nome AS categoria FROM recorrencias r
       JOIN categorias c ON c.id = r.categoria_id
       ORDER BY (r.fim IS NOT NULL AND r.fim < ?), r.descricao COLLATE NOCASE`,
    )
    .bind(hoje)
    .all<Linha>();
  return results.map((r) => ({
    id: r.id,
    descricao: r.descricao,
    dia: r.dia,
    valor: reais(r.valor_centavos),
    categoria_id: r.categoria_id,
    categoria: r.categoria,
    inicio: r.inicio,
    fim: r.fim,
    ativa: r.inicio <= hoje && (r.fim === null || r.fim >= hoje),
  }));
}

async function dadosRecorrencia(db: D1Database, d: Corpo) {
  const dia = exigir(d, "dia", "number") as number;
  if (!(dia >= 1 && dia <= 31)) throw new ErroEntrada("Dia deve estar entre 1 e 31");
  const inicio = exigirMes(d, "inicio") as string;
  const fim = exigirMes(d, "fim", true);
  if (fim && fim < inicio) throw new ErroEntrada("O mês final não pode ser antes do inicial");
  const descricao = exigir(d, "descricao") as string;
  const valor = centavos(exigir(d, "valor"));
  const categoria = await exigirCategoria(db, d);
  return { descricao, dia, valor, categoria, inicio, fim };
}

const INSERIR_RECORRENCIA =
  "INSERT INTO recorrencias (descricao, dia, valor_centavos, categoria_id, inicio, fim) VALUES (?, ?, ?, ?, ?, ?)";

export async function salvarRecorrencia(db: D1Database, d: Corpo, rid?: number): Promise<number> {
  const c = await dadosRecorrencia(db, d);
  if (rid === undefined) {
    const r = await db.prepare(INSERIR_RECORRENCIA).bind(c.descricao, c.dia, c.valor, c.categoria, c.inicio, c.fim).run();
    return r.meta.last_row_id;
  }
  const atual = await db.prepare("SELECT * FROM recorrencias WHERE id = ?").bind(rid).first<Linha>();
  if (!atual) throw new ErroEntrada("Recorrência não encontrada");
  const aPartir = exigirMes(d, "a_partir_de", true);
  const mudouConteudo =
    c.descricao !== atual.descricao || c.dia !== atual.dia || c.valor !== atual.valor_centavos || c.categoria !== atual.categoria_id;
  if (mudouConteudo && aPartir && aPartir > atual.inicio) {
    // Mudança vale só daqui pra frente: encerra a versão antiga no mês anterior e cria uma nova,
    // levando junto as marcações de "pago" futuras (last_insert_rowid() é o id da versão nova).
    const resultados = await db.batch([
      db.prepare("UPDATE recorrencias SET fim = ? WHERE id = ?").bind(somarMeses(aPartir, -1), rid),
      db.prepare(INSERIR_RECORRENCIA).bind(c.descricao, c.dia, c.valor, c.categoria, aPartir, c.fim),
      db.prepare("UPDATE pagamentos SET ref_id = last_insert_rowid() WHERE tipo = 'rec' AND ref_id = ? AND mes >= ?").bind(rid, aPartir),
    ]);
    return resultados[1].meta.last_row_id;
  }
  await db
    .prepare("UPDATE recorrencias SET descricao=?, dia=?, valor_centavos=?, categoria_id=?, inicio=?, fim=? WHERE id = ?")
    .bind(c.descricao, c.dia, c.valor, c.categoria, c.inicio, c.fim, rid)
    .run();
  return rid;
}

// ---------------------------------------------------------------- parcelamentos

export async function listarParcelamentos(db: D1Database, hoje: string = mesAtual()) {
  const { results } = await db
    .prepare(
      `SELECT pa.*, c.nome AS categoria FROM parcelamentos pa
       JOIN categorias c ON c.id = pa.categoria_id`,
    )
    .all<Linha>();
  const ordem: Record<string, number> = { em_andamento: 0, a_comecar: 1, quitado: 2 };
  const lista = results.map((r) => {
    const n: number = r.n_parcelas;
    const v: number = r.valor_parcela_centavos;
    const k = numeroParcela(r.primeira_parcela, hoje);
    const restantes = n - Math.max(0, Math.min(k, n)); // parcelas depois deste mês
    return {
      id: r.id,
      descricao: r.descricao,
      primeira_parcela: r.primeira_parcela,
      valor: reais(v),
      n_parcelas: n,
      categoria_id: r.categoria_id,
      categoria: r.categoria,
      ultimo_mes: somarMeses(r.primeira_parcela.slice(0, 7), n - 1),
      parcela_atual: k >= 1 && k <= n ? k : null,
      situacao: k < 1 ? "a_comecar" : k > n ? "quitado" : "em_andamento",
      valor_total: reais(v * n),
      restante_apos_mes: reais(v * restantes),
    };
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return lista.sort(
    (a, b) =>
      ordem[a.situacao] - ordem[b.situacao] ||
      cmp(a.ultimo_mes, b.ultimo_mes) ||
      cmp(a.descricao.toLowerCase(), b.descricao.toLowerCase()),
  );
}

export async function salvarParcelamento(db: D1Database, d: Corpo, pid?: number): Promise<number> {
  const n = exigir(d, "n_parcelas", "number") as number;
  if (n < 1) throw new ErroEntrada("Número de parcelas deve ser pelo menos 1");
  const descricao = exigir(d, "descricao") as string;
  const primeira = exigirData(d, "primeira_parcela") as string;
  const valor = centavos(exigir(d, "valor"));
  const categoria = await exigirCategoria(db, d);
  if (pid === undefined) {
    const r = await db
      .prepare(
        `INSERT INTO parcelamentos (descricao, primeira_parcela, valor_parcela_centavos, n_parcelas, categoria_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(descricao, primeira, valor, n, categoria)
      .run();
    return r.meta.last_row_id;
  }
  await db
    .prepare(
      `UPDATE parcelamentos SET descricao=?, primeira_parcela=?, valor_parcela_centavos=?, n_parcelas=?, categoria_id=?
       WHERE id = ?`,
    )
    .bind(descricao, primeira, valor, n, categoria, pid)
    .run();
  return pid;
}

// ---------------------------------------------------------------- lançamentos

async function exigirProvisao(db: D1Database, d: Corpo): Promise<number | null> {
  const pid = d.provisao_id;
  if (pid === null || pid === undefined) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || !(await existe(db, "provisoes", pid))) {
    throw new ErroEntrada("Provisão não encontrada");
  }
  return pid;
}

export async function salvarLancamento(db: D1Database, d: Corpo, lid?: number): Promise<number> {
  const mes = exigirMes(d, "mes") as string;
  const descricao = exigir(d, "descricao") as string;
  const data = exigirData(d, "data", true);
  const valor = centavos(exigir(d, "valor"));
  const categoria = await exigirCategoria(db, d);
  const pago = verdadeiro(d.pago) ? 1 : 0;
  const provisao = await exigirProvisao(db, d);
  if (lid === undefined) {
    const r = await db
      .prepare(
        `INSERT INTO lancamentos (mes, descricao, data, valor_centavos, categoria_id, pago, provisao_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(mes, descricao, data, valor, categoria, pago, provisao)
      .run();
    return r.meta.last_row_id;
  }
  await db
    .prepare(
      `UPDATE lancamentos SET mes=?, descricao=?, data=?, valor_centavos=?, categoria_id=?, pago=?, provisao_id=?
       WHERE id = ?`,
    )
    .bind(mes, descricao, data, valor, categoria, pago, provisao, lid)
    .run();
  return lid;
}

// ---------------------------------------------------------------- provisões

export async function listarProvisoes(db: D1Database, hoje: string = mesAtual()) {
  const { results } = await db
    .prepare(
      `SELECT p.*, c.nome AS categoria FROM provisoes p
       JOIN categorias c ON c.id = p.categoria_id
       ORDER BY (p.fim IS NOT NULL AND p.fim < ?), p.descricao COLLATE NOCASE`,
    )
    .bind(hoje)
    .all<Linha>();
  return results.map((r) => ({
    id: r.id,
    descricao: r.descricao,
    valor: reais(r.valor_centavos),
    categoria_id: r.categoria_id,
    categoria: r.categoria,
    inicio: r.inicio,
    fim: r.fim,
    ativa: r.inicio <= hoje && (r.fim === null || r.fim >= hoje),
  }));
}

export function valorProvisao(v: unknown): number {
  const c = centavos(v);
  if (c < 0) throw new ErroEntrada("Valor não pode ser negativo");
  if (c > MAX_AJUSTE_CENTAVOS) throw new ErroEntrada("Valor grande demais");
  return c;
}

export async function salvarProvisao(db: D1Database, d: Corpo, pid?: number): Promise<number> {
  const inicio = exigirMes(d, "inicio") as string;
  const fim = exigirMes(d, "fim", true);
  if (fim && fim < inicio) throw new ErroEntrada("O mês final não pode ser antes do inicial");
  const descricao = exigir(d, "descricao") as string;
  const categoria = await exigirCategoria(db, d);
  const valor = valorProvisao(exigir(d, "valor"));
  if (pid === undefined) {
    const r = await db
      .prepare("INSERT INTO provisoes (descricao, categoria_id, valor_centavos, inicio, fim) VALUES (?, ?, ?, ?, ?)")
      .bind(descricao, categoria, valor, inicio, fim)
      .run();
    return r.meta.last_row_id;
  }
  const r = await db
    .prepare("UPDATE provisoes SET descricao=?, categoria_id=?, valor_centavos=?, inicio=?, fim=? WHERE id = ?")
    .bind(descricao, categoria, valor, inicio, fim, pid)
    .run();
  if (r.meta.changes === 0) throw new ErroEntrada("Provisão não encontrada");
  return pid;
}

export async function salvarValorMesProvisao(db: D1Database, pid: number, d: Corpo): Promise<void> {
  const mes = exigirMes(d, "mes") as string;
  const valor = d.valor;
  if (!(await existe(db, "provisoes", pid))) throw new ErroEntrada("Provisão não encontrada");
  if (valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "")) {
    await db.prepare("DELETE FROM provisao_meses WHERE provisao_id = ? AND mes = ?").bind(pid, mes).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO provisao_meses (provisao_id, mes, valor_centavos) VALUES (?, ?, ?)
       ON CONFLICT (provisao_id, mes) DO UPDATE SET valor_centavos = excluded.valor_centavos`,
    )
    .bind(pid, mes, valorProvisao(valor))
    .run();
}

export async function apagarProvisao(db: D1Database, pid: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE lancamentos SET provisao_id = NULL WHERE provisao_id = ?").bind(pid),
    db.prepare("DELETE FROM provisao_meses WHERE provisao_id = ?").bind(pid),
    db.prepare("DELETE FROM provisoes WHERE id = ?").bind(pid),
  ]);
}

// ---------------------------------------------------------------- pagamentos

export async function marcarPago(db: D1Database, d: Corpo): Promise<void> {
  const tipo = d.tipo;
  const ref = paraBanco(d.id);
  const mes = exigirMes(d, "mes") as string;
  if (tipo === "avulso") {
    await db.prepare("UPDATE lancamentos SET pago = ? WHERE id = ?").bind(verdadeiro(d.pago) ? 1 : 0, ref).run();
  } else if (tipo === "rec" || tipo === "parc") {
    if (verdadeiro(d.pago)) {
      await db.prepare("INSERT OR IGNORE INTO pagamentos (tipo, ref_id, mes) VALUES (?, ?, ?)").bind(tipo, ref, mes).run();
    } else {
      await db.prepare("DELETE FROM pagamentos WHERE tipo = ? AND ref_id = ? AND mes = ?").bind(tipo, ref, mes).run();
    }
  } else {
    throw new ErroEntrada("Tipo inválido");
  }
}

// ---------------------------------------------------------------- categorias

export async function listarCategorias(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.nome, c.ordem,
         (SELECT COUNT(*) FROM recorrencias WHERE categoria_id = c.id)
       + (SELECT COUNT(*) FROM parcelamentos WHERE categoria_id = c.id)
       + (SELECT COUNT(*) FROM lancamentos WHERE categoria_id = c.id)
       + (SELECT COUNT(*) FROM provisoes WHERE categoria_id = c.id) AS usos
       FROM categorias c ORDER BY c.ordem, c.nome`,
    )
    .all<Linha>();
  return results;
}

export async function salvarCategoria(db: D1Database, d: Corpo, cid?: number): Promise<number> {
  const nome = exigir(d, "nome") as string;
  try {
    if (cid === undefined) {
      const r = await db
        .prepare("INSERT INTO categorias (nome, ordem) SELECT ?, COALESCE(MAX(ordem), -1) + 1 FROM categorias")
        .bind(nome)
        .run();
      return r.meta.last_row_id;
    }
    await db.prepare("UPDATE categorias SET nome = ? WHERE id = ?").bind(nome, cid).run();
    return cid;
  } catch (e) {
    if (ehErroDoBanco(e, "UNIQUE constraint failed")) throw new ErroEntrada(`Já existe a categoria ${repr(nome)}`);
    throw e;
  }
}

export async function apagarCategoria(db: D1Database, cid: number, d: Corpo): Promise<void> {
  const passos: D1PreparedStatement[] = [];
  if (verdadeiro(d.mover_para)) {
    const destino = inteiro(d.mover_para);
    if (destino === cid) throw new ErroEntrada("Escolha outra categoria para receber os itens");
    // O Python deixava uma categoria de destino inexistente virar erro 500; aqui vira 400.
    if (!(await existe(db, "categorias", destino))) throw new ErroEntrada("Escolha uma categoria válida");
    for (const tabela of ["recorrencias", "parcelamentos", "lancamentos", "provisoes"]) {
      passos.push(db.prepare(`UPDATE ${tabela} SET categoria_id = ? WHERE categoria_id = ?`).bind(destino, cid));
    }
  }
  passos.push(db.prepare("DELETE FROM categorias WHERE id = ?").bind(cid));
  try {
    await db.batch(passos); // tudo ou nada: se a exclusão falhar, nada foi movido
  } catch (e) {
    if (ehErroDoBanco(e, "FOREIGN KEY constraint failed")) {
      throw new ErroEntrada("Categoria em uso: escolha para qual categoria mover os itens");
    }
    throw e;
  }
}

// ---------------------------------------------------------------- entradas e fontes de renda

export async function entradasAno(db: D1Database, ano: number) {
  const [fontesRes, entradasRes] = await db.batch<Linha>([
    db.prepare("SELECT id, nome FROM fontes_renda ORDER BY ordem, nome"),
    db
      .prepare("SELECT fonte_id, mes, valor_centavos FROM entradas WHERE mes LIKE ?")
      .bind(`${String(ano).padStart(4, "0")}-%`),
  ]);
  const valores = new Map<number, (number | null)[]>(fontesRes.results.map((f) => [f.id, Array(12).fill(null)]));
  for (const r of entradasRes.results) {
    valores.get(r.fonte_id)![Number(r.mes.slice(5)) - 1] = reais(r.valor_centavos);
  }
  return { ano, fontes: fontesRes.results.map((f) => ({ ...f, valores: valores.get(f.id) })) };
}

export async function salvarEntrada(db: D1Database, d: Corpo): Promise<void> {
  const mes = exigirMes(d, "mes") as string;
  const fonte = paraBanco(d.fonte_id);
  const valor = d.valor;
  if (valor === null || valor === undefined || valor === "") {
    await db.prepare("DELETE FROM entradas WHERE fonte_id = ? AND mes = ?").bind(fonte, mes).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO entradas (fonte_id, mes, valor_centavos) VALUES (?, ?, ?)
       ON CONFLICT (fonte_id, mes) DO UPDATE SET valor_centavos = excluded.valor_centavos`,
    )
    .bind(fonte, mes, centavos(valor))
    .run();
}

export async function salvarFonte(db: D1Database, d: Corpo, fid?: number): Promise<number> {
  const nome = exigir(d, "nome") as string;
  try {
    if (fid === undefined) {
      const r = await db
        .prepare("INSERT INTO fontes_renda (nome, ordem) SELECT ?, COALESCE(MAX(ordem), -1) + 1 FROM fontes_renda")
        .bind(nome)
        .run();
      return r.meta.last_row_id;
    }
    await db.prepare("UPDATE fontes_renda SET nome = ? WHERE id = ?").bind(nome, fid).run();
    return fid;
  } catch (e) {
    if (ehErroDoBanco(e, "UNIQUE constraint failed")) throw new ErroEntrada(`Já existe a fonte ${repr(nome)}`);
    throw e;
  }
}

// ---------------------------------------------------------------- apagar

/** Tabelas que as rotas DELETE podem apagar. O nome nunca vem da requisição. */
const APAGAVEIS = [
  "recorrencias",
  "parcelamentos",
  "lancamentos",
  "cenarios",
  "projecao_contas",
  "projecao_ajustes",
  "fontes_renda",
] as const;
type Apagavel = (typeof APAGAVEIS)[number];

/** Apaga por id; para recorrência e parcela, leva junto os "pago" e os ajustes de projeção dela. */
export async function apagar(db: D1Database, tabela: Apagavel, id: number, tipoPag?: "rec" | "parc"): Promise<void> {
  if (!APAGAVEIS.includes(tabela)) throw new Error(`Tabela não permitida: ${tabela}`);
  const passos = [db.prepare(`DELETE FROM ${tabela} WHERE id = ?`).bind(id)];
  if (tipoPag) {
    passos.push(
      db.prepare("DELETE FROM pagamentos WHERE tipo = ? AND ref_id = ?").bind(tipoPag, id),
      db.prepare("DELETE FROM projecao_ajustes WHERE tipo = ? AND ref_id = ?").bind(tipoPag, id),
    );
  }
  await db.batch(passos);
}
