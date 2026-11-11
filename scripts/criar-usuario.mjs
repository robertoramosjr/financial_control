// Gera o SQL que cria um usuário (ou troca a senha dele) no D1. A senha é lida sem eco e nunca
// aparece em argumento de linha de comando nem no histórico do terminal.
//
//   node scripts/criar-usuario.mjs ana > usuario.sql
//   npx wrangler d1 execute controle-financeiro --remote --file usuario.sql
//   (use --local em vez de --remote para o banco de desenvolvimento)
//
// O formato do hash é o mesmo de src/auth.ts (PBKDF2-SHA256, 100000 iterações, limite da Cloudflare).

const ITERACOES = 100_000;

const paraHex = (bytes) => [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function gerarHash(senha, sal = crypto.getRandomValues(new Uint8Array(16))) {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: ITERACOES },
    chave,
    256,
  );
  return `pbkdf2_sha256$${ITERACOES}$${paraHex(sal)}$${paraHex(bits)}`;
}

/** Uma instrução por linha, inteira na linha (é o que o `exec` do D1 aceita). */
export function sqlUsuario(nome, hash) {
  const n = nome.replaceAll("'", "''");
  return [
    `INSERT INTO usuarios (nome, senha_hash) VALUES ('${n}', '${hash}') ON CONFLICT (nome) DO UPDATE SET senha_hash = excluded.senha_hash;`,
    // Trocar a senha derruba as sessões abertas desse usuário.
    `DELETE FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE nome = '${n}');`,
    "",
  ].join("\n");
}

async function main() {
  const nome = (process.argv[2] ?? "").trim();
  if (!nome) {
    console.error("Uso: node scripts/criar-usuario.mjs NOME > usuario.sql");
    process.exit(1);
  }
  const pergunta = await perguntador();
  const senha = await pergunta(`Senha para ${nome}: `);
  if (senha.length < 8) {
    console.error("A senha precisa ter pelo menos 8 caracteres.");
    process.exit(1);
  }
  if ((await pergunta("Repita a senha: ")) !== senha) {
    console.error("As senhas não conferem.");
    process.exit(1);
  }
  process.stdout.write(sqlUsuario(nome, await gerarHash(senha)));
  console.error(`Pronto: aplique o SQL com wrangler d1 execute para o usuário '${nome}'.`);
}

// Devolve uma função que pergunta pelo stderr (o stdout fica só com o SQL) e lê sem eco quando há terminal.
async function perguntador() {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    const { createInterface } = await import("node:readline");
    const linhas = createInterface({ input: stdin })[Symbol.asyncIterator]();
    return async (texto) => {
      stderr.write(texto + "\n");
      return (await linhas.next()).value ?? "";
    };
  }
  return (texto) =>
    new Promise((resolver) => {
      stderr.write(texto);
      let digitado = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const aoReceber = (trecho) => {
        for (const c of trecho) {
          if (c === "\r" || c === "\n" || c === "\u0004") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", aoReceber);
            stderr.write("\n");
            return resolver(digitado);
          }
          if (c === "\u0003") {
            stderr.write("\n");
            process.exit(130);
          }
          digitado = c === "\u007f" || c === "\b" ? digitado.slice(0, -1) : digitado + c;
        }
      };
      stdin.on("data", aoReceber);
    });
}

// Só roda como programa (nos testes o módulo é apenas importado).
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("criar-usuario.mjs")) await main();
