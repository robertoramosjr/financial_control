import { tokenDaRequisicao, tratarLogin, usuarioDaSessao } from "./auth";
import { resposta } from "./resposta";
import { ErroEntrada } from "./util";

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
      // As rotas de dados entram nas próximas tarefas.
      return resposta({ erro: "Rota não encontrada" }, 404);
    } catch (e) {
      if (e instanceof ErroEntrada) return resposta({ erro: e.message }, 400);
      console.error("Erro:", e);
      return resposta({ erro: "Erro interno no servidor" }, 500);
    }
  },
};
