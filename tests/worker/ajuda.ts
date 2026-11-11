import { env } from "cloudflare:workers";
import { hashSenha } from "../../src/auth";
import worker from "../../src/index";

const SENHA = "senha-de-teste-123";

/** Chama o Worker como o navegador chamaria. `cookie` é o valor devolvido por entrar(). */
export function chamar(metodo: string, caminho: string, opcoes: { corpo?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opcoes.cookie) headers.Cookie = opcoes.cookie;
  return worker.fetch(
    new Request("https://exemplo.test" + caminho, {
      method: metodo,
      headers,
      body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
    }),
    env,
  );
}

/** Cria o usuário "ana" (se preciso), faz login e devolve o cookie `sessao=...` para as próximas chamadas. */
export async function entrar(): Promise<string> {
  await env.DB.prepare("INSERT OR IGNORE INTO usuarios (nome, senha_hash) VALUES ('ana', ?)")
    .bind(await hashSenha(SENHA))
    .run();
  const resp = await chamar("POST", "/api/login", { corpo: { usuario: "ana", senha: SENHA } });
  return resp.headers.get("Set-Cookie")!.split(";")[0];
}
