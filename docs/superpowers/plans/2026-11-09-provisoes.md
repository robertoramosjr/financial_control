# Provisões — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reservar um valor mensal para despesas variáveis (provisões), lançar compras descontando dessa reserva, e fazer Mês, Resumo e Projeções mostrarem o **disponível** de cada provisão ("Provisionado – Saídas: R$ 500" depois de gastar 100 de 600).

**Architecture:** Tabelas novas `provisoes` e `provisao_meses` (valor de um mês específico) e coluna `lancamentos.provisao_id`, adicionada por migração em `iniciar_banco()`. As compras ligadas continuam em `avulsos`, com etiqueta. `visao_mes()` ganha a lista `provisoes`, cujo valor é o disponível (`max(provisionado − gasto, 0)`, zero em mês terminado), e o total `provisoes`. Resumo e Projeções herdam isso de `visao_mes()`. No front, card "Provisões" nas abas Mês e Recorrências, campo "Descontar da provisão" na compra e linha nova em Projeções.

**Tech Stack:** Python (biblioteca padrão) + SQLite, JavaScript puro, `unittest`, e2e em Chrome headless (`tests/e2e_projecoes.js`).

**Spec:** `docs/superpowers/specs/2026-11-09-provisoes-design.md`

## Global Constraints

- Sem dependências novas; sem frameworks. Textos de interface em português do Brasil.
- Valores em centavos inteiros no banco; `reais()` na saída da API; entrada via `centavos()`.
- Validação com `ErroEntrada` (400), nunca 500. Testes nunca tocam o `dados.db` real (`BancoTemporario`).
- Banco existente precisa continuar abrindo: a coluna nova entra por `ALTER TABLE` condicional, sem recriar `lancamentos`.
- "Mês terminado" = `mes < hoje` (AAAA-MM), com `hoje` = mês de hoje no servidor; testes passam `hoje` explícito.
- Compra com `provisao_id` é gasto real: entra em `avulsos` e `totais.avulsos`, na categoria dela. A provisão soma só o disponível. Total do mês aberto = `max(provisionado, gasto)`; do mês terminado = gasto.
- A sobra não passa para o mês seguinte.

## Review Focus

- Compra ligada a provisão num mês fora da vigência dela (ou com valor do mês 0): o gasto continua contando como avulso e o disponível é 0. Teste na Task 1.
- Banco antigo, com compras e sem a coluna `provisao_id`: abre, migra e preserva as compras; rodar `iniciar_banco()` duas vezes não quebra. Teste na Task 1.
- Apagar provisão que tem compras: as compras perdem a etiqueta e continuam em avulsos com o mesmo valor; some só o disponível. Teste na Task 2.
- Apagar categoria usada só por uma provisão: com `mover_para`, a provisão é movida; sem, dá 400 "Categoria em uso", não 500. Teste na Task 2.
- `provisao_id` inexistente, texto ou booleano no lançamento, e valor negativo, `inf` ou texto na provisão ou no valor do mês: 400 e nada gravado. Teste na Task 2.

---

### Task 1: Esquema, migração e cálculo do mês

**Files:**
- Modify: `app.py` (`SCHEMA`, `iniciar_banco()` linha 174, `avulsos_do_mes()` linha 391, `visao_mes()` linha 412, `projecao()` linha 650)
- Create: `tests/test_provisoes.py`

**Interfaces:**
- Produces (tabelas, no `SCHEMA` depois de `lancamentos`):
  - `provisoes(id INTEGER PRIMARY KEY, descricao TEXT NOT NULL, categoria_id INTEGER NOT NULL REFERENCES categorias(id), valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0), inicio TEXT NOT NULL, fim TEXT)`
  - `provisao_meses(provisao_id INTEGER NOT NULL REFERENCES provisoes(id) ON DELETE CASCADE, mes TEXT NOT NULL, valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0), PRIMARY KEY (provisao_id, mes))`
  - `lancamentos.provisao_id INTEGER REFERENCES provisoes(id)`, adicionada em `iniciar_banco()` depois do `executescript`, só se `PRAGMA table_info(lancamentos)` não a listar (vale também para banco novo).
- Produces: `provisoes_do_mes(con, mes: str, hoje: str) -> list[dict]`. Inclui toda provisão vigente no mês **ou** com valor do mês nele, ordenada por descrição. Cada item tem:
  `{"tipo": "prov", "id", "descricao", "categoria_id", "categoria", "provisionado": float, "valor_do_mes": bool, "gasto": float, "disponivel": float, "estouro": float, "fechado": bool, "valor": float}`
  - `provisionado`: valor de `provisao_meses` do mês, se houver (vence a vigência); senão `valor_centavos`.
  - `gasto`: soma das compras do mês com esse `provisao_id`. `disponivel = max(provisionado - gasto, 0)`, `estouro = max(gasto - provisionado, 0)`, `fechado = mes < hoje`.
  - `valor = 0` se fechado; senão `disponivel`.
- Produces: avulsos ganham as chaves `"provisao_id": int | None` e `"provisao": str | None` (descrição da provisão, por `LEFT JOIN`). Compras ligadas continuam em `avulsos_do_mes`.
- Produces: `visao_mes(con, mes, hoje=None)` (`hoje` padrão: mês de hoje) passa a ter `"provisoes": [...]` e `totais["provisoes"]`. `despesas` soma as quatro listas. Em `por_categoria`, as compras ficam na categoria delas e o `valor` de cada provisão na categoria da provisão. `a_pagar` passa a somar também o `valor` das provisões.
- Produces: `projecao()` chama `visao_mes(con, m, hoje=inicio)`. `d["base"]["provisoes"]` = lista de 12 totais, somada em `despesas` tanto na série ajustada quanto na `sem_ajustes`.

- [ ] **Step 1: Escrever os testes que falham** em `tests/test_provisoes.py`. Importar `BancoTemporario`, `chamar` e `contagem` com `from tests.test_projecoes import ...` (em `ImportError`, `from test_projecoes import ...`). Helpers: `provisao(con, valor, inicio="2026-01", fim=None, categoria_id=1) -> id` e `compra(con, mes, valor, provisao_id=None, pago=0) -> id`, inserindo direto no banco. Usar `HOJE = "2026-11"`. Testes:
  - `test_mes_futuro_sem_compras_conta_o_provisionado`: provisão 600, `visao_mes(con, "2026-12", hoje=HOJE)` → `totais["provisoes"] == 600.0`, `totais["despesas"] == 600.0`, item com `gasto == 0.0`, `disponivel == 600.0`, `fechado is False`.
  - `test_mes_atual_mostra_o_disponivel`: compra 100 ligada em `HOJE` → `totais["avulsos"] == 100.0`, `avulsos[0]["provisao"] == "Saídas"` (o helper cria a provisão com esse nome), `totais["provisoes"] == 500.0`, `disponivel == 500.0`, `despesas == 600.0`.
  - `test_mes_atual_estourado_conta_o_gasto`: compras 400 + 300 → `avulsos == 700.0`, `valor == 0.0`, `disponivel == 0.0`, `estouro == 100.0`, `despesas == 700.0`.
  - `test_mes_terminado_conta_so_o_gasto`: compra 400 em `"2026-10"` → `fechado is True`, `valor == 0.0`, `disponivel == 200.0` (informativo), `despesas == 400.0`.
  - `test_mes_terminado_sem_compras_conta_zero`: provisão vigente em `"2026-10"` sem compras → `despesas == 0.0`.
  - `test_valor_do_mes_vence_o_padrao`: `provisao_meses` (`"2026-12"`, 100000) → `provisionado == 1000.0`, `valor_do_mes is True`; `"2027-01"` continua 600.
  - `test_valor_do_mes_zero_e_compra_fora_da_vigencia_contam_o_gasto`: (a) valor do mês 0 e compra 80 → `despesas == 80.0`, `totais["provisoes"] == 0.0`; (b) provisão com `fim="2026-11"` e compra 50 ligada em `"2026-12"` → `provisoes == []` e `despesas == 50.0`.
  - `test_provisao_fora_da_vigencia_nao_aparece`: `inicio="2027-01"` → `visao_mes(..., "2026-12")["provisoes"] == []`.
  - `test_por_categoria_e_a_pagar`: provisão categoria 6 de 600, compra 150 categoria 2 não paga, em `HOJE` → `por_categoria` tem a categoria 2 com 150.0 e a 6 com 450.0; `a_pagar == 600.0`. Com a compra paga → `a_pagar == 450.0`.
  - `test_resumo_ano_usa_a_regra`: `resumo_ano(con, 2026)` no mês 12 tem `despesas == 600.0`. (O resumo usa o `hoje` padrão; criar a provisão com `inicio="2099-01"` e um valor do mês em `"2099-12"`, e conferir `resumo_ano(con, 2099)`, para não depender da data.)
  - `test_projecao_inclui_provisoes`: provisão 600, compra 150 ligada em `INICIO` → `app.projecao(con, INICIO)["base"]["provisoes"][0] == 450.0`, `base["provisoes"][1] == 600.0`, `base["avulsos"][0] == 150.0`, `cenarios[0]["despesas"][0] == 600.0`, `cenarios[0]["sem_ajustes"]["despesas"][0] == 600.0`.
  - `test_migracao_de_banco_antigo`: criar à mão um `teste.db` com o `lancamentos` antigo (sem `provisao_id`), as `categorias` e uma compra; chamar `app.iniciar_banco()` duas vezes → a coluna existe, a compra continua lá com `provisao_id` NULL e `visao_mes` dela soma em avulsos.

- [ ] **Step 2: Rodar e ver falhar**

Run: `python3 -m unittest tests.test_provisoes -v`
Expected: FAIL (tabela `provisoes` e chave `provisoes` inexistentes).

- [ ] **Step 3: Esquema e migração.** Tabelas no `SCHEMA`, com o comentário "Provisões: valor reservado por mês para despesas variáveis; compras com provisao_id consomem a reserva." Depois, a coluna em `iniciar_banco()`.

- [ ] **Step 4: Implementar `provisoes_do_mes` e ajustar `avulsos_do_mes`/`visao_mes`/`projecao`** conforme Interfaces. Ordem das listas no retorno de `visao_mes`: `avulsos`, `provisoes`, `recorrencias`, `parcelas`.

- [ ] **Step 5: Rodar** `python3 -m unittest tests.test_provisoes tests.test_projecoes -v`. Expected: tudo PASS, inclusive os testes antigos de projeção.

- [ ] **Step 6: Commit**

```bash
git add app.py tests/test_provisoes.py
git commit -m "Provisões: tabelas, migração e cálculo no mês, resumo e projeção"
```

---

### Task 2: API de provisões e compras ligadas

**Files:**
- Modify: `app.py` (novas funções em `# ---- cadastros`, `salvar_lancamento()` linha 532, `listar_categorias()`/`apagar_categoria()` linhas 556–588, `ROTAS`)
- Test: `tests/test_provisoes.py` (classe `TestProvisoesApi(BancoTemporario)`)

**Interfaces:**
- Consumes: tabelas e `provisoes_do_mes` da Task 1.
- Produces:
  - `listar_provisoes(con) -> list[dict]`: `{"id", "descricao", "categoria_id", "categoria", "valor", "inicio", "fim", "ativa"}`, mesma ordenação e regra de `ativa` de `listar_recorrencias`.
  - `salvar_provisao(con, d, pid=None) -> int`, corpo `{"descricao", "valor", "categoria_id", "inicio", "fim"|null}`: valor ≥ 0 e ≤ `MAX_AJUSTE_CENTAVOS`, `fim ≥ inicio`, categoria via `exigir_categoria`; PUT de id inexistente → `ErroEntrada("Provisão não encontrada")`.
  - `salvar_valor_mes_provisao(con, pid, d) -> None`, corpo `{"mes", "valor"}`: `valor` `None` ou `""` apaga o valor do mês; senão faz upsert (≥ 0, mesmas validações). Provisão inexistente → 400.
  - `apagar_provisao(con, pid, _d) -> None`: `UPDATE lancamentos SET provisao_id = NULL WHERE provisao_id = ?`, apaga `provisao_meses` e a provisão.
  - `salvar_lancamento` aceita `provisao_id`: `None`/ausente → NULL; senão precisa ser `int` (não `bool`) de uma provisão existente, ou `ErroEntrada("Provisão não encontrada")`. O PUT grava o campo também, então editar e escolher "nenhuma" desliga a compra.
  - Rotas: `GET /api/provisoes`, `POST /api/provisoes`, `PUT /api/provisoes/(\d+)`, `DELETE /api/provisoes/(\d+)`, `PUT /api/provisoes/(\d+)/meses`.
  - `listar_categorias` conta `provisoes` em `usos`; `apagar_categoria` com `mover_para` também move `provisoes`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `test_crud_provisao`: POST → 200 com id; GET lista com `valor == 600.0`; PUT muda o valor; DELETE some da lista.
  - `test_provisao_invalida_400_sem_gravar` (cada caso 400 e `contagem("provisoes") == 0`): `valor` `"-1"`, `"inf"`, `"abc"`; `fim` antes de `inicio`; `inicio` `"2026-13"`; `categoria_id` 999; `descricao` vazia.
  - `test_valor_do_mes_grava_troca_e_apaga`: PUT `.../meses` `{"mes": "2026-12", "valor": "1000"}` → `GET /api/mes/2026-12` mostra `provisionado == 1000.0`; de novo com `"800"` → 800.0; com `""` → volta ao padrão. `valor` `"-5"` → 400; provisão 999 → 400.
  - `test_lancamento_com_provisao`: provisão 600 e POST `/api/lancamentos` de 150 com `provisao_id`, num mês futuro → `GET /api/mes/<mes>` traz a compra em `avulsos` com `provisao_id` e `provisao`, `provisoes[0]["disponivel"] == 450.0`, `despesas == 600.0`. PUT da mesma compra com `provisao_id: None` → `disponivel == 600.0`, `despesas == 750.0`.
  - `test_lancamento_com_provisao_invalida_400`: `provisao_id` 999, `"1"`, `True` → 400 e `contagem("lancamentos") == 0`.
  - `test_apagar_provisao_mantem_as_compras`: provisão com compra de 150 em mês futuro e um valor do mês → DELETE → a compra continua em `avulsos` com `provisao_id` None, `totais["despesas"] == 150.0`, `contagem("provisao_meses") == 0`.
  - `test_categoria_usada_por_provisao`: categoria nova usada só por uma provisão → `usos == 1`; DELETE sem `mover_para` → 400; com `mover_para=1` → 200 e a provisão passa para a categoria 1.

- [ ] **Step 2: Rodar e ver falhar**

Run: `python3 -m unittest tests.test_provisoes.TestProvisoesApi -v`
Expected: FAIL (rotas inexistentes).

- [ ] **Step 3: Implementar** as funções e as rotas, no formato das rotas de recorrências.

- [ ] **Step 4: Rodar** `python3 -m unittest tests.test_provisoes tests.test_projecoes -v`. Expected: tudo PASS.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_provisoes.py
git commit -m "Provisões: API de cadastro, valor do mês e compras ligadas"
```

---

### Task 3: Telas (Recorrências, compra, Mês e Projeções)

**Files:**
- Modify: `static/app.js` (`modalAvulso` linha 138, `telaMes` linha 259, nova `telaProvisoes` depois de `telaParcelamentos`, `telaProjecoes` linhas 765 e 819, `render()` linha 1009), `static/index.html` (aba nova), `static/style.css`

**Interfaces:**
- Consumes: rotas da Task 2 e payload da Task 1 (`v.provisoes`, `v.totais.provisoes`, `d.base.provisoes`, `provisao_id` nos avulsos).
- Produces: `async telaProvisoes()`; `async carregarProvisoes() -> list` (GET `/api/provisoes`); `provisaoDaCategoria(provisoes, categoriaId, mes) -> provisao | null` (primeira por descrição com essa categoria e vigente no mês); `modalProvisao(p, mesContexto = MES_ATUAL)`; `modalProvisaoMes({ prov, mes })`.

- [ ] **Step 1: Aba própria "Provisões".**
  - Em `static/index.html`, link `<a href="#provisoes" data-aba="provisoes">Provisões</a>` entre Parcelamentos e Entradas. Em `render()`, a entrada `provisoes: telaProvisoes`.
  - `async telaProvisoes()` segue o layout de `telaRecorrencias`:
    - cabeçalho com o título "Provisões", a tag "valor reservado por mês para gastos variáveis", "mostrar encerradas" (usa `estado.mostrarEncerradas`) e o botão "+ Nova provisão";
    - card com a soma "Ativas: R$ X/mês";
    - tabela com descrição, categoria, vigência, valor/mês e **"Disponível em {mês atual}"**, lido de `GET /api/mes/{MES_ATUAL}` → `provisoes` pelo `id`, com "—" quando ela não está no mês. O disponível fica em cor de alerta quando há `estouro`, e aí mostra "estourou R$ X";
    - as mesmas pills "futura"/"encerrada" da aba Recorrências.
  - Clicar na linha abre `modalProvisao`. O modal tem os campos descrição, valor mensal, categoria, primeiro mês e último mês (opcional), e a dica "Ao lançar uma compra, escolha esta provisão em 'Descontar da provisão'. Para mudar o valor de um mês só, abra a provisão na aba Mês." Ao apagar, confirma com "Apagar a provisão "{descricao}"? As compras lançadas nela continuam, como compras avulsas comuns."

- [ ] **Step 2: Compra avulsa.** `modalAvulso` passa a ser `async` e carrega as provisões antes de abrir. Novo campo **"Descontar da provisão"** (`select name="provisao_id"`): "Nenhuma" e as provisões vigentes no mês de "Conta no mês de", mais a provisão já ligada à compra, se estiver fora da vigência. Na compra nova, trocar a categoria ou o mês preenche o campo com `provisaoDaCategoria`, a não ser que o usuário já tenha mexido nele. Ao salvar, envia `provisao_id: Number(d.provisao_id) || null`. **Linha de adição rápida:** envia `provisao_id` de `provisaoDaCategoria(provisoes, cat, mes)`. O aviso vira "Compra adicionada · descontada de {descricao}" quando ligada.

- [ ] **Step 3: Aba Mês.** Card "Provisões" entre "Compras avulsas" e "Recorrências", só quando `v.provisoes.length > 0`, com a soma `t.provisoes` (título da soma: "disponível") no cabeçalho. Para cada provisão, uma linha `tr[data-prov-id]` com o rótulo **"Provisionado – {descricao}"**, uma barra (reaproveitar `.trilho`, largura `gasto/provisionado` limitada a 100% e cor de alerta quando há `estouro`), um texto e o valor `R(i.valor)` (o disponível):
  - mês aberto: "disponível R$ {disponivel} de R$ {provisionado} · gasto R$ {gasto}", ou "estourou R$ {estouro}";
  - mês fechado: "gastou R$ {gasto} de R$ {provisionado} · a sobra voltou ao saldo" (sem a parte da sobra quando ela é 0);
  - `valor_do_mes` mostra a pill "valor deste mês".

  No card de Compras avulsas, a compra com `provisao` ganha uma pill com o nome da provisão ao lado da descrição. Clicar na linha da provisão abre `modalProvisaoMes`, com:
  - o título "{descricao} em {nomeMes}";
  - a lista das compras dela no mês (filtrar `v.avulsos` por `provisao_id`);
  - o campo "Provisionado neste mês", já preenchido, com a dica "Só muda este mês. O valor padrão é R$ {padrão}.";
  - Salvar fazendo `PUT .../meses`;
  - o botão "Voltar ao valor padrão" (quando `valor_do_mes`), que manda `valor: null`;
  - o link "Editar a provisão", que abre `modalProvisao`.

- [ ] **Step 4: Projeções.** `linha("prov", "Provisões")` logo após a linha de avulsos e `cel("prov", i, valorOuTraco(d.base.provisoes[i]))` em `pintar()`.

- [ ] **Step 5: Verificar manualmente** com banco temporário (`CF_DADOS=$(mktemp -d) python3 app.py --porta 8765 --sem-navegador`). Passos: criar a provisão "Saídas" (Lazer, 600); lançar "Jantar" de 150 em Lazer pelo modal (o campo vem com Saídas) e pela linha rápida; conferir no Mês "Provisionado – Saídas" com R$ 450,00 e o Jantar em avulsos com a pill "Saídas"; estourar com mais 500; no mês seguinte, pôr 1.000 só nele e voltar ao padrão; apagar a provisão e ver as compras perderem a pill; conferir a linha em Projeções. Fazer tudo nos dois temas e com viewport de 375 px. Expected: KPIs de despesas e saldo batem com a regra em cada passo.

- [ ] **Step 6: Commit**

```bash
git add static/app.js static/index.html static/style.css
git commit -m "Provisões: aba própria, compra descontando da provisão e card no Mês"
```

---

### Task 4: Teste de ponta a ponta e README

**Files:**
- Modify: `tests/e2e_projecoes.js` (fase nova `"provisoes"`, também rodada pela `"completa"`; atualizar a ordem esperada de linhas para `entradas,rec,parc,avulsos,prov,previstas,cenario,saldo,acumulado,comp`), `README.md`

**Interfaces:**
- Consumes: telas da Task 3 e as funções auxiliares do arquivo (`clicar`, `preencher`, `esperar`, `check`, `txt`, `api`).

- [ ] **Step 1: Escrever a fase `provisoes`:**
  - Em `#provisoes`, criar pela tela (botão "+ Nova provisão") a provisão "Saídas" de 600 na categoria 6 (Lazer), vigente desde o mês atual. Ela aparece na tabela com "Disponível" R$ 600,00.
  - Em `#mes`, abrir "+ Compra", preencher "Jantar", 150, categoria Lazer: o `select[name=provisao_id]` passa a mostrar Saídas. Salvar.
  - O card de Provisões mostra "Provisionado – Saídas" com R$ 450,00, o card de avulsos tem "Jantar" com a pill "Saídas", e o KPI de despesas mostra 600 mais as demais despesas do mês. Conferir com `GET /api/mes/<mes>`.
  - No mês seguinte, clicar na linha da provisão, pôr 1000 e salvar: a linha mostra R$ 1.000,00 e a pill "valor deste mês".
  - Em `#projecoes`, `tr[data-linha="prov"]` mostra 450 no 1º mês e 1.000 no 2º.
  - De volta em `#provisoes`, a coluna "Disponível" mostra R$ 450,00.
  - Nenhum erro de console.

- [ ] **Step 2: Rodar** `python3 -m unittest discover -s tests -v`. Expected: tudo PASS (o e2e é pulado sem node ou google-chrome; avisar se foi pulado).

- [ ] **Step 3: README:** um parágrafo curto sobre provisões: onde cadastrar, "Descontar da provisão" na compra, a regra do mês terminado contra o aberto, e o valor de um mês específico.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e_projecoes.js README.md
git commit -m "Provisões: teste e2e e README"
```
