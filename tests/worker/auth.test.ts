import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { conferirSenha, hashSenha, hashToken } from "../../src/auth";
import worker from "../../src/index";
import { gerarHash, sqlUsuario } from "../../scripts/criar-usuario.mjs";

const SENHA = "senha-de-teste-123";

async function chamar(metodo: string, caminho: string, opcoes: { corpo?: unknown; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opcoes.cookie) headers.Cookie = opcoes.cookie;
  if (opcoes.ip) headers["CF-Connecting-IP"] = opcoes.ip;
  return worker.fetch(
    new Request("https://exemplo.test" + caminho, {
      method: metodo,
      headers,
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
    }),
    env,
  );
}

const login = (senha = SENHA, opcoes: { ip?: string; usuario?: string } = {}) =>
  chamar("POST", "/api/login", { corpo: { usuario: opcoes.usuario ?? "ana", senha }, ip: opcoes.ip });

const cookieDe = (resp: Response) => resp.headers.get("Set-Cookie")!.split(";")[0];

async function criarUsuario(nome = "ana", senhaHash?: string) {
  const h = senhaHash ?? (await hashSenha(SENHA));
  await env.DB.prepare("INSERT INTO usuarios (nome, senha_hash) VALUES (?, ?)").bind(nome, h).run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessoes"),
    env.DB.prepare("DELETE FROM falhas_login"),
    env.DB.prepare("DELETE FROM usuarios"),
  ]);
});

describe("hash de senha", () => {
  it("gera pbkdf2_sha256$100000$sal$hash e confere a senha certa", async () => {
    const h = await hashSenha(SENHA);
    expect(h).toMatch(/^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await conferirSenha(SENHA, h)).toBe(true);
    expect(await conferirSenha("outra", h)).toBe(false);
  });

  it("usa um sal novo a cada hash", async () => {
    expect(await hashSenha(SENHA)).not.toBe(await hashSenha(SENHA));
  });

  it("devolve false, sem lançar, para formato desconhecido ou iterações acima do limite", async () => {
    expect(await conferirSenha(SENHA, "pbkdf2_sha256$600000$" + "ab".repeat(16) + "$" + "cd".repeat(32))).toBe(false);
    expect(await conferirSenha(SENHA, "lixo")).toBe(false);
    expect(await conferirSenha(SENHA, "scrypt$100000$ab$cd")).toBe(false);
    expect(await conferirSenha(SENHA, "pbkdf2_sha256$100000$zz$cd")).toBe(false);
    expect(await conferirSenha(SENHA, "")).toBe(false);
  });
});

describe("login e sessão", () => {
  it("senha certa devolve 200 e cookie seguro; /api/eu reconhece a sessão", async () => {
    await criarUsuario();
    const resp = await login();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    const cookie = resp.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^sessao=[A-Za-z0-9_-]{43};/);
    for (const parte of ["Path=/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=7776000"]) {
      expect(cookie).toContain(parte);
    }

    const eu = await chamar("GET", "/api/eu", { cookie: cookieDe(resp) });
    expect(await eu.json()).toEqual({ usuario: "ana", exige_login: true });
  });

  it("o banco guarda só o SHA-256 do token, nunca o token", async () => {
    await criarUsuario();
    const token = cookieDe(await login()).replace("sessao=", "");
    const linhas = await env.DB.prepare("SELECT token_hash FROM sessoes").all<{ token_hash: string }>();
    expect(linhas.results).toEqual([{ token_hash: await hashToken(token) }]);
    expect(linhas.results[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("o nome do usuário não diferencia maiúsculas", async () => {
    await criarUsuario("ana");
    expect((await login(SENHA, { usuario: "ANA" })).status).toBe(200);
  });

  it("senha errada devolve 401 e registra a falha", async () => {
    await criarUsuario();
    const resp = await login("errada");
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ erro: "Usuário ou senha incorretos" });
    expect(resp.headers.get("Set-Cookie")).toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM falhas_login").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("usuário inexistente também devolve 401", async () => {
    expect((await login(SENHA, { usuario: "ninguem" })).status).toBe(401);
  });

  it("hash no formato antigo (600000 iterações) devolve 401, nunca 500", async () => {
    await criarUsuario("ana", "pbkdf2_sha256$600000$" + "ab".repeat(16) + "$" + "cd".repeat(32));
    expect((await login()).status).toBe(401);
  });

  it("hash corrompido no banco devolve 401, nunca 500", async () => {
    await criarUsuario("ana", "isto-nao-e-um-hash");
    expect((await login()).status).toBe(401);
  });

  it("logout apaga a sessão e limpa o cookie", async () => {
    await criarUsuario();
    const cookie = cookieDe(await login());
    const resp = await chamar("POST", "/api/logout", { cookie });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Set-Cookie")).toMatch(/^sessao=;.*Max-Age=0/);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessoes").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await chamar("GET", "/api/categorias", { cookie })).status).toBe(401);
  });

  it("sessão expirada não vale", async () => {
    await criarUsuario();
    const token = "token-expirado";
    await env.DB.prepare(
      "INSERT INTO sessoes (token_hash, usuario_id, expira) VALUES (?, (SELECT id FROM usuarios LIMIT 1), ?)",
    )
      .bind(await hashToken(token), "2000-01-01T00:00:00.000Z")
      .run();
    const eu = await chamar("GET", "/api/eu", { cookie: `sessao=${token}` });
    expect(await eu.json()).toEqual({ usuario: null, exige_login: true });
  });

  it("cookie com token desconhecido vale como sem sessão", async () => {
    const eu = await chamar("GET", "/api/eu", { cookie: "sessao=qualquer" });
    expect(await eu.json()).toEqual({ usuario: null, exige_login: true });
  });

  it("rota da API sem sessão devolve 401 Faça login, mesmo sem nenhum usuário cadastrado", async () => {
    const resp = await chamar("GET", "/api/categorias");
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ erro: "Faça login" });
  });

  it("corpo de login que não é JSON devolve 400", async () => {
    const resp = await worker.fetch(
      new Request("https://exemplo.test/api/login", { method: "POST", body: "{quebrado" }),
      env,
    );
    expect(resp.status).toBe(400);
  });
});

describe("limite de tentativas", () => {
  it("depois de 10 falhas do mesmo IP, até a senha certa recebe 429", async () => {
    await criarUsuario();
    for (let i = 0; i < 10; i++) {
      expect((await login("errada", { ip: "1.2.3.4" })).status).toBe(401);
    }
    const resp = await login(SENHA, { ip: "1.2.3.4" });
    expect(resp.status).toBe(429);
    expect(await resp.json()).toEqual({ erro: "Muitas tentativas erradas. Espere 15 minutos." });
  });

  it("o bloqueio de um IP não atinge outro IP", async () => {
    await criarUsuario();
    for (let i = 0; i < 10; i++) await login("errada", { ip: "1.2.3.4" });
    expect((await login(SENHA, { ip: "5.6.7.8" })).status).toBe(200);
  });

  it("30 falhas no total bloqueiam todos os IPs", async () => {
    await criarUsuario();
    const agora = Date.now() / 1000;
    await env.DB.batch(
      Array.from({ length: 30 }, (_, i) =>
        env.DB.prepare("INSERT INTO falhas_login (ip, quando) VALUES (?, ?)").bind(`10.0.0.${i}`, agora),
      ),
    );
    expect((await login(SENHA, { ip: "9.9.9.9" })).status).toBe(429);
  });

  it("falhas com mais de 15 minutos são esquecidas", async () => {
    await criarUsuario();
    const velho = Date.now() / 1000 - 16 * 60;
    await env.DB.batch(
      Array.from({ length: 10 }, () =>
        env.DB.prepare("INSERT INTO falhas_login (ip, quando) VALUES ('1.2.3.4', ?)").bind(velho),
      ),
    );
    expect((await login(SENHA, { ip: "1.2.3.4" })).status).toBe(200);
  });
});

describe("scripts/criar-usuario.mjs", () => {
  it("gera um hash que o Worker aceita", async () => {
    const h = await gerarHash(SENHA);
    expect(h).toMatch(/^pbkdf2_sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(await conferirSenha(SENHA, h)).toBe(true);
  });

  it("o SQL cria o usuário, troca a senha se ele já existe e derruba as sessões; aspas no nome são escapadas", async () => {
    const sql = sqlUsuario("o'neil", await gerarHash(SENHA));
    await env.DB.exec(sql);
    const nova = await gerarHash("outra-senha-456");
    await env.DB.exec(sqlUsuario("o'neil", nova));
    const linhas = await env.DB.prepare("SELECT nome, senha_hash FROM usuarios").all<{ nome: string; senha_hash: string }>();
    expect(linhas.results).toEqual([{ nome: "o'neil", senha_hash: nova }]);
    expect((await login("outra-senha-456", { usuario: "o'neil" })).status).toBe(200);
  });
});
