// Tabela de rotas de dados, espelho de ROTAS em app.py: [método, padrão, função(db, id ou null, corpo)].
// O padrão inteiro é ancorado; o primeiro grupo capturado vira o `id` da função.
import { resumoAno, visaoMes } from "./mes";
import { exigirMes } from "./util";

export type Rota = [metodo: string, padrao: RegExp, fn: (db: D1Database, id: string | null, corpo: any) => Promise<any>];

export const ROTAS: Rota[] = [
  ["GET", /^\/api\/mes\/(\d{4}-\d{2})$/, (db, m) => visaoMes(db, exigirMes({ m }, "m") as string)],
  ["GET", /^\/api\/resumo\/(\d{4})$/, (db, a) => resumoAno(db, Number(a))],
];
