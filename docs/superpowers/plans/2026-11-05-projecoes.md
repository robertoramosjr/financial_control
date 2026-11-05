# Aba Projeções Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova aba "Projeções" que projeta 12 meses de saldo e comprometimento da renda para vários cenários de compra, sem alterar nenhum lançamento real.

**Architecture:** Três tabelas novas no mesmo `dados.db` (entradas previstas, cenários, contas de projeção). Um cálculo único no backend (`projecao()`) devolve todos os números que a tabela e o gráfico usam, reaproveitando `visao_mes()` para as despesas já cadastradas. O front-end é uma tela nova em `static/app.js` com gráfico SVG feito à mão, no estilo de `graficoAno()`.

**Tech Stack:** Python 3 só com biblioteca padrão + SQLite (`app.py`), JavaScript puro (`static/`), testes com `unittest`.

**Spec:** `docs/superpowers/specs/2026-11-05-projecoes-design.md`

## Global Constraints

- Sem dependências novas e sem frameworks (Python stdlib; JS puro; gráfico em SVG).
- Tabelas novas só com `CREATE TABLE IF NOT EXISTS` dentro de `SCHEMA` em `app.py`: o `dados.db` de produção já existe e não pode ser alterado nem apagado.
- Valores em centavos inteiros no banco; a API devolve reais (`reais()`), como o resto do sistema.
- Erros de validação usam `ErroEntrada` (viram HTTP 400); textos da interface em português do Brasil.
- Nada digitado em Projeções altera Mês, Recorrências, Parcelamentos, Entradas ou Resumo.
- Campos editáveis não podem refazer a tela ao salvar (derruba o foco; ver commit 761bf1b) e handlers `onkeydown` nunca devolvem `false`.
- Horizonte fixo: 12 meses a partir do mês atual. Saldo do mês é só daquele mês; "Acumulado" é só uma linha da tabela; o gráfico é sempre mês a mês.
- Os testes **nunca** podem tocar o `dados.db` real do repositório (gitignored, mas é o banco do usuário): sempre apontar `app.DB_PATH` e `app.BACKUPS` para um diretório temporário.

## Review Focus

1. Entrada do mês zero ou vazia: comprometimento vira `None` (tela mostra "–") e o saldo em R$ continua aparecendo; digitar `0` explícito não é o mesmo que vazio (vazio cai no valor real da aba Entradas).
2. Conta cuja primeira parcela é anterior ao mês atual (só as parcelas dentro do horizonte contam), que termina no meio do horizonte, ou à vista (1 parcela).
3. Total que não divide exato (R$ 100,00 em 3x → parcela 33,33, arredondada a centavos).
4. Entrada inválida: valor ≤ 0, parcelas < 1 ou não inteiras, mês fora de `AAAA-MM`, `cenario_id` inexistente; num lote, uma linha inválida não grava nenhuma.
5. Cenário com nome vazio ou repetido; apagar o cenário que está selecionado na tela; duplicar leva as contas junto; mais cenários do que cores no gráfico.

---

## File Structure

- Modify `app.py`: `SCHEMA` (3 tabelas) e uma seção nova "projeções" (cálculo + salvar/apagar) antes da seção `# ---- HTTP`; novas entradas em `ROTAS`.
- Modify `static/index.html`: link da aba. Modify `static/app.js`: `telaProjecoes` e `graficoProjecao`, registro em `render()`. Modify `static/style.css`: cores das linhas do gráfico e estilos da tabela.
- Create `tests/test_projecoes.py`: testes do cálculo e da API.
- Modify `README.md`: uma linha sobre a aba.

---

### Task 1: Tabelas e cálculo da projeção

**Files:**
- Modify: `app.py` (`SCHEMA`; nova seção antes de `# ---- HTTP`)
- Create: `tests/test_projecoes.py`

**Interfaces:**
- Produces (em `app.py`):
  - `parcela_centavos(total_centavos: int, n: int) -> int`: divisão inteira arredondada para o centavo mais próximo (meio sobe).
  - `projecao(con, inicio: str, n_meses: int = 12) -> dict` com este formato (listas de `n_meses` itens, na ordem dos meses; valores em reais):

```
{"inicio": "2026-11", "meses": ["2026-11", ...],
 "entradas": [{"valor": 9800.0, "origem": "digitada"|"real"|"vazia"}, ...],
 "base": {"recorrencias": [...], "parcelas": [...], "avulsos": [...]},
 "previstas": [{"id", "descricao", "total", "n_parcelas", "primeira_parcela": "AAAA-MM", "valores": [...]}],
 "cenarios": [{"id": None|int, "nome", "contas": [<mesmo formato de previstas>],
               "despesas": [...], "saldo": [...], "acumulado": [...],
               "comprometimento": [float|None, ...],   # despesas / entradas, 0.56 = 56%
               "pior_mes": {"mes": "2026-02", "saldo": -300.0}}]}   # menor saldo do cenário
```

  O primeiro item de `cenarios` é sempre `{"id": None, "nome": "Sem a compra", "contas": []}` (não existe no banco); depois vêm os cenários do banco por `ordem, id`. `despesas` de um cenário = recorrências + parcelas + avulsos + previstas + contas do cenário, mês a mês.
- Tabelas: `projecao_entradas(mes TEXT PRIMARY KEY, valor_centavos INTEGER NOT NULL)`; `cenarios(id, nome TEXT NOT NULL UNIQUE COLLATE NOCASE, ordem INTEGER NOT NULL DEFAULT 0)`; `projecao_contas(id, cenario_id INTEGER REFERENCES cenarios(id) ON DELETE CASCADE, descricao TEXT NOT NULL, total_centavos INTEGER NOT NULL CHECK (total_centavos > 0), n_parcelas INTEGER NOT NULL CHECK (n_parcelas >= 1), primeira_parcela TEXT NOT NULL)`. `cenario_id` NULL = conta prevista (vale para todos os cenários).

- [ ] **Step 1: Write the failing tests** em `tests/test_projecoes.py`, classe base `BancoTemporario(unittest.TestCase)` cujo `setUp` cria um diretório temporário e aponta `app.DB_PATH` e `app.BACKUPS` para dentro dele, chama `app.iniciar_banco()` e restaura no `tearDown` (inserir `sys.path` da raiz do repo para importar `app`). Testes:
  - `test_parcela_centavos`: `(10000, 3) == 3333`, `(10000, 1) == 10000`, `(10001, 2) == 5001`.
  - `test_cenario_base_so_tem_despesas_reais`: com uma recorrência de 3000 (início antes do horizonte) e uma entrada real de 9800 em `2026-11` (tabela `entradas`), `projecao(con, "2026-11")["cenarios"][0]` tem `despesas[0] == 3000.0`, `saldo[0] == 6800.0`, `comprometimento[0]` ≈ `0.306`, e `entradas[0] == {"valor": 9800.0, "origem": "real"}`.
  - `test_entrada_digitada_sobrepoe_real_e_zero_nao_e_vazio`: linha em `projecao_entradas` com 11000 em `2026-11` → origem `"digitada"`, valor 11000; linha com 0 → origem `"digitada"`, valor 0; mês sem linha nem entrada real → `{"valor": 0.0, "origem": "vazia"}`.
  - `test_comprometimento_none_sem_entrada`: mês com entrada zero/vazia → `comprometimento[i] is None` e `saldo[i]` negativo igual a −despesas.
  - `test_conta_de_cenario_parcelas`: conta de 3000 em 6x com `primeira_parcela="2026-12"` num cenário → `valores` = `[0, 500, 500, 500, 500, 500, 500, 0, ...]` (12 itens) e `despesas` do cenário = base + 500 nesses meses, enquanto `cenarios[0]` não muda.
  - `test_conta_iniciada_antes_do_horizonte`: 12x de 1200 com primeira parcela em `2026-09` (inicio da projeção `2026-11`) → só 10 parcelas dentro do horizonte, `valores[0]` é a parcela 3 (100.0); conta de 1 parcela fora do horizonte → tudo zero.
  - `test_previstas_valem_para_todos_os_cenarios`: conta com `cenario_id` NULL (total 650, 1 parcela, `primeira_parcela="2027-02"`) soma em `cenarios[0]` e em um segundo cenário.
  - `test_acumulado_e_pior_mes`: saldos `[100, -300, 200, ...]` dão `acumulado[:3] == [100, -200, 0]` e `pior_mes == {"mes": <segundo mês>, "saldo": -300.0}`.
  - `test_projecao_nao_altera_totais_reais`: `visao_mes` e `resumo_ano` do banco iguais antes e depois de inserir cenário, conta de cenário e conta prevista.

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m unittest discover -s tests -v`
Expected: FAIL/ERROR (`AttributeError: module 'app' has no attribute 'projecao'` e tabelas ausentes).

- [ ] **Step 3: Implement** as três tabelas em `SCHEMA` e, na seção nova de `app.py`, `parcela_centavos` e `projecao` (assinaturas acima). Pontos que o teste não determina: use `visao_mes(con, mes)["totais"]` para recorrências/parcelas/avulsos e para a entrada real (`totais["entradas"]`); o valor de uma conta num mês é `parcela_centavos(total, n)` se `1 <= numero_parcela(primeira_parcela, mes) <= n`, senão 0 (`numero_parcela` já aceita `AAAA-MM`); `pior_mes` é o mês de menor saldo (o primeiro, em empate); arredonde saldo/acumulado com `round(x, 2)`; confirme que `iniciar_banco()` roda no caminho WSGI (`application`) para o `CREATE IF NOT EXISTS` valer em produção.

- [ ] **Step 4: Run to verify they pass**

Run: `python3 -m unittest discover -s tests -v`
Expected: todos PASS.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_projecoes.py
git commit -m "Projeções: tabelas e cálculo dos cenários"
```

---

### Task 2: API de Projeções (gravar, apagar, duplicar)

**Files:**
- Modify: `app.py` (seção de projeções; `ROTAS`)
- Modify: `tests/test_projecoes.py`

**Interfaces:**
- Consumes: `projecao`, tabelas da Task 1, `exigir`, `exigir_mes`, `centavos`, `apagar`, `ErroEntrada`.
- Produces (rotas; corpo JSON; sucesso devolve o formato padrão `{"ok": true, "id": ...}`):
  - `GET /api/projecao` → `projecao(con, date.today().isoformat()[:7])`
  - `PUT /api/projecao/entradas` `{"mes": "AAAA-MM", "valor": número|texto|vazio}`: vazio apaga a linha (volta ao valor real); aceita o mesmo texto que `centavos()`. Função `salvar_entrada_projetada(con, d)`.
  - `POST /api/projecao/cenarios` `{"nome"}`; `PUT /api/projecao/cenarios/(\d+)` `{"nome"}`; `DELETE /api/projecao/cenarios/(\d+)`; `POST /api/projecao/cenarios/(\d+)/duplicar` (nome novo "Cópia de X", com sufixo " 2", " 3"... se já existir; copia as contas; devolve o id do novo). Funções `salvar_cenario(con, d, cid=None)`, `duplicar_cenario(con, cid, _d)`.
  - `POST /api/projecao/contas` `{"cenario_id": int|null, "contas": [{"descricao", "valor", "n_parcelas", "primeira_parcela": "AAAA-MM"}, ...]}`: grava todas ou nenhuma; devolve a lista dos ids. Função `salvar_contas_projecao(con, d)`.
  - `PUT /api/projecao/contas/(\d+)` com uma conta só (mesmos campos, `cenario_id` não muda); `DELETE /api/projecao/contas/(\d+)` via `apagar("projecao_contas")`. Função `salvar_conta_projecao(con, d, conta_id)`.
- Validação: `valor` > 0 (campo `valor` é o **total**); `n_parcelas` inteiro ≥ 1; mês no formato `AAAA-MM`; `cenario_id` existente ou `None`; `contas` não vazia; nome de cenário não vazio e único (sem diferenciar maiúsculas), com mensagem `Já existe o cenário '<nome>'` no padrão de `salvar_fonte`.

- [ ] **Step 1: Write the failing tests**, usando uma função auxiliar `chamar(metodo, caminho, corpo=None)` que monta `app.Requisicao(metodo, caminho, "", None, lambda: json.dumps(corpo).encode() if corpo is not None else b"", "127.0.0.1")`, passa por `app.tratar` e devolve `(status, json)`:
  - `test_lote_grava_todas_as_contas`: POST com 2 contas → 200 e `GET /api/projecao` mostra as duas no cenário.
  - `test_lote_com_linha_invalida_nao_grava_nenhuma`: 2ª linha com `n_parcelas: 0` → 400 e `projecao_contas` continua vazia (idem `valor: 0`, `valor: "abc"`, `primeira_parcela: "2026-13"`, `cenario_id: 999`, `contas: []`).
  - `test_entrada_projetada_vazio_remove_e_zero_fica`: PUT `valor: ""` apaga a linha; PUT `valor: "1.234,56"` não é aceito por `centavos()` (400 `Valor inválido`), PUT `valor: 1234.56` grava 123456; PUT `valor: 0` grava 0.
  - `test_cenario_nome_vazio_ou_repetido`: 400 nos dois casos (repetido com caixa diferente).
  - `test_apagar_cenario_apaga_suas_contas_e_preserva_previstas`: DELETE do cenário → contas dele somem, conta prevista (`cenario_id` NULL) continua.
  - `test_duplicar_cenario_copia_contas`: duplicar cenário com 2 contas → novo cenário com as mesmas 2 contas (ids diferentes) e nome `Cópia de <nome>`; duplicar de novo → `Cópia de <nome> 2`.
  - `test_editar_e_apagar_conta`: PUT altera total/parcelas; DELETE remove; PUT em id inexistente → 400 `Conta não encontrada`.

- [ ] **Step 2: Run to verify they fail**

Run: `python3 -m unittest discover -s tests -v`
Expected: FAIL (rotas devolvem 404 "Rota não encontrada").

- [ ] **Step 3: Implement** as funções acima e acrescentar as rotas em `ROTAS` (a `GET /api/projecao` usa `date.today()`, como `listar_recorrencias` já faz). `salvar_entrada_projetada` segue o formato de `salvar_entrada`. O lote roda dentro da transação de `conectar()`, então um `ErroEntrada` no meio desfaz tudo: valide todas as linhas antes de inserir.

- [ ] **Step 4: Run to verify they pass**

Run: `python3 -m unittest discover -s tests -v`
Expected: todos PASS (Task 1 incluída).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_projecoes.py
git commit -m "Projeções: API de entradas previstas, cenários e contas"
```

---

### Task 3: Tela de Projeções (tabela, entradas, contas, cenários)

**Files:**
- Modify: `static/index.html` (link `<a href="#projecoes" data-aba="projecoes">Projeções</a>` depois de Entradas)
- Modify: `static/app.js` (nova `telaProjecoes()`; registrar em `telas` dentro de `render()`; `estado.cenarioSel` guarda o cenário aberto, `null` = "Sem a compra")
- Modify: `static/style.css`

**Interfaces:**
- Consumes: `GET /api/projecao` e as rotas da Task 2; helpers existentes `api`, `abrirModal` (o callback `salvar(dados, form)` recebe o `<form>`, use-o para ler as linhas repetidas), `lerValor`/`exigirValor`, `aviso`, `R`, `numero`, `esc`, `sinal`, `MESES_CURTOS`.
- Produces: `telaProjecoes()` e a função `pintarProjecao(d)` que atualiza no lugar todas as células calculadas (e, na Task 4, o gráfico) a partir de um `GET /api/projecao` novo, sem recriar os `<input>`.

- [ ] **Step 1: Verification plan** (não há framework de front-end; use um script descartável fora do repositório, no diretório de scratchpad, com Chrome headless via DevTools como na correção da aba Entradas, apontando `CF_DADOS` para um banco temporário). Os checks abaixo valem como "teste": escreva-os antes da implementação e veja-os falhar (aba inexistente).
  - A aba "Projeções" aparece e abre `#projecoes`; a tabela tem 12 colunas de mês a partir do mês atual e as linhas, nesta ordem: Entradas previstas, Recorrências, Parcelas em andamento, Lançamentos avulsos, Contas previstas, Do cenário, Saldo do mês, Acumulado, Comprometimento.
  - Digitar `4636,35 + 1936,59` numa célula de entrada e sair do campo grava 6572.94, atualiza saldo/acumulado/comprometimento **sem recriar o input** (o `activeElement` continua o mesmo nó) e a célula mostra a origem (`digitada`/`real`).
  - Editar a célula A e clicar direto na B mantém o foco em B; as setas ← → movem o cursor (teclas reais via `Input.dispatchKeyEvent`); Enter tira o foco.
  - Saldo negativo aparece com a classe `negativo` e o valor em R$; comprometimento com entrada zero mostra "–".
  - Cenário: criar "Notebook 6x", abrir o formulário "+ conta" com 2 linhas (botão "+ linha" acrescenta uma; um único Salvar grava as duas), ver a linha "Do cenário" somar as parcelas, trocar para "Sem a compra" e ver a linha zerada; duplicar, renomear e apagar o cenário selecionado volta para "Sem a compra".
  - Contas previstas: "+ conta prevista" (mesmo formulário de linhas) soma em todos os cenários; cada conta (prevista ou de cenário) tem editar e apagar.
  - Aba do cenário não existe para "Sem a compra" em renomear/apagar/adicionar conta.
  - O destaque "pior mês" mostra mês e saldo do cenário selecionado.
  - Mês sem entrada e sem real: saldo = −despesas, comprometimento "–".
  - Tema escuro e largura de celular (390 px): sem rolagem horizontal da página (a tabela rola dentro do cartão `.rolagem`, como a de Entradas).

- [ ] **Step 2: Run checks to verify they fail**

Run: o script de verificação contra `python3 app.py --porta <livre>` com `CF_DADOS` temporário.
Expected: falham (sem a aba).

- [ ] **Step 3: Implement** `telaProjecoes` seguindo o padrão de `telaEntradas` (cartão com tabela `.rolagem`, células editáveis com `onchange`, mesma sintaxe de soma via `lerValor`, `onkeydown` só com `if (e.key === "Enter") inp.blur();`). Ao salvar entrada, chamar `PUT /api/projecao/entradas`, buscar `GET /api/projecao` e chamar `pintarProjecao` (nunca `render()`). Formulários de conta via `abrirModal` com linhas repetidas (`name="descricao"`, `name="valor"`, `name="n_parcelas"`, `name="primeira_parcela"` com `<input type="month">`), lendo as linhas do `form` com `form.querySelectorAll`; `valor` passa por `exigirValor`. Editar conta individual usa o mesmo formulário com uma linha e `PUT`; apagar usa o callback `apagar` do modal. O `<select>`/abas de cenário ficam no topo; o cenário selecionado vive em `estado.cenarioSel` e, se o id deixar de existir, volta para `null`. Estilos novos só com variáveis CSS já existentes (`--negativo`, `--linha`, `--suave`...).

- [ ] **Step 4: Run checks to verify they pass**

Run: o mesmo script. Expected: todos os checks do Step 1 passam; `python3 -m unittest discover -s tests` continua PASS.

- [ ] **Step 5: Commit**

```bash
git add static/index.html static/app.js static/style.css
git commit -m "Projeções: tela com tabela, entradas previstas, contas e cenários"
```

---

### Task 4: Gráfico de linhas dos cenários

**Files:**
- Modify: `static/app.js` (`graficoProjecao(d, modo, selecionado)`; ligar em `telaProjecoes` e em `pintarProjecao`)
- Modify: `static/style.css` (variáveis `--cen-1` ... `--cen-6` nos temas claro e escuro, e `--ref` para a linha de referência)

**Interfaces:**
- Consumes: `d.cenarios[i].comprometimento` e `.saldo`, `d.meses`; `pintarProjecao` (Task 3).
- Produces: `graficoProjecao(d: dict, modo: "pct" | "saldo", selecionado: number|null) -> string` (SVG como string, `viewBox` responsivo como o de `graficoAno`).

- [ ] **Step 1: Verification plan** (mesmo script de Task 3):
  - O SVG tem uma `<path>` por cenário (incluindo "Sem a compra"), todas mês a mês (12 pontos), nunca o acumulado; legenda com o nome de cada cenário; cada ponto tem `<title>` com mês e valor (`56%` ou `R$ …`).
  - Botão alterna `pct` ↔ `saldo`: eixo e valores mudam; linha de referência em 100% (modo `pct`) ou R$ 0 (modo `saldo`); com todos os valores abaixo de 100% o eixo ainda inclui a referência.
  - Meses com comprometimento `None` não geram ponto nem quebram o `path` (a linha interrompe naquele mês).
  - O cenário selecionado tem traço mais grosso; com mais de 6 cenários as cores se repetem com um `stroke-dasharray` diferente, sem erro.
  - Editar uma entrada ou conta atualiza o gráfico (via `pintarProjecao`) sem perder o foco do campo editado.
  - Cores legíveis no tema claro e no escuro; caber em 390 px de largura.

- [ ] **Step 2: Run checks to verify they fail**

Run: o script de verificação. Expected: falham (sem gráfico).

- [ ] **Step 3: Implement** `graficoProjecao` no estilo de `graficoAno` (margens, grade, escala com passo "redondo", `<title>` nos pontos). Em modo `pct` o eixo vai de 0 até o maior entre 100% e o máximo dos dados (arredondado); em modo `saldo`, do mínimo ao máximo incluindo 0. Linha de referência tracejada com `var(--ref)`. Paleta: 6 cores distinguíveis entre si e do fundo nos dois temas, definidas como variáveis em `:root` e no bloco `prefers-color-scheme: dark`; cores repetidas ganham `stroke-dasharray`. O botão de modo fica no cabeçalho do cartão do gráfico e só redesenha o SVG. Legenda como a de Resumo (`.legenda`).

- [ ] **Step 4: Run checks to verify they pass**

Run: o mesmo script. Expected: todos passam; `python3 -m unittest discover -s tests` continua PASS.

- [ ] **Step 5: Commit**

```bash
git add static/app.js static/style.css
git commit -m "Projeções: gráfico de linhas com os cenários sobrepostos"
```

---

### Task 5: Documentação e verificação final

**Files:**
- Modify: `README.md` (descrição de uma linha da aba Projeções no primeiro parágrafo; nenhuma mudança de instalação)

- [ ] **Step 1: Atualize o README** acrescentando "projeções por cenário" à lista do primeiro parágrafo.

- [ ] **Step 2: Verificação do todo**

Run: `python3 -m unittest discover -s tests -v` e o script de verificação das Tasks 3 e 4 contra um banco temporário; depois confira que `git status` não mostra `dados.db` modificado e que `git diff 3eafed5 -- app.py` não altera nenhuma tabela existente de `SCHEMA`.
Expected: tudo PASS; só tabelas novas no schema.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: aba Projeções"
```
