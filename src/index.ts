import { tokenDaRequisicao, tratarLogin, usuarioDaSessao } from "./auth";
import { resposta } from "./resposta";
import { ROTAS } from "./rotas";
import { ErroEntrada, lerJson } from "./util";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    // Normalmente a plataforma já serve static/ sozinha; isto cobre o que chegar até aqui.
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      const login = await tratarLogin(req, env);
      if (login) return login;
      if (!(await usuarioDaSessao(env.DB, tokenDaRequisicao(req)))) return resposta({ erro: "Faça login" }, 401);
      for (const [metodo, padrao, fn] of ROTAS) {
        const achou = padrao.exec(pathname);
        if (metodo !== req.method || !achou) continue;
        // GET lê a query string (valores em branco são ignorados, como no parse_qs do Python); o resto lê o corpo.
        const corpo =
          req.method === "GET"
            ? Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "").reverse())
            : await lerJson(req);
        const res = await fn(env.DB, achou[1] ?? null, corpo);
        return resposta(req.method === "GET" ? res : { ok: true, id: res });
      }
      return resposta({ erro: "Rota não encontrada" }, 404);
    } catch (e) {
      if (e instanceof ErroEntrada) return resposta({ erro: e.message }, 400);
      console.error("Erro:", e);
      return resposta({ erro: "Erro interno no servidor" }, 500);
    }
  },
};
