// Resposta JSON com os cabeçalhos de segurança que o app.py (classe Resposta) sempre mandou.

const CABECALHOS_SEGURANCA = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

export function resposta(corpo: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...CABECALHOS_SEGURANCA });
  if (cookie !== undefined) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(corpo), { status, headers });
}
