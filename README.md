# Controle Financeiro

Controle de despesas da casa: compras avulsas, recorrências (assinaturas/contas mensais),
parcelamentos, entradas, projeções por cenário e resumo anual.

Na internet roda como um **Worker da Cloudflare** (TypeScript, pasta `src/`) com banco **D1** (SQLite) e o
frontend de `static/`. O servidor Python (`app.py`, só biblioteca padrão + SQLite) continua no repositório para
uso no computador e como referência: os testes de paridade garantem que o Worker responde igual a ele.

Na aba Projeções, clicar no nome de um mês abre as despesas dele (recorrências e parcelas) e permite
cortar, reduzir ou pausar uma delas só na projeção (nada real muda), para todos os cenários ou só um.
O gráfico pode mostrar cada cenário também sem os ajustes.

Na aba Provisões você reserva um valor por mês para gastos variáveis (ex.: Saídas, R$ 600). Ao lançar uma
compra, escolha a provisão em "Descontar da provisão" (vem preenchido pela categoria): a compra conta como gasto
e a linha "Provisionado – Saídas" do mês mostra só o que ainda está disponível. Em mês que já terminou conta só
o que foi gasto (a sobra volta ao saldo); se estourar, conta o gasto. Para mudar o valor de um mês só, clique na
provisão na aba Mês daquele mês.

## No computador (servidor Python)

    python3 app.py

Abre em http://localhost:8765. Sem usuário cadastrado, não pede login.
Para importar a planilha antiga: `pip install openpyxl && python3 importar_planilha.py "Controle Financeiro.xlsx"`.

## Na internet (Cloudflare)

O site fica sempre no ar (sem precisar "reativar") e cada `git push` na branch `main` publica sozinho.
O Worker **sempre** exige login. Os dados ficam no D1; o `dados.db` nunca vai para o repositório.

### Desenvolvimento local

    npm install                     # o .npmrc evita um travamento do npm 9; precisa de Node 22+
    npx wrangler d1 migrations apply controle-financeiro --local
    node scripts/criar-usuario.mjs SEU_NOME > usuario.sql
    npx wrangler d1 execute controle-financeiro --local --file usuario.sql
    npm run dev                     # http://localhost:8787

`criar-usuario.mjs` pede a senha sem mostrá-la (mínimo 8 caracteres); rodar de novo para o mesmo nome troca a senha.
Para importar dados de um `dados.db` antigo: `python3 scripts/exportar_dados.py --db caminho/dados.db` e depois
`npx wrangler d1 execute controle-financeiro --local --file dados-export.sql` (só num banco recém-criado).

Testes:

    npm test                        # Worker (Vitest, em ~2 s)
    npm run test:e2e                # aba Projeções num Chrome de verdade, contra o Worker local (precisa de google-chrome)
    python3 -m unittest discover -s tests   # servidor Python, exportador e e2e do Python

`tests/golden/` guarda as respostas do `app.py` que o Worker precisa reproduzir. Se o comportamento do Python
mudar de propósito, rode `npm run golden` e confira o diff.

### Publicar (uma vez)

1. `npx wrangler login` (abre o navegador para entrar na sua conta Cloudflare).
2. `npx wrangler d1 create controle-financeiro` e copie o `database_id` devolvido para `wrangler.jsonc`.
3. Baixe o `dados.db` **de verdade** (no PythonAnywhere ele fica em `~/dados/`, aba Files) para a pasta do projeto
   e rode `python3 scripts/exportar_dados.py`.
4. `npx wrangler d1 migrations apply controle-financeiro --remote`, depois
   `npx wrangler d1 execute controle-financeiro --remote --file dados-export.sql`.
5. Para cada pessoa: `node scripts/criar-usuario.mjs NOME > u.sql` e
   `npx wrangler d1 execute controle-financeiro --remote --file u.sql`.
   **As senhas são novas:** o hash do Python usa mais iterações do que a Cloudflare aceita.
6. `npx wrangler deploy`, abra a URL `*.workers.dev` e confira Mês, Resumo, Projeções e Provisões.
7. Deploy automático: no painel da Cloudflare, *Workers & Pages* → o Worker → *Settings* → *Builds* → *Connect*,
   repositório `financial_control`, branch `main`, build `npm ci`, deploy `npx wrangler deploy`.

### Backup

O backup automático de 6 em 6 horas do Python **deixa de existir**. No lugar:

- **Time Travel do D1:** volta o banco a qualquer instante dos últimos 30 dias:
  `npx wrangler d1 time-travel info controle-financeiro` e
  `npx wrangler d1 time-travel restore controle-financeiro --timestamp=AAAA-MM-DDTHH:MM:SSZ`.
- **Cópia manual:** `npx wrangler d1 export controle-financeiro --remote --output backup.sql`
  (guarde fora do repositório: tem seus dados financeiros).

### Limites do plano gratuito que moldaram o código

O D1 gratuito permite 50 consultas por requisição, por isso `src/mes.ts` e `src/projecao.ts` carregam os dados em
poucas consultas e calculam em memória. Veja `docs/superpowers/specs/2026-11-11-migracao-cloudflare-design.md`.

## Legado: PythonAnywhere

O site antigo fica no ar até você validar o da Cloudflare; depois pode desativá-lo. Os dados dele (`dados.db`)
moram em `~/dados/` no servidor, com backup a cada 6 horas em `~/dados/backups/`. Atualizar o código era
`cd ~/financial_control && git pull` e **Reload** na aba Web. A instalação original está em
`deploy/pythonanywhere_wsgi.py` (arquivo WSGI) e no histórico deste README.

## Alternativa: VM própria (Google Cloud, Oracle...)

`sudo bash deploy/instalar.sh` numa VM Debian 12 instala o servidor Python com HTTPS via Caddy.
