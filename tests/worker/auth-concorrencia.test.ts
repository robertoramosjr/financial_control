import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashSenha } from "../../src/auth";
import worker from "../../src/index";

const SENHA = "senha-de-teste-123";

const tentar = (senha: string, ip: string) =>
  worker.fetch(
    new Request("https://exemplo.test/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ usuario: "ana", senha }),
    }),
    env,
  );

const contagem = (respostas: Response[]) => {
  const c: Record<number, number> = {};
  for (const r of respostas) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessoes"),
    env.DB.prepare("DELETE FROM falhas_login"),
    env.DB.prepare("DELETE FROM usuarios"),
  ]);
  await env.DB.prepare("INSERT INTO usuarios (nome, senha_hash) VALUES ('ana', ?)").bind(await hashSenha(SENHA)).run();
});

describe("limite de tentativas sob requisições simultâneas", () => {
  it("60 senhas erradas ao mesmo tempo: só 10 chegam a ser conferidas, o resto leva 429", async () => {
    const respostas = await Promise.all(Array.from({ length: 60 }, () => tentar("errada", "1.2.3.4")));
    expect(contagem(respostas)).toEqual({ 401: 10, 429: 50 });
  });

  it("a senha certa no fim de uma rajada de erradas não entra", async () => {
    const rajada = Array.from({ length: 59 }, () => tentar("errada", "1.2.3.4"));
    const respostas = await Promise.all([...rajada, tentar(SENHA, "1.2.3.4")]);
    expect(respostas[59].status).toBe(429);
    expect(respostas[59].headers.get("Set-Cookie")).toBeNull();
  });

  it("o limite geral de 30 também vale numa rajada vinda de IPs diferentes", async () => {
    const respostas = await Promise.all(Array.from({ length: 50 }, (_, i) => tentar("errada", `10.0.0.${i}`)));
    expect(contagem(respostas)).toEqual({ 401: 30, 429: 20 });
  });

  it("login certo não gasta uma tentativa: 20 logins certos seguidos continuam entrando", async () => {
    for (let i = 0; i < 20; i++) expect((await tentar(SENHA, "1.2.3.4")).status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM falhas_login").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
