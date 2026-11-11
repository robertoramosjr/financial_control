# Migração para Cloudflare (Workers + D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reescrever o backend Python (`app.py`) em TypeScript num Cloudflare Worker com banco D1, servindo o frontend atual sem mudanças de comportamento, com deploy automático a cada push no GitHub.

**Architecture:** Um Worker (`src/index.ts`) trata `/api/*`; o resto (`static/`) é servido pelo recurso *Static Assets* da Cloudflare. O SQLite vira D1 (mesmo esquema). A lógica de `app.py` é portada função a função para módulos pequenos em `src/`, mantendo nomes de rota, JSON de entrada e saída idênticos, para que `static/app.js` rode sem alterações. A fidelidade é provada por testes de paridade: o Python gera respostas "douradas" a partir de um banco de teste e o TypeScript tem de reproduzi-las byte a byte.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Wrangler, Vitest com `@cloudflare/vitest-pool-workers`, Python 3 (só para gerar as respostas douradas e exportar dados).

**Spec:** Não há documento de design. O usuário dispensou as perguntas ("manda brasa"). Motivação dita por ele: o site no PythonAnywhere precisa ser reativado periodicamente, e ele quer deploy automático pelo GitHub. Escolhas do Claude, não do usuário: TypeScript, Workers + D1, assets estáticos na própria Cloudflare. O PythonAnywhere continua no ar até o usuário validar o novo site.

## Global Constraints

- Paridade total de API: mesmos caminhos, métodos, corpos JSON, códigos HTTP e mensagens de erro (em português) de `ROTAS` e `rotas_de_login` em `app.py`. `static/` não muda.
- Valores monetários ficam em centavos inteiros no banco; a API devolve reais com `round(c / 100, 2)`. Entrada aceita vírgula decimal (`centavos()` em `app.py:301`).
- Esquema D1 idêntico ao `SCHEMA` de `app.py:47-163` mais a coluna `lancamentos.provisao_id`. Chaves estrangeiras ligadas (D1 as ativa por padrão).
- Cookie de sessão: `sessao`, `HttpOnly; SameSite=Strict; Path=/; Secure`, validade de 90 dias. O token fica só como SHA-256 no banco.
- Limite de login: 10 falhas por IP e 30 no total a cada 15 minutos, guardado em `falhas_login`. O IP vem do cabeçalho `CF-Connecting-IP`.
- Login obrigatório sempre (equivale a `CF_PUBLICO=1`); sem usuário cadastrado, a API devolve 401.
- Corpo de requisição limitado a 1.000.000 bytes ("Requisição grande demais", 400).
- Cabeçalhos de resposta de `Resposta` (`app.py:1049-1056`): `Cache-Control: no-store` em JSON, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- Dados financeiros e senhas nunca vão para o repositório (`*.db`, dumps SQL e `.dev.vars` ficam no `.gitignore`).
- Nenhum comando que publique, crie recursos ou altere a conta Cloudflare do usuário roda sem confirmação dele na hora. Isso vale para `wrangler login`, `d1 create`, `deploy`, conexão do GitHub e importação de dados remotos.
- Código novo e comentários em português, como no resto do repositório.

## Review Focus

- **Hash de senha:** a WebCrypto do Workers limita PBKDF2 a 100.000 iterações, e os hashes atuais usam 600.000. Hashes antigos não são verificáveis no Worker. Os usuários precisam de nova senha (Task 3) e o login com hash de formato desconhecido deve devolver 401, nunca 500. Teste na Task 3.
- **Mês inexistente ou malformado** (`/api/mes/2026-13`, `/api/resumo/abcd`): 400 com a mensagem do Python, nunca 500. Teste na Task 4.
- **Banco vazio / primeiro acesso:** categorias padrão existem após a migração e `/api/eu` devolve `{usuario: null, exige_login: true}`. Teste na Task 3.
- **Exclusão com dependentes:** apagar recorrência, parcelamento ou provisão remove pagamentos e ajustes ligados, como `apagar()` em `app.py:983`. Teste na Task 5.
- **Estouro de provisão e mês passado:** as regras de `provisoes_do_mes` (sobra volta ao saldo em mês encerrado, estouro conta o gasto) cobertas pelo golden de provisões. Teste na Task 4.
- **Parcelas com centavos que não dividem:** `parcela_centavos` distribui o resto como no Python. Teste na Task 6.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts` | Configuração (assets em `./static`, D1 `DB`, `run_worker_first: ["/api/*"]`) |
| `migrations/0001_esquema.sql` | Esquema e categorias padrão |
| `src/util.ts` | `ErroEntrada`, `centavos`, `reais`, helpers de mês (`mesIdx`, `idxMes`, `somarMeses`, `dataNoMes`), validadores `exigir*` |
| `src/auth.ts` | PBKDF2, tokens, login, sessões, limite de tentativas, cookie |
| `src/mes.ts` | Leitura: `visaoMes`, `resumoAno`, recorrências, parcelas, avulsos, provisões e entradas do mês |
| `src/cadastros.ts` | Escrita e listagem de categorias, recorrências, parcelamentos, lançamentos, provisões, pagamentos, entradas, fontes |
| `src/projecao.ts` | `projecao` e tudo de cenários, contas e ajustes |
| `src/rotas.ts` | Tabela de rotas (espelha `ROTAS`) |
| `src/index.ts` | `fetch`: segurança, autenticação, despacho, tratamento de erros |
| `scripts/gerar_golden.py` | Usa `app.py` para criar um banco de teste e gravar respostas de referência em `tests/golden/*.json` |
| `scripts/exportar_dados.py` | Gera `dados-export.sql` (só INSERTs) a partir de `dados.db` |
| `scripts/criar-usuario.mjs` | Gera o SQL de upsert de um usuário, com a senha lida sem eco |
| `tests/worker/*.test.ts` | Testes do Worker |
| `app.py`, `tests/test_*.py` | Ficam como estão (referência e rede de segurança até o desligamento do PythonAnywhere) |

---

### Task 1: Esqueleto do Worker, esquema D1 e verificação do PBKDF2

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `migrations/0001_esquema.sql`, `src/index.ts`, `tests/worker/esqueleto.test.ts`
- Modify: `.gitignore` (adicionar `node_modules/`, `.wrangler/`, `.dev.vars`, `dados-export.sql`)

**Interfaces:**
- Produces: `export default { fetch(req: Request, env: Env): Promise<Response> }` em `src/index.ts`; `interface Env { DB: D1Database; ASSETS: Fetcher }` em `src/index.ts`; binding D1 chamado `DB`; assets de `./static` servidos pela plataforma.

- [ ] **Step 1: Escrever o teste que falha** em `tests/worker/esqueleto.test.ts`:
  - `GET /api/eu` responde 200 com `{usuario: null, exige_login: true}`.
  - `SELECT COUNT(*) FROM categorias` devolve 9 depois de aplicar as migrações.
  - `PRAGMA foreign_keys` devolve 1.
  - `crypto.subtle.deriveBits` PBKDF2/SHA-256 com 100000 iterações funciona. Com 600000 lança erro (documenta o limite que motiva a Task 3).
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run tests/worker/esqueleto.test.ts`. Esperado: FAIL (projeto sem configuração).
- [ ] **Step 3: Criar a configuração.** `wrangler.jsonc` com `main: src/index.ts`, `assets: {directory: "./static", binding: "ASSETS", run_worker_first: ["/api/*"]}`, `d1_databases: [{binding: "DB", database_name: "controle-financeiro", database_id: "local-dev"}]`, `compatibility_date` de hoje. Gerar `migrations/0001_esquema.sql` copiando o `SCHEMA` de `app.py:47-163`, a coluna `provisao_id` e os 9 `CATEGORIAS_PADRAO`. `vitest.config.ts` aplica as migrações no D1 de teste. `src/index.ts` por enquanto só implementa `/api/eu`.
- [ ] **Step 4: Rodar e ver passar:** `npx vitest run`. Esperado: PASS. Se o PBKDF2 de 100000 iterações falhar ou o de 600000 passar, registrar o resultado real no topo da Task 3 antes de seguir.
- [ ] **Step 5: Commit** (`git add package.json tsconfig.json wrangler.jsonc vitest.config.ts migrations src tests/worker .gitignore` e `git commit -m "Cloudflare: esqueleto do Worker e esquema D1"`).

### Task 2: Utilidades e validação

**Files:**
- Create: `src/util.ts`, `tests/worker/util.test.ts`

**Interfaces:**
- Produces: `class ErroEntrada extends Error`; `centavos(valor: unknown): number`; `reais(c: number): number`; `mesIdx(mes: string): number`; `idxMes(i: number): string`; `somarMeses(mes: string, n: number): string`; `dataNoMes(mes: string, dia: number): string`; `exigir(d: Record<string, any>, campo: string, tipo?: "string" | "number"): any`; `exigirMes(d, campo, opcional?: boolean): string | null`; `exigirData(d, campo, opcional?: boolean): string | null`; `exigirCategoria(db: D1Database, d): Promise<number>`.

- [ ] **Step 1: Escrever os testes.** Cada caso é a tradução de um teste existente em `tests/test_projecoes.py` e `tests/test_provisoes.py`, com estes valores como mínimo:
  - `centavos("12,34") === 1234`; `centavos(0.1 + 0.2) === 30`; `centavos("abc")` lança `ErroEntrada("Valor inválido: 'abc'")`. Atenção ao `repr` do Python: a mensagem usa aspas simples.
  - `somarMeses("2026-11", 2) === "2027-01"`; `somarMeses("2026-01", -1) === "2025-12"`.
  - `dataNoMes("2026-02", 31) === "2026-02-28"` (limita ao último dia, como `data_no_mes` em `app.py:325`).
  - `exigirMes({m: "2026-13"}, "m")` lança `ErroEntrada`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run tests/worker/util.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Portar `app.py:301-366` para `src/util.ts`** com as mesmas mensagens de erro. Arredondamento: o Python usa `round()` com desempate para par e o JS usa `Math.round`. Implementar um `arredondar` que replica o desempate do Python e usá-lo em `centavos` e `reais`.
- [ ] **Step 4: Rodar e ver passar:** `npx vitest run tests/worker/util.test.ts`. Esperado: PASS.
- [ ] **Step 5: Commit** (`git commit -m "Cloudflare: utilidades e validação"`).

### Task 3: Autenticação e criação de usuário

**Files:**
- Create: `src/auth.ts`, `scripts/criar-usuario.mjs`, `tests/worker/auth.test.ts`
- Modify: `src/index.ts` (rotas `/api/login`, `/api/logout`, `/api/eu`, bloqueio 401 das demais)

**Interfaces:**
- Consumes: `Env`, `ErroEntrada` (Tasks 1-2).
- Produces: `hashSenha(senha: string): Promise<string>` (formato `pbkdf2_sha256$100000$<sal-hex>$<hash-hex>`); `conferirSenha(senha: string, guardado: string): Promise<boolean>` (false para formato desconhecido ou com mais de 100000 iterações, sem lançar); `hashToken(token: string): Promise<string>`; `usuarioDaSessao(db: D1Database, token: string | null): Promise<string | null>`; `tratarLogin(req: Request, env: Env): Promise<Response | null>`; `cookieSessao(token: string, idade: number): string`.

- [ ] **Step 1: Escrever os testes** em `tests/worker/auth.test.ts`:
  - Login com senha certa devolve 200 e `Set-Cookie` contendo `HttpOnly`, `Secure`, `SameSite=Strict` e `Max-Age=7776000`. Depois `/api/eu` com esse cookie devolve `{usuario: "ana", exige_login: true}`.
  - Senha errada devolve 401 `{erro: "Usuário ou senha incorretos"}` e grava uma linha em `falhas_login`.
  - Com 10 falhas do mesmo IP, a 11ª tentativa devolve 429 mesmo com senha certa. Mensagem: "Muitas tentativas erradas. Espere 15 minutos."
  - Logout apaga a sessão: o mesmo cookie passa a dar 401 em `/api/categorias`.
  - Usuário cujo `senha_hash` está no formato antigo (`pbkdf2_sha256$600000$...`) recebe 401, nunca 500.
  - `GET /api/categorias` sem cookie devolve 401 `{erro: "Faça login"}`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run tests/worker/auth.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar `src/auth.ts`** portando `app.py:226-298`. PBKDF2 via `crypto.subtle`, comparação de hashes em tempo constante, token com 32 bytes aleatórios em base64url. **Decisão:** a cadeia de verificação reconhece só 100000 iterações (limite da plataforma). `hashSenha` sempre usa 100000.
- [ ] **Step 4: Escrever `scripts/criar-usuario.mjs`.** Lê nome e senha (mínimo 8 caracteres, com confirmação, sem eco), calcula o hash com a mesma função e imprime um SQL de upsert (`INSERT ... ON CONFLICT (nome) DO UPDATE`) mais o `DELETE` das sessões do usuário. O SQL é aplicado com `wrangler d1 execute --file`. A senha nunca aparece em argumento de linha de comando.
- [ ] **Step 5: Rodar e ver passar:** `npx vitest run tests/worker/auth.test.ts`. Esperado: PASS.
- [ ] **Step 6: Commit** (`git commit -m "Cloudflare: login, sessões e criação de usuário"`).

### Task 4: Leitura do mês e resumo anual, com paridade

**Files:**
- Create: `src/mes.ts`, `scripts/gerar_golden.py`, `tests/worker/mes.test.ts`, `tests/golden/` (JSONs gerados), `tests/worker/semente.ts`
- Modify: `src/index.ts` (rotas `GET /api/mes/:mes`, `GET /api/resumo/:ano`)

**Interfaces:**
- Consumes: `util.ts` (Task 2).
- Produces: `visaoMes(db: D1Database, mes: string, hoje?: string): Promise<object>`; `resumoAno(db: D1Database, ano: number): Promise<object>`; `provisoesDoMes`, `recorrenciasDoMes`, `parcelasDoMes`, `avulsosDoMes`, `entradasDoMes` (exportadas para a Task 6). `tests/worker/semente.ts` exporta `semear(db: D1Database): Promise<void>`, que carrega `tests/golden/semente.sql`.

- [ ] **Step 1: Escrever `scripts/gerar_golden.py`.** Cria um banco temporário com `app.iniciar_banco()`, popula dados cobrindo: recorrência com início e fim, parcelamento com resto de centavos, lançamento avulso, lançamento descontado de provisão, provisão com valor alterado em um mês, mês passado e mês futuro, entradas, pagamentos marcados. Grava `tests/golden/semente.sql` (INSERTs) e, para cada mês de 2026-01 a 2027-12 e para os anos 2026 e 2027, a resposta de `app.tratar` em `tests/golden/mes-AAAA-MM.json` e `resumo-AAAA.json`. O `hoje` é fixo em `2026-11-11` (passar para `visao_mes`).
- [ ] **Step 2: Rodar o gerador:** `python3 scripts/gerar_golden.py`. Esperado: arquivos criados, sem erro. Commitar os JSONs. Eles não contêm dados reais.
- [ ] **Step 3: Escrever `tests/worker/mes.test.ts`.** Para cada `mes-*.json` e `resumo-*.json`, semeia o D1, chama `visaoMes`/`resumoAno` e exige `toEqual` com o golden. Mais: `GET /api/mes/2026-13` devolve 400 `{erro: ...}` e `GET /api/resumo/abcd` devolve 404 `{erro: "Rota não encontrada"}`, como no Python (o padrão da rota só aceita 4 dígitos).
- [ ] **Step 4: Rodar e ver falhar:** `npx vitest run tests/worker/mes.test.ts`. Esperado: FAIL.
- [ ] **Step 5: Portar `app.py:368-495` para `src/mes.ts`.** Cada consulta continua sendo uma consulta; use `db.batch` onde houver consultas independentes, para reduzir idas ao D1. As chaves do JSON devolvido têm de ser as mesmas e na mesma ordem (o Python preserva a ordem de inserção do dict).
- [ ] **Step 6: Rodar e ver passar:** `npx vitest run tests/worker/mes.test.ts`. Esperado: PASS em todos os meses e anos.
- [ ] **Step 7: Commit** (`git commit -m "Cloudflare: visão do mês e resumo anual com testes de paridade"`).

### Task 5: Cadastros (escrita e listagem)

**Files:**
- Create: `src/cadastros.ts`, `tests/worker/cadastros.test.ts`
- Modify: `src/index.ts`, `scripts/gerar_golden.py` (acrescentar respostas de `GET /api/categorias`, `/recorrencias`, `/parcelamentos`, `/provisoes`, `/entradas/2026` ao golden)

**Interfaces:**
- Consumes: `util.ts`, `mes.ts`.
- Produces, todas com `(db: D1Database, ...)` e `Promise` de retorno: `listarCategorias`, `salvarCategoria(db, d, cid?: number): Promise<number>`, `apagarCategoria(db, cid: number)`; `listarRecorrencias`, `salvarRecorrencia(db, d, rid?)`; `listarParcelamentos`, `salvarParcelamento(db, d, pid?)`; `salvarLancamento(db, d, lid?)`; `listarProvisoes`, `salvarProvisao(db, d, pid?)`, `salvarValorMesProvisao(db, pid, d)`, `apagarProvisao(db, pid)`; `marcarPago(db, d)`; `entradasAno(db, ano)`, `salvarEntrada(db, d)`; `salvarFonte(db, d, fid?)`; `apagar(db, tabela: string, id: number, tipoPag?: "rec" | "parc")`. O parâmetro `tabela` de `apagar` vem de uma lista fixa interna, nunca da requisição.

- [ ] **Step 1: Escrever os testes.** Traduzir os casos de `tests/test_projecoes.py` e `tests/test_provisoes.py` que usam POST/PUT/DELETE. Mínimo:
  - Criar recorrência devolve `{ok: true, id: N}` e a listagem bate com o golden.
  - Apagar recorrência remove suas linhas em `pagamentos` e `projecao_ajustes`.
  - Apagar categoria em uso devolve 400 com a mesma mensagem do Python (`apagar_categoria`, `app.py:694`).
  - Lançamento com `provisao_id` inexistente devolve 400.
  - `PUT /api/provisoes/:id/meses` altera só aquele mês (conferir via `visaoMes`).
  - Corpo inválido (`valor: "xyz"`) devolve 400 `{erro: "Valor inválido: 'xyz'"}`.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run tests/worker/cadastros.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Portar `app.py:497-743` para `src/cadastros.ts`.** Operações com mais de uma escrita (apagar com dependentes, salvar com várias linhas) usam `db.batch` para serem atômicas, equivalendo ao commit único da `conectar()` do Python.
- [ ] **Step 4: Rodar e ver passar:** `npx vitest run tests/worker/cadastros.test.ts`. Esperado: PASS.
- [ ] **Step 5: Commit** (`git commit -m "Cloudflare: cadastros (categorias, recorrências, parcelas, lançamentos, provisões, entradas)"`).

### Task 6: Projeções, cenários e ajustes

**Files:**
- Create: `src/projecao.ts`, `tests/worker/projecao.test.ts`
- Modify: `src/index.ts`, `scripts/gerar_golden.py` (respostas de `GET /api/projecao` com a semente e, em seguida, com 2 cenários e 3 ajustes: corte, redução e pausa, para todos os cenários e para um só)

**Interfaces:**
- Consumes: `mes.ts` (`recorrenciasDoMes`, `parcelasDoMes`, `entradasDoMes`), `util.ts`.
- Produces: `parcelaCentavos(total: number, n: number): number[]`; `projecao(db, inicio: string, nMeses?: number): Promise<object>`; `salvarEntradaProjetada`, `salvarCenario(db, d, cid?)`, `duplicarCenario(db, cid, d)`, `salvarContasProjecao(db, d)`, `salvarContaProjecao(db, d, contaId)`, `salvarAjuste(db, d)`, `desfazerMesAjuste(db, ajusteId, d)`.

- [ ] **Step 1: Escrever os testes.** Traduzir `tests/test_projecoes.py` inteiro (517 linhas). Pelo menos:
  - `parcelaCentavos(10000, 3)` devolve `[3334, 3333, 3333]` (conferir a ordem real em `app.py:745` e fixar o valor que o Python produz).
  - Golden de `/api/projecao` com a semente base e com cenários e ajustes. `toEqual`, incluindo a série "sem ajustes" de cada cenário.
  - Duplicar cenário copia contas e ajustes com ids novos.
  - Desfazer ajuste de um mês parte um ajuste de período em dois, como `desfazer_mes_ajuste` (`app.py:959`).
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run tests/worker/projecao.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Portar `app.py:745-981` para `src/projecao.ts`.** Carregar todas as tabelas necessárias numa única `db.batch` antes do cálculo e calcular em memória, para não fazer consultas dentro de laços.
- [ ] **Step 4: Rodar e ver passar:** `npx vitest run tests/worker/projecao.test.ts`. Esperado: PASS.
- [ ] **Step 5: Commit** (`git commit -m "Cloudflare: projeções, cenários e ajustes"`).

### Task 7: Roteador completo, segurança e teste de navegador

**Files:**
- Create: `src/rotas.ts`, `tests/worker/rotas.test.ts`
- Modify: `src/index.ts`, `tests/test_e2e_projecoes.py` (aceitar `CF_ALVO=worker` para subir `npx wrangler dev --local --port <porta>` em vez do `app.py`, com D1 local e usuário de teste), `package.json` (scripts `dev`, `test`, `test:e2e`)

**Interfaces:**
- Consumes: todos os módulos anteriores.
- Produces: `ROTAS: Array<[metodo: string, padrao: RegExp, fn: (db: D1Database, id: string | null, corpo: any) => Promise<any>]>` com as 40 rotas de `app.py:993-1040`, nos mesmos caminhos e métodos.

- [ ] **Step 1: Escrever `tests/worker/rotas.test.ts`:**
  - Para cada entrada de `ROTAS` do Python (extraída por `scripts/gerar_golden.py` num `tests/golden/rotas.json` com método e padrão), existe rota equivalente no Worker (não devolve 404 com sessão válida).
  - `POST /api/lancamentos` com corpo de 1.000.001 bytes devolve 400 "Requisição grande demais".
  - Método `POST` em `/` devolve 405; `GET /` devolve o `index.html` com `Cache-Control: no-cache`.
  - Toda resposta de `/api/*` traz os quatro cabeçalhos de segurança da seção Global Constraints.
  - Exceção inesperada num handler devolve 500 `{erro: "Erro interno no servidor"}` sem vazar a mensagem.
- [ ] **Step 2: Rodar e ver falhar:** `npx vitest run tests/worker/rotas.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar `src/rotas.ts` e finalizar `src/index.ts`** (ordem: login, autenticação, despacho, corpo JSON ou query, tratamento de erros), portando `tratar` de `app.py:1112`.
- [ ] **Step 4: Rodar a suíte do Worker:** `npx vitest run`. Esperado: tudo PASS.
- [ ] **Step 5: Rodar o teste de navegador contra o Worker local:** `CF_ALVO=worker python3 -m unittest tests.test_e2e_projecoes -v`. Esperado: as três fases (`tabela`, `completa`, `provisoes`) com PASS e sem erros de JS. Pulado se não houver `google-chrome`. Nesse caso, avisar o usuário e abrir o app com `npx wrangler dev` para ele testar à mão.
- [ ] **Step 6: Commit** (`git commit -m "Cloudflare: roteador completo, cabeçalhos de segurança e e2e no Worker"`).

### Task 8: Exportação e importação dos dados reais

**Files:**
- Create: `scripts/exportar_dados.py`, `tests/test_exportar_dados.py`

**Interfaces:**
- Produces: `python3 scripts/exportar_dados.py [--db dados.db] [--saida dados-export.sql]`. Gera apenas `INSERT` em ordem de dependência (tabelas pai antes das filhas), sem `usuarios`, `sessoes` nem `falhas_login`, e preserva os ids.

- [ ] **Step 1: Escrever `tests/test_exportar_dados.py`.** Usa o `BancoTemporario` de `tests/test_projecoes.py`, exporta, carrega o SQL num SQLite vazio com o esquema de `migrations/0001_esquema.sql` e compara linha a linha todas as tabelas exportadas. Também confirma que o arquivo não contém `usuarios` nem `senha_hash`.
- [ ] **Step 2: Rodar e ver falhar:** `python3 -m unittest tests.test_exportar_dados -v`. Esperado: FAIL.
- [ ] **Step 3: Implementar o exportador.** A ordem das tabelas segue as chaves estrangeiras de `SCHEMA`. As categorias padrão que a migração já cria são apagadas antes dos INSERTs (`DELETE FROM categorias;` no início do arquivo), para os ids do banco real valerem.
- [ ] **Step 4: Rodar e ver passar:** `python3 -m unittest tests.test_exportar_dados -v`. Esperado: PASS.
- [ ] **Step 5: Ensaio com o `dados.db` real, só local:** `python3 scripts/exportar_dados.py`, depois `npx wrangler d1 execute controle-financeiro --local --file dados-export.sql`. Com `wrangler dev` apontando para esse D1 local, abrir o app e comparar à mão o Mês atual e o Resumo com o que o site do PythonAnywhere mostra. Reportar diferenças ao usuário. Nada sai da máquina.
- [ ] **Step 6: Commit** (`git commit -m "Cloudflare: exportação dos dados reais para o D1"`). O `dados-export.sql` fica fora do commit, pelo `.gitignore`.

### Task 9: Publicação, deploy automático e documentação

**Files:**
- Modify: `README.md` (trocar a seção "Na internet (PythonAnywhere)" por Cloudflare e manter uma nota curta sobre o PythonAnywhere como legado), `.gitignore`
- Create: `docs/superpowers/specs/2026-11-11-migracao-cloudflare-design.md` (registro curto: motivação, escolhas, limite do PBKDF2, plano de desligamento do PythonAnywhere)

Esta tarefa precisa do usuário em cada passo que toca a conta Cloudflare. Pare e peça confirmação antes de cada um.

- [ ] **Step 1: Confirmar com o usuário** que pode rodar `npx wrangler login`, e pedir que ele conclua o login no navegador.
- [ ] **Step 2: Criar o banco:** `npx wrangler d1 create controle-financeiro`. Colocar o `database_id` devolvido no `wrangler.jsonc`. Esse id não é segredo e vai para o commit.
- [ ] **Step 3: Aplicar esquema, dados e usuários no D1 remoto:** `npx wrangler d1 migrations apply controle-financeiro --remote`; depois `npx wrangler d1 execute controle-financeiro --remote --file dados-export.sql`; depois, para cada pessoa, `node scripts/criar-usuario.mjs <nome>` e `wrangler d1 execute ... --remote --file <saida>`. O usuário digita as senhas. Avisar que serão senhas novas, por causa do limite de iterações.
- [ ] **Step 4: Primeiro deploy manual:** `npx wrangler deploy`. Abrir a URL `*.workers.dev`, entrar, conferir Mês, Resumo, Projeções e Provisões.
- [ ] **Step 5: Ligar o deploy automático.** No painel da Cloudflare: Workers & Pages → o Worker → Settings → Builds → Connect → repositório `financial_control`, branch `main`, comando de build `npm ci`, comando de deploy `npx wrangler deploy`. Guiar o usuário pelo painel, porque é ação dele. Validar fazendo um commit trivial e vendo o deploy disparar sozinho.
- [ ] **Step 6: Backup.** Documentar no README o D1 Time Travel (`wrangler d1 time-travel restore`, 30 dias) e o comando `wrangler d1 export controle-financeiro --remote --output backup.sql` para cópia manual. O README também diz que o backup de 6 em 6 horas do Python deixa de existir.
- [ ] **Step 7: Atualizar README e registrar o design.** Descrever desenvolvimento local (`npm run dev`, `npm test`) e deploy. Manter o PythonAnywhere no ar até o usuário dizer que validou. Só então ele desativa o site antigo.
- [ ] **Step 8: Commit e push** (`git commit -m "Cloudflare: deploy, documentação e registro de design"`; `git push` somente com o OK do usuário).

---

## Self-Review

- **Cobertura:** rotas de `ROTAS` (Tasks 4-7), login e sessões (3), esquema (1), dados (8), deploy automático (9), backup (9). Faltou nada do que o usuário pediu: "sempre no ar" e "sincronia com o GitHub".
- **Consistência de tipos:** `Env`, `ErroEntrada`, `visaoMes`, `salvarCenario` e os outros nomes aparecem com a mesma assinatura em Interfaces e nos passos que os usam.
- **Risco aberto:** o limite de PBKDF2 (100.000 iterações) está documentado como fato da plataforma. A Task 1 o confirma na prática antes de qualquer outra coisa.
