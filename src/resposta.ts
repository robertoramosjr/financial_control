// Resposta JSON com os cabeçalhos de segurança que o app.py (classe Resposta) sempre mandou.

/** Cabeçalhos de segurança de toda resposta; `cache` é "no-store" para JSON e "no-cache" para arquivos. */
export function aplicarSeguranca(headers: Headers, cache: string): Headers {
  headers.set("Cache-Control", cache);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

export function resposta(corpo: unknown, status = 200, cookie?: string): Response {
  const headers = aplicarSeguranca(new Headers({ "Content-Type": "application/json; charset=utf-8" }), "no-store");
  if (cookie !== undefined) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(corpo), { status, headers });
}
