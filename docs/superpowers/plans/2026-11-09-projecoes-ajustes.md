# Projeções: ajustar despesas fixas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Na aba Projeções, permitir alterar, cancelar ou pausar recorrências e parcelas em andamento só dentro da projeção, com alcance geral ou por cenário, e comparar cada cenário com e sem ajustes no gráfico.

**Architecture:** Nova tabela `projecao_ajustes`. `projecao()` em `app.py` passa a calcular, por cenário, as linhas Recorrências e Parcelas já ajustadas, a lista de itens de cada mês (para o painel) e a versão "sem ajustes" (para o gráfico). O front ganha o painel "Despesas de [mês]", a janela de edição e o controle "Mostrar sem ajustes", sem recriar os `<input>` existentes.

**Tech Stack:** Python (biblioteca padrão) + SQLite, JavaScript puro, SVG feito à mão, `unittest`, e2e em Chrome headless (`tests/e2e_projecoes.js`).

**Spec:** `docs/superpowers/specs/2026-11-09-projecoes-ajustes-design.md`

## Global Constraints

- Sem dependências novas; sem frameworks. Textos de interface em português do Brasil.
- Dados novos só em tabela nova, criada pela rotina existente do banco (`CREATE TABLE IF NOT EXISTS` no esquema de `app.py`); o `dados.db` real nunca é tocado pelos testes (usar `BancoTemporario`).
- Valores em centavos inteiros no banco; `reais()` na saída da API.
- Validação com `ErroEntrada` (resposta 400), nunca erro 500. Valores via `centavos()`, que já recusa `inf`/`nan`.
- Anti-objetivo: um ajuste nunca altera `recorrencias`, `parcelamentos`, `pagamentos` nem qualquer total das abas Mês/Resumo.
- Avulsos não são ajustáveis. Ajuste só tem efeito nos meses em que a despesa existe.
- Precedência: ajuste do cenário vence o geral; entre dois do mesmo tipo vale o de maior `id`.
- "Sem a compra" só aceita ajustes gerais.
- Salvar não pode recriar os `<input>` da tabela nem derrubar o foco (commit 761bf1b).
- Duplicar cenário copia só ajustes do cenário. Apagar cenário apaga só os ajustes dele.

## Review Focus

- Ajuste em parcela cujo mês está fora da vida dela (antes da 1ª ou depois da última): não cria despesa nova. Teste na Task 1.
- Valor negativo, `inf`, texto, mês final anterior ao inicial, tipo inválido, `ref_id` inexistente, cenário inexistente, escopo "cenario" sem cenário: 400, nunca 500, e nada gravado. Teste na Task 2.
- Recorrência ou parcelamento real apagado: os ajustes dele somem junto e a projeção continua carregando. Teste na Task 2.
- Desfazer um mês no meio de um ajuste de intervalo ou "em diante": só aquele mês volta ao normal e o resto continua ajustado. Teste na Task 2.
- Cenário com ajuste de cenário e geral para a mesma despesa/mês: vale o do cenário; "Sem a compra" ignora os de cenário. Teste na Task 1.

---

### Task 1: Esquema e cálculo da projeção com ajustes

**Files:**
- Modify: `app.py` (esquema perto da linha 113; `projecao()` linha 630)
- Test: `tests/test_projecoes.py`

**Interfaces:**
- Produces (tabela): `projecao_ajustes(id INTEGER PRIMARY KEY, cenario_id INTEGER NULL REFERENCES cenarios(id) ON DELETE CASCADE, tipo TEXT CHECK (tipo IN ('rec','parc')), ref_id INTEGER, mes_inicio TEXT, mes_fim TEXT NULL, valor_centavos INTEGER CHECK (valor_centavos >= 0))`. `cenario_id` NULL = geral.
- Produces: `ajuste_vigente(ajustes: list[sqlite3.Row], tipo: str, ref_id: int, mes: str, cenario_id: int | None) -> sqlite3.Row | None`. Considera só ajustes com `mes_inicio <= mes <= (mes_fim or ∞)`, `tipo`/`ref_id` iguais, e `cenario_id` NULL ou igual ao pedido (com `cenario_id=None` pedido, só os gerais). Precedência da spec.
- Produces (payload de `projecao()`): `d["base"]` continua com os valores **originais**. Cada item de `d["cenarios"]` ganha:
  - `base`: `{"recorrencias": [float]*12, "parcelas": [float]*12}` já ajustados. `despesas`, `saldo`, `acumulado`, `comprometimento`, `pior_mes` passam a usar esses valores.
  - `sem_ajustes`: `{"despesas": [...], "saldo": [...], "comprometimento": [...]}` (mesmas fórmulas, sem nenhum ajuste, com as contas do cenário).
  - `itens`: lista de 12 listas; cada elemento `{"tipo","id","descricao","parcela","n_parcelas","original","valor","ajuste"}` onde `parcela`/`n_parcelas` são `None` para recorrência e `ajuste` é `None` ou `{"id": int, "escopo": "geral"|"cenario", "mes_inicio": str, "mes_fim": str|None}`. Só recorrências e parcelas.

- [ ] **Step 1: Escrever os testes que falham** em `tests/test_projecoes.py` (nova classe `TestAjustes(BancoTemporario)`, com helper `ajuste(con, cenario_id, tipo, ref_id, inicio, fim, valor)` que insere em `projecao_ajustes`):
  - `test_sem_ajustes_nada_muda`: `base` e `sem_ajustes` coincidem com `despesas`/`saldo` quando não há ajustes.
  - `test_ajuste_so_neste_mes`: recorrência 3000 (`recorrencia()`), ajuste geral `rec` de `INICIO` a `INICIO` com valor 2000 → despesas[0] == 2000.0, despesas[1] == 3000.0; `sem_ajustes["despesas"][0] == 3000.0`; `itens[0][0]` tem `original == 3000.0`, `valor == 2000.0`, `ajuste["escopo"] == "geral"`.
  - `test_ajuste_em_diante_e_intervalo_pausa`: `mes_fim=None` vale do mês em diante até o 12º; `mes_fim` = 2 meses depois, valor 0 → despesas voltam a 3000 no 3º mês.
  - `test_ajuste_de_cenario_vale_so_nele`: ajuste com `cenario_id` de um cenário não muda "Sem a compra" nem outro cenário.
  - `test_ajuste_do_cenario_vence_o_geral`: geral 2000 e do cenário 1000 para a mesma recorrência/mês: cenário mostra 1000, "Sem a compra" 2000.
  - `test_mais_recente_vence_no_mesmo_nivel`: dois gerais sobrepostos; vale o de maior id.
  - `test_ajuste_em_parcela_e_fora_da_vida`: parcelamento de 3 parcelas a partir de `INICIO` (inserir direto em `parcelamentos`, `categoria_id=1`); ajuste de `parc` de `INICIO` a +11 meses valor 50 → meses 0–2 valem 50, meses 3+ continuam 0 e `itens[3]` está vazio de parcelas.
  - `test_ajuste_nao_toca_os_totais_reais`: `app.visao_mes(con, INICIO)["totais"]` idêntico antes e depois de criar ajuste; tabelas `recorrencias`, `parcelamentos`, `pagamentos` com contagem inalterada.
  - `test_sem_a_compra_ignora_ajuste_de_cenario_no_sem_ajustes`: `sem_ajustes` dos cenários nunca inclui nenhum ajuste.

- [ ] **Step 2: Rodar e ver falhar**

Run: `python3 -m unittest tests.test_projecoes.TestAjustes -v`
Expected: FAIL (tabela `projecao_ajustes` e chaves novas inexistentes).

- [ ] **Step 3: Criar a tabela** `projecao_ajustes` no esquema de `app.py`, logo após `projecao_contas`, com o comentário "Projeções: ajuste de valor de recorrência/parcela só na projeção; cenario_id NULL = vale para todos".

- [ ] **Step 4: Implementar `ajuste_vigente`** em `app.py` (função pura, antes de `projecao`).

- [ ] **Step 5: Reescrever `projecao()`** para: carregar todos os `projecao_ajustes` uma vez; guardar, por mês, os itens originais de `visao_mes(con, m)["recorrencias"]` e `["parcelas"]` (já têm `tipo`, `id`, `descricao`, `valor`, e `parcela`/`n_parcelas` para parcelas); em `resultado(cid, nome, contas)` calcular `valor` de cada item com `ajuste_vigente(..., cid)` (cenário "Sem a compra" usa `cid=None`), montar `base`, `itens`, `despesas`, `sem_ajustes` com o resultado de antes (originais + avulsos + contas). Manter `avulsos` e `previstas` como estão e o `d["base"]` original. Arredondar com `round(..., 2)` como o código atual.

- [ ] **Step 6: Rodar** `python3 -m unittest tests.test_projecoes -v` — Expected: tudo PASS, inclusive os testes antigos.

- [ ] **Step 7: Commit**

```bash
git add app.py tests/test_projecoes.py
git commit -m "Projeções: cálculo com ajustes de recorrências e parcelas"
```

---

### Task 2: Criar, apagar e desfazer ajustes pela API

**Files:**
- Modify: `app.py` (novas funções antes da seção `# ---- HTTP`, `apagar()` linha ~776, `duplicar_cenario()` linha ~696, `ROTAS`)
- Test: `tests/test_projecoes.py` (classe `TestAjustesApi(BancoTemporario)`, usando o helper `chamar(metodo, caminho, corpo)` já presente nos testes de API)

**Interfaces:**
- Consumes: `projecao_ajustes`, `ajuste_vigente`, `exigir_mes`, `centavos`, `ErroEntrada`.
- Produces: `salvar_ajuste(con, d: dict) -> int`; corpo `{"tipo": "rec"|"parc", "ref_id": int, "valor": str|number, "mes_inicio": "AAAA-MM", "mes_fim": "AAAA-MM"|null, "escopo": "geral"|"cenario", "cenario_id": int|null}`. Validações: tipo válido; `ref_id` existe em `recorrencias`/`parcelamentos`; valor via `centavos` ≥ 0; `mes_fim` ≥ `mes_inicio` quando informado; `escopo="cenario"` exige `cenario_id` de cenário existente; `escopo="geral"` ignora/zera `cenario_id`.
- Produces: `desfazer_mes_ajuste(con, ajuste_id: int, d: dict) -> None`, corpo `{"mes": "AAAA-MM"}`: o mês deixa de ser ajustado por esse ajuste. Se era o único mês, apaga o ajuste; se era a ponta, encurta; se estava no meio (ou em um ajuste sem fim), divide em dois ajustes (o segundo mantém `mes_fim`, e para o ajuste sem fim o segundo também fica sem fim). Mês fora do intervalo ou ajuste inexistente → `ErroEntrada`.
- Produces (rotas): `POST /api/projecao/ajustes` → `{"id": ...}`; `DELETE /api/projecao/ajustes/(\d+)` (ajuste inteiro, via `apagar("projecao_ajustes")`); `POST /api/projecao/ajustes/(\d+)/desfazer-mes`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `test_cria_ajuste_geral_e_aparece_na_projecao`: POST válido → 200, e `GET /api/projecao` mostra o valor ajustado em `cenarios[0]["itens"]`.
  - `test_cria_ajuste_de_cenario`: escopo `cenario` com `cenario_id` real; aparece só nesse cenário.
  - `test_ajuste_invalido_e_recusado_sem_erro_500` (cada caso espera 400 e `SELECT COUNT(*) FROM projecao_ajustes` == 0): `valor` `"-1"`, `"inf"`, `"abc"`, `float("inf")`; `mes_fim` anterior ao `mes_inicio`; `mes_inicio` `"2026-13"`; `tipo` `"avulso"`; `ref_id` inexistente; `escopo="cenario"` sem `cenario_id`; `cenario_id` inexistente.
  - `test_valor_zero_cancela`: valor `"0"` aceito e a despesa do mês vale 0.
  - `test_desfazer_mes_no_meio_divide_o_ajuste`: ajuste `INICIO` a +5 meses; desfazer +2 → meses 0–1 e 3–5 ajustados, mês 2 original.
  - `test_desfazer_mes_na_ponta_encurta` e `test_desfazer_mes_unico_apaga`.
  - `test_desfazer_mes_de_ajuste_sem_fim`: sem fim, desfazer um mês do meio mantém o resto até o fim do horizonte ajustado.
  - `test_desfazer_mes_fora_do_intervalo_400`.
  - `test_apagar_recorrencia_real_apaga_ajustes_dela`: `DELETE /api/recorrencias/<id>` → ajustes dela sumiram; `GET /api/projecao` ainda 200. Idem para parcelamento.
  - `test_apagar_cenario_apaga_so_ajustes_dele`: gerais continuam.
  - `test_duplicar_cenario_copia_ajustes_do_cenario_mas_nao_os_gerais`: após duplicar, `COUNT` de ajustes do novo cenário == do original e gerais não duplicados.

- [ ] **Step 2: Rodar e ver falhar**

Run: `python3 -m unittest tests.test_projecoes.TestAjustesApi -v`
Expected: FAIL (rotas inexistentes).

- [ ] **Step 3: Implementar `salvar_ajuste`, `desfazer_mes_ajuste` e registrar as 3 rotas** em `ROTAS`, seguindo o formato das rotas de contas. Para mês anterior/posterior use `somar_meses`.

- [ ] **Step 4: Estender `apagar(tabela, tipo_pag)`** para, quando `tipo_pag` for informado (`'rec'`/`'parc'`), também executar `DELETE FROM projecao_ajustes WHERE tipo = ? AND ref_id = ?`.

- [ ] **Step 5: Estender `duplicar_cenario`** para copiar os ajustes com `cenario_id` do original para o novo (mesmo padrão do `INSERT ... SELECT` das contas).

- [ ] **Step 6: Rodar** `python3 -m unittest tests.test_projecoes -v` — Expected: tudo PASS.

- [ ] **Step 7: Commit**

```bash
git add app.py tests/test_projecoes.py
git commit -m "Projeções: API de ajustes (criar, apagar, desfazer mês)"
```

---

### Task 3: Painel "Despesas de [mês]" e janela de edição

**Files:**
- Modify: `static/app.js` (`telaProjecoes`, linha 635; novo `modalAjuste`), `static/style.css`, `static/index.html` só se precisar de novo elemento
- Test: `tests/e2e_projecoes.js` (nova fase, ver Task 5) — nesta task a verificação é manual com o servidor + testes Python da API já verdes

**Interfaces:**
- Consumes: payload da Task 1 (`cen.itens`, `cen.base`, `d.base`) e rotas da Task 2.
- Produces: estado `estado.mesAberto` (índice 0–11 ou `null`); `modalAjuste({ item, mes, cen })`; `modalDesfazer({ item, mes })`.

- [ ] **Step 1: Linhas Recorrências e Parcelas** da tabela passam a ler `cen.base.recorrencias[i]` e `cen.base.parcelas[i]` em `pintar()` (em vez de `d.base`).

- [ ] **Step 2: Cabeçalho de mês clicável.** Cada `<th>` de mês vira botão/`data-mes-i`; clicar define `estado.mesAberto` (clicar de novo fecha), destaca a coluna e mostra o painel. Meses cujos `cen.itens[i]` têm algum `ajuste` ganham uma marca discreta (ponto) no cabeçalho. O painel é atualizado por `pintar()` sem tocar nos `<input data-pm>`.

- [ ] **Step 3: Painel** (seção `cartao` abaixo da tabela, título "Despesas de {nomeMes}"): uma linha por item de `cen.itens[mesAberto]` com descrição (parcelas como "Notebook · parcela 2/6"), valor atual, botão **editar**. Item com ajuste mostra "R$ novo, era R$ original", o selo "geral" ou "só neste cenário" e botão **desfazer**; valor 0 aparece riscado com "cancelado na projeção". Painel vazio: "Nenhuma recorrência ou parcela neste mês." Em "Sem a compra" o painel também aparece e permite editar (só escopo geral).

- [ ] **Step 4: `modalAjuste`** (via `abrirModal` existente): campo "Novo valor" (aceita a sintaxe de `lerValor`/`exigirValor`, `0` cancela), "Vale para" (rádios: só este mês / deste mês em diante / deste mês até [campo `type="month"`], campo obrigatório nessa opção e não anterior ao mês aberto), "Aplicar em" (rádios: todos os cenários / só em {nome}, a segunda opção ausente em "Sem a compra"), e o aviso "Não altera Mês, Recorrências nem nenhum lançamento real." Salvar faz `POST /api/projecao/ajustes`, recarrega `d` com `GET /api/projecao` e chama `pintar()` (sem `render()` completo).

- [ ] **Step 5: `modalDesfazer`.** Desfazer num ajuste de um mês só (ou sem mais meses) chama `DELETE /api/projecao/ajustes/<id>` direto. Em ajuste que cobre vários meses, pergunta com dois botões: "Só em {mês}" (`POST .../desfazer-mes`) e "O ajuste inteiro" (`DELETE`).

- [ ] **Step 6: Atualizar a dica** do topo da aba para citar os ajustes, e o texto de confirmação de apagar cenário ("e os ajustes dele").

- [ ] **Step 7: Verificar manualmente** subindo o app com banco temporário (`CF_DADOS=$(mktemp -d) python3 app.py --porta 8765 --sem-navegador`), criando uma recorrência e um cenário e exercitando: ajuste só neste mês, em diante, intervalo, cancelar com 0, geral versus de cenário, desfazer no meio. Expected: a tabela e o "pior mês" mudam na hora e o foco de um `<input data-pm>` selecionado não se perde.

- [ ] **Step 8: Commit**

```bash
git add static/app.js static/style.css static/index.html
git commit -m "Projeções: painel de despesas do mês com edição de ajustes"
```

---

### Task 4: Gráfico com e sem ajustes

**Files:**
- Modify: `static/app.js` (`graficoProjecao` linha 597, `pintar()`, estado inicial linha 23), `static/style.css`

**Interfaces:**
- Consumes: `cenario.sem_ajustes` (Task 1).
- Produces: `estado.mostrarSemAjustes` (boolean, `false` por padrão); `graficoProjecao(d, modo, selecionado, semAjustes)`.

- [ ] **Step 1:** Adicionar `mostrarSemAjustes: false` ao `estado` e um botão/checkbox **"Mostrar sem ajustes"** no cabeçalho do cartão do gráfico (ao lado do botão de eixo), que alterna e chama `pintar()`.

- [ ] **Step 2:** Em `graficoProjecao`, quando `semAjustes` for verdadeiro, desenhar para cada cenário uma segunda linha com `c.sem_ajustes` (mesma função de valor por modo `pct`/`saldo`), mesma cor, `stroke-dasharray="5 4"`, espessura menor, sem círculos grandes; incluir esses valores no cálculo de `min`/`max` do eixo. Só desenhar a versão sem ajustes de um cenário se ela diferir da ajustada em algum mês (evita linhas duplicadas sobre linhas).

- [ ] **Step 3:** Tooltips (`<title>`) distinguem "com ajustes" e "sem ajustes"; a legenda ganha uma entrada "tracejado = sem ajustes" quando ligado. As linhas dos cenários além de 6 já usam tracejados próprios (`tracejadoCen`): a linha "sem ajustes" usa traço fino e mais curto e precisa ser distinguível; verificar nos dois temas e em tela estreita.

- [ ] **Step 4: Verificar manualmente:** com um ajuste ativo, ligar o controle e ver cada cenário com as duas linhas; sem ajuste, ligar e não ver linhas duplicadas; alternar eixo % ↔ R$ com o controle ligado; tema escuro e viewport de 375 px.

- [ ] **Step 5: Commit**

```bash
git add static/app.js static/style.css
git commit -m "Projeções: gráfico com opção de ver cenários sem ajustes"
```

---

### Task 5: Teste de ponta a ponta e documentação

**Files:**
- Modify: `tests/e2e_projecoes.js` (nova fase `"ajustes"`, chamada também pela fase `"completa"`), `tests/test_e2e_projecoes.py` só se a fase exigir argumento novo, `README.md` (seção da aba Projeções)

**Interfaces:**
- Consumes: telas e rotas das Tasks 1–4. Usar as funções auxiliares já existentes no arquivo (`clicar`, `preencher`, `esperar`, `check`, `txt`).

- [ ] **Step 1: Escrever a fase e2e `ajustes`** (já falha enquanto a UI não existir; como as Tasks 3–4 já estão prontas, ela deve passar de primeira — se falhar, corrigir o código, não o teste, salvo seletor errado):
  - Criar via API uma recorrência "Combustível" de 900 e outra "Spotify" de 30, e um cenário "Notebook 6x" com uma conta.
  - Abrir o painel de um mês, editar Combustível para 700 "deste mês em diante", "Aplicar em" todos os cenários: a linha Recorrências da tabela muda (`2.130` → `1.930` neste exemplo, conforme os dados do arquivo) e o painel mostra "era".
  - Ajuste de cenário (Spotify = 0, só em "Notebook 6x"): em "Sem a compra" o Spotify continua, no cenário não.
  - Desfazer um mês do meio de um ajuste de intervalo: só aquele mês volta ao original.
  - Ligar "Mostrar sem ajustes": o SVG ganha caminhos tracejados; desligar: some.
  - Nenhum erro de console e o `<input data-pm>` não foi recriado após salvar um ajuste (mesmo teste do `window.__inp`).
  - Confirmar via `GET /api/mes/<mes>` que os totais reais não mudaram.

- [ ] **Step 2: Rodar** `python3 -m unittest discover -s tests -v` — Expected: tudo PASS (o e2e é pulado sem node/google-chrome; avisar se foi pulado).

- [ ] **Step 3: README:** acrescentar na seção da aba Projeções um parágrafo curto sobre ajustes (painel por mês, alcance, geral × por cenário, pausa, gráfico com e sem ajustes, nada real é alterado).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e_projecoes.js tests/test_e2e_projecoes.py README.md
git commit -m "Projeções: teste e2e e README dos ajustes"
```
