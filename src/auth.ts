// Login, sessões e limite de tentativas, portados de app.py (seção "login").
import type { Env } from "./index";
import { resposta } from "./resposta";
import { lerJson } from "./util";

// A Cloudflare limita o PBKDF2 a 100000 iterações (os hashes do Python usavam 600000 e não são
// verificáveis aqui: as senhas precisam ser recadastradas com scripts/criar-usuario.mjs).
const ITERACOES = 100_000;
const SESSAO_DIAS = 90;
// Senhas erradas: no máximo 10 por IP e 30 no total a cada 15 minutos.
const LIMITE_IP = 10;
const LIMITE_GERAL = 30;
const JANELA_SEGUNDOS = 15 * 60;

const paraHex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const deHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const HEX_RE = /^([0-9a-f]{2})+$/i;

async function derivar(senha: string, sal: Uint8Array, iteracoes: number): Promise<ArrayBuffer> {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteracoes }, chave, 256);
}

function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export async function hashSenha(senha: string): Promise<string> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${ITERACOES}$${paraHex(sal)}$${paraHex(await derivar(senha, sal, ITERACOES))}`;
}

/** false para senha errada, formato desconhecido ou iterações acima do limite — nunca lança. */
export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  try {
    const partes = guardado.split("$");
    if (partes.length !== 4) return false;
    const [esquema, it, sal, hash] = partes;
    if (esquema !== "pbkdf2_sha256" || !/^\d+$/.test(it) || !HEX_RE.test(sal) || !HEX_RE.test(hash)) return false;
    const iteracoes = Number(it);
    if (iteracoes < 1 || iteracoes > ITERACOES) return false;
    return iguais(paraHex(await derivar(senha, deHex(sal), iteracoes)), hash.toLowerCase());
  } catch {
    return false;
  }
}

export async function hashToken(token: string): Promise<string> {
  return paraHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

export function cookieSessao(token: string, idade: number): string {
  return `sessao=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${idade}; Secure`;
}

export function tokenDaRequisicao(req: Request): string | null {
  for (const parte of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === "sessao") return parte.slice(i + 1).trim() || null;
  }
  return null;
}

export async function usuarioDaSessao(db: D1Database, token: string | null): Promise<string | null> {
  if (!token) return null;
  const r = await db
    .prepare(
      `SELECT u.nome FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token_hash = ? AND s.expira > ?`,
    )
    .bind(await hashToken(token), new Date().toISOString())
    .first<{ nome: string }>();
  return r ? r.nome : null;
}

async function loginBloqueado(db: D1Database, ip: string): Promise<boolean> {
  await db.prepare("DELETE FROM falhas_login WHERE quando < ?").bind(Date.now() / 1000 - JANELA_SEGUNDOS).run();
  const [porIp, geral] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM falhas_login WHERE ip = ?").bind(ip),
    db.prepare("SELECT COUNT(*) AS n FROM falhas_login"),
  ]);
  return porIp.results[0].n >= LIMITE_IP || geral.results[0].n >= LIMITE_GERAL;
}

/** Devolve o token novo se usuário e senha conferem, senão null. */
async function fazerLogin(db: D1Database, d: Record<string, any>): Promise<string | null> {
  const nome = String(d.usuario ?? "").trim();
  const senha = String(d.senha ?? "");
  const u = await db
    .prepare("SELECT id, senha_hash FROM usuarios WHERE nome = ?")
    .bind(nome)
    .first<{ id: number; senha_hash: string }>();
  if (!u || !(await conferirSenha(senha, u.senha_hash))) return null;
  const token = paraBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const agora = new Date();
  const expira = new Date(agora.getTime() + SESSAO_DIAS * 86400 * 1000);
  await db.batch([
    db.prepare("DELETE FROM sessoes WHERE expira <= ?").bind(agora.toISOString()),
    db
      .prepare("INSERT INTO sessoes (token_hash, usuario_id, expira) VALUES (?, ?, ?)")
      .bind(await hashToken(token), u.id, expira.toISOString()),
  ]);
  return token;
}

function paraBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** /api/login, /api/logout e /api/eu. Devolve null para qualquer outro caminho. */
export async function tratarLogin(req: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const token = tokenDaRequisicao(req);

  if (pathname === "/api/login" && req.method === "POST") {
    const d = await lerJson(req);
    const ip = req.headers.get("CF-Connecting-IP") ?? "";
    if (await loginBloqueado(env.DB, ip)) {
      return resposta({ erro: "Muitas tentativas erradas. Espere 15 minutos." }, 429);
    }
    const novo = await fazerLogin(env.DB, d);
    if (!novo) {
      await env.DB.prepare("INSERT INTO falhas_login (ip, quando) VALUES (?, ?)").bind(ip, Date.now() / 1000).run();
      return resposta({ erro: "Usuário ou senha incorretos" }, 401);
    }
    return resposta({ ok: true }, 200, cookieSessao(novo, SESSAO_DIAS * 86400));
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    if (token) await env.DB.prepare("DELETE FROM sessoes WHERE token_hash = ?").bind(await hashToken(token)).run();
    return resposta({ ok: true }, 200, cookieSessao("", 0));
  }

  if (pathname === "/api/eu" && req.method === "GET") {
    // Login sempre obrigatório (equivale a CF_PUBLICO=1 do Python).
    return resposta({ usuario: await usuarioDaSessao(env.DB, token), exige_login: true });
  }

  return null;
}
