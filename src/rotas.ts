// Tabela de rotas de dados, espelho de ROTAS em app.py: [método, padrão, função(db, id ou null, corpo)].
// O padrão inteiro é ancorado; o primeiro grupo capturado vira o `id` da função.
import {
  apagar,
  apagarCategoria,
  apagarProvisao,
  entradasAno,
  listarCategorias,
  listarParcelamentos,
  listarProvisoes,
  listarRecorrencias,
  marcarPago,
  salvarCategoria,
  salvarEntrada,
  salvarFonte,
  salvarLancamento,
  salvarParcelamento,
  salvarProvisao,
  salvarRecorrencia,
  salvarValorMesProvisao,
} from "./cadastros";
import { resumoAno, visaoMes } from "./mes";
import { exigirMes } from "./util";

export type Rota = [metodo: string, padrao: RegExp, fn: (db: D1Database, id: string | null, corpo: any) => Promise<any>];

const num = (id: string | null) => Number(id);

export const ROTAS: Rota[] = [
  ["GET", /^\/api\/mes\/(\d{4}-\d{2})$/, (db, m) => visaoMes(db, exigirMes({ m }, "m") as string)],
  ["GET", /^\/api\/resumo\/(\d{4})$/, (db, a) => resumoAno(db, num(a))],
  ["POST", /^\/api\/pago$/, (db, _, d) => marcarPago(db, d)],

  ["GET", /^\/api\/categorias$/, (db) => listarCategorias(db)],
  ["POST", /^\/api\/categorias$/, (db, _, d) => salvarCategoria(db, d)],
  ["PUT", /^\/api\/categorias\/(\d+)$/, (db, i, d) => salvarCategoria(db, d, num(i))],
  ["DELETE", /^\/api\/categorias\/(\d+)$/, (db, i, d) => apagarCategoria(db, num(i), d)],

  ["GET", /^\/api\/recorrencias$/, (db) => listarRecorrencias(db)],
  ["POST", /^\/api\/recorrencias$/, (db, _, d) => salvarRecorrencia(db, d)],
  ["PUT", /^\/api\/recorrencias\/(\d+)$/, (db, i, d) => salvarRecorrencia(db, d, num(i))],
  ["DELETE", /^\/api\/recorrencias\/(\d+)$/, (db, i) => apagar(db, "recorrencias", num(i), "rec")],

  ["GET", /^\/api\/parcelamentos$/, (db) => listarParcelamentos(db)],
  ["POST", /^\/api\/parcelamentos$/, (db, _, d) => salvarParcelamento(db, d)],
  ["PUT", /^\/api\/parcelamentos\/(\d+)$/, (db, i, d) => salvarParcelamento(db, d, num(i))],
  ["DELETE", /^\/api\/parcelamentos\/(\d+)$/, (db, i) => apagar(db, "parcelamentos", num(i), "parc")],

  ["POST", /^\/api\/lancamentos$/, (db, _, d) => salvarLancamento(db, d)],
  ["PUT", /^\/api\/lancamentos\/(\d+)$/, (db, i, d) => salvarLancamento(db, d, num(i))],
  ["DELETE", /^\/api\/lancamentos\/(\d+)$/, (db, i) => apagar(db, "lancamentos", num(i))],

  ["GET", /^\/api\/provisoes$/, (db) => listarProvisoes(db)],
  ["POST", /^\/api\/provisoes$/, (db, _, d) => salvarProvisao(db, d)],
  ["PUT", /^\/api\/provisoes\/(\d+)$/, (db, i, d) => salvarProvisao(db, d, num(i))],
  ["DELETE", /^\/api\/provisoes\/(\d+)$/, (db, i) => apagarProvisao(db, num(i))],
  ["PUT", /^\/api\/provisoes\/(\d+)\/meses$/, (db, i, d) => salvarValorMesProvisao(db, num(i), d)],

  ["GET", /^\/api\/entradas\/(\d{4})$/, (db, a) => entradasAno(db, num(a))],
  ["PUT", /^\/api\/entradas$/, (db, _, d) => salvarEntrada(db, d)],

  ["POST", /^\/api\/fontes$/, (db, _, d) => salvarFonte(db, d)],
  ["PUT", /^\/api\/fontes\/(\d+)$/, (db, i, d) => salvarFonte(db, d, num(i))],
  ["DELETE", /^\/api\/fontes\/(\d+)$/, (db, i) => apagar(db, "fontes_renda", num(i))],
  // As rotas /api/projecao/* entram na Task 6.
];
