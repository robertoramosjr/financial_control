import sql from "../golden/semente.sql?raw";
import sqlProjecao from "../golden/semente-projecao.sql?raw";

// Mesma ordem de scripts/gerar_golden.py (ORDEM_TABELAS): pais antes dos filhos.
const TABELAS = [
  "categorias",
  "fontes_renda",
  "provisoes",
  "provisao_meses",
  "recorrencias",
  "parcelamentos",
  "lancamentos",
  "pagamentos",
  "entradas",
  "projecao_entradas",
  "cenarios",
  "projecao_contas",
  "projecao_ajustes",
];

/** Troca o conteúdo do D1 de teste pelos dados inventados de tests/golden/semente.sql (sem dados de projeção). */
export async function semear(db: D1Database): Promise<void> {
  await db.batch([...TABELAS].reverse().map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.exec(sql);
}

/** Acrescenta os dados de projeção (cenários, contas, ajustes, entradas digitadas) por cima de semear(). */
export async function semearProjecao(db: D1Database): Promise<void> {
  await db.exec(sqlProjecao);
}
