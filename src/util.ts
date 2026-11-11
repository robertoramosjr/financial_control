// Utilidades e validação, portadas de app.py (centavos, meses, exigir*).
// As mensagens de erro são idênticas às do Python porque o frontend as mostra na tela.

export class ErroEntrada extends Error {}

type Corpo = Record<string, any>;

const LIMITE_CORPO = 1_000_000;

/** Lê o corpo como objeto JSON (vazio vira {}), com o limite de 1.000.000 de bytes do Python. */
export async function lerJson(req: Request): Promise<Corpo> {
  const grande = () => new ErroEntrada("Requisição grande demais");
  if (Number(req.headers.get("Content-Length") ?? 0) > LIMITE_CORPO) throw grande();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > LIMITE_CORPO) throw grande();
  if (bytes.byteLength === 0) return {};
  let dados: unknown;
  try {
    dados = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ErroEntrada("JSON inválido");
  }
  if (dados === null || typeof dados !== "object" || Array.isArray(dados)) throw new ErroEntrada("JSON inválido");
  return dados as Corpo;
}

/** Como o repr() do Python mostraria o valor (usado nas mensagens de erro). */
function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v < 0 ? "-inf" : "inf";
    return String(v);
  }
  if (typeof v === "string") {
    const aspas = v.includes("'") && !v.includes('"') ? '"' : "'";
    const corpo = v
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replaceAll(aspas, "\\" + aspas);
    return aspas + corpo + aspas;
  }
  return JSON.stringify(v);
}

/** round() do Python: empate vai para o inteiro par (0.5 → 0, 1.5 → 2, 2.5 → 2). Nunca devolve -0. */
function arredondar(x: number): number {
  const piso = Math.floor(x);
  const resto = x - piso;
  const r = resto < 0.5 ? piso : resto > 0.5 ? piso + 1 : piso % 2 === 0 ? piso : piso + 1;
  return r + 0;
}

// O que float() do Python aceita (sem inf/nan, que aqui são sempre inválidos); "_" só entre dígitos.
const FLOAT_RE = /^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/;

export function centavos(valor: unknown): number {
  const invalido = () => new ErroEntrada(`Valor inválido: ${repr(valor)}`);
  if (typeof valor !== "string" && typeof valor !== "number") throw invalido();
  const texto = String(valor).replace(",", ".").trim();
  if (!FLOAT_RE.test(texto)) throw invalido();
  const n = Number(texto.replaceAll("_", "")) * 100;
  if (!Number.isFinite(n)) throw invalido();
  return arredondar(n);
}

export function reais(c: number): number {
  return Number((c / 100).toFixed(2));
}

export function mesIdx(mes: string): number {
  const [a, m] = mes.split("-").map(Number);
  return a * 12 + (m - 1);
}

export function idxMes(i: number): string {
  const ano = Math.floor(i / 12);
  const mes = i - ano * 12 + 1;
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}`;
}

export function somarMeses(mes: string, n: number): string {
  return idxMes(mesIdx(mes) + n);
}

function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

export function dataNoMes(mes: string, dia: number): string {
  const [a, m] = mes.split("-").map(Number);
  const d = Math.min(dia, diasNoMes(a, m));
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Campo obrigatório. "string" (padrão) devolve texto sem espaços nas pontas; "number" devolve
 * inteiro como int() do Python (decimal é truncado, texto precisa ser um inteiro).
 */
export function exigir(d: Corpo, campo: string, tipo: "string" | "number" = "string"): any {
  const v = d[campo];
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
    throw new ErroEntrada(`Campo obrigatório: ${campo}`);
  }
  if (tipo === "string") return typeof v === "string" ? v.trim() : String(v);
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v) + 0;
  if (typeof v === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(v)) return Number(v.replaceAll("_", "")) + 0;
  // O Python devolveria erro 500 aqui; um 400 com mensagem é melhor para quem usa o app.
  throw new ErroEntrada(`Valor inválido: ${repr(v)}`);
}

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function exigirMes(d: Corpo, campo: string, opcional = false): string | null {
  const v = d[campo];
  if (opcional && !v) return null;
  if (typeof v !== "string" || !MES_RE.test(v)) throw new ErroEntrada(`Mês inválido em ${campo}: use AAAA-MM`);
  return v;
}

export function exigirData(d: Corpo, campo: string, opcional = false): string | null {
  const v = d[campo];
  if (opcional && !v) return null;
  if (typeof v !== "string" || !DATA_RE.test(v)) throw new ErroEntrada(`Data inválida em ${campo}: use AAAA-MM-DD`);
  const [a, m, dia] = v.split("-").map(Number);
  if (a < 1 || m < 1 || m > 12 || dia < 1 || dia > diasNoMes(a, m)) {
    throw new ErroEntrada(`Data inválida em ${campo}: ${v}`);
  }
  return v;
}

export async function exigirCategoria(db: D1Database, d: Corpo): Promise<number> {
  const cid = d.categoria_id;
  const chave = typeof cid === "number" || typeof cid === "string" ? cid : null;
  const achou = await db.prepare("SELECT 1 FROM categorias WHERE id = ?").bind(chave).first();
  if (!achou) throw new ErroEntrada("Escolha uma categoria válida");
  return cid;
}
