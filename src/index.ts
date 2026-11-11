export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(req: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/eu" && req.method === "GET") {
      // Login sempre obrigatório (equivale a CF_PUBLICO=1); a sessão entra na Task 3.
      return json({ usuario: null, exige_login: true });
    }
    return json({ erro: "Rota não encontrada" }, 404);
  },
};
