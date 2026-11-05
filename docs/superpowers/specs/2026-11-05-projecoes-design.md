# Aba Projeções — design

## Por quê

Roberto usa o Controle Financeiro para acompanhar o mês a mês. A decisão que ele ainda toma "no olho" é: **esta compra cabe no orçamento?** Hoje ele compara cenários de parcelamento (à vista, 6x, 12x...) olhando o valor da conta, o impacto no mês da compra e nos meses seguintes, e quanto da renda fica comprometido. A aba Projeções faz essa comparação dentro do sistema, sem planilha paralela.

Ele também precisa projetar contas que sabe que virão mas ainda não existem no sistema (exemplo dado: o curso de inglês do filho, a partir de fevereiro), e quer enxergar quanto ficaria **no vermelho, em reais**, se o saldo ficar negativo.

## Objetivos

- Mostrar, mês a mês, para os próximos 12 meses a partir do mês atual: entradas previstas, despesas já cadastradas, contas previstas e contas do cenário escolhido.
- Permitir criar vários cenários (rascunhos) e comparar o resultado de todos.
- Mostrar o resultado de cada mês em **saldo (R$)** e **comprometimento (%)**: despesas ÷ entradas.
- Um gráfico de linhas com todos os cenários sobrepostos, para ver a evolução do comprometimento e onde passa para o vermelho.
- Nada do que se digita na aba Projeções altera os lançamentos reais (Mês, Recorrências, Parcelamentos, Entradas).

## Não objetivos / anti-objetivos

- Não prever gastos variáveis automaticamente (mercado etc.), nem integrar com banco.
- Não é um orçamento: não há metas por categoria.
- Anti-objetivo: um cenário nunca pode sujar os números reais. Se ele aparecer somado em Mês, Resumo ou em qualquer total real, a feature falhou, mesmo que a tela de Projeções esteja certa.
- "Transformar o cenário em parcelamento real com um clique" ficou **fora desta versão** (ideia de Roberto, baixa prioridade).

## O que o usuário vê

Nova aba **Projeções** na barra de abas, ao lado de Entradas e Resumo, seguindo o estilo visual atual do sistema (cartões, tabelas, tema claro/escuro).

**1. Abas de cenário** no topo da tela. A primeira, **"Sem a compra"**, é a base: não tem contas de cenário, não pode ser apagada nem renomeada. As demais são criadas por Roberto ("Notebook 6x", "Notebook 12x"...), com botão "+ novo cenário" e opção de renomear, duplicar e apagar. Duplicar existe porque o uso típico é o mesmo cenário com 6x e depois com 12x.

**2. Tabela do cenário selecionado.** Colunas: 12 meses a partir do mês atual. Linhas, nesta ordem:

| Linha | De onde vem | Editável aqui |
|---|---|---|
| Entradas previstas | digitadas na aba Projeções, por mês | sim, células editáveis como na aba Entradas |
| Recorrências | as já cadastradas (reaproveita o cálculo do sistema) | não |
| Parcelas em andamento | os parcelamentos já cadastrados | não |
| Lançamentos avulsos | compras avulsas já lançadas nesses meses | não |
| Contas previstas | contas que Roberto sabe que virão (valem para **todos** os cenários) | sim |
| Do cenário | contas hipotéticas do cenário selecionado | sim |
| **Saldo do mês** | entradas − todas as despesas | não |
| **Acumulado** | soma dos saldos do mês desde o primeiro mês da projeção (começa em zero, sem saldo inicial) | não |
| **Comprometimento** | despesas ÷ entradas | não |

O **saldo do mês vale só para aquele mês** (decisão de Roberto); o vermelho de um mês não herda o de meses anteriores. A linha **Acumulado** existe só para mostrar o tamanho total do rombo no cenário quando o vermelho se repete; **o gráfico sempre mostra mês a mês, nunca o acumulado**, e o "pior mês" também é por mês. Saldo negativo (e acumulado negativo) aparece em vermelho, com o valor em reais ("−R$ 300"). Se a entrada de um mês for zero ou vazia, o comprometimento mostra "–" em vez de dividir por zero (e o saldo, em reais, continua aparecendo). Um destaque acima da tabela diz o **pior mês** do cenário e o saldo dele.

**3. Entradas previstas.** Para cada mês futuro, Roberto digita o total previsto de entradas (um valor por mês, não por fonte; ver "Escolhas minhas"). Digitar aceita a mesma sintaxe da aba Entradas (`4636,35 + 1936,59`). Valor vazio significa "sem entrada prevista" (zero). As entradas previstas valem para **todos** os cenários.

**4. Contas previstas** (valem para todos os cenários) e **contas do cenário** (só para o cenário em que foram criadas) usam o mesmo formulário:

- Descrição
- Valor total
- Número de parcelas (1 = à vista)
- Mês da primeira parcela

A parcela é o valor total dividido pelo número de parcelas, arredondado a centavos, repetida uma vez por mês a partir do mês informado. Um cenário pode ter **várias contas** (decisão de Roberto): o motivo é ver o impacto de uma compra combinado com os outros planos do mesmo cenário (ex.: "Notebook 6x" + "Viagem em julho 3x"). Por isso o formulário permite **inserir várias contas de uma vez**: uma lista de linhas (descrição, valor total, parcelas, mês da primeira parcela), com botão para acrescentar mais uma linha, e um único "Salvar" que grava todas. Não há campo de juros: para representar juros, Roberto digita o total que pagaria (o 12x pode ter total maior que o 6x).

**5. Gráfico.** Abaixo da tabela, largura total. Linhas sobrepostas, uma por cenário (incluindo "Sem a compra"), eixo X nos 12 meses. Um botão alterna o eixo Y entre **comprometimento (%)** e **saldo (R$)**. Uma linha de referência marca 100% (ou R$ 0), onde começa o vermelho. O cenário selecionado fica visualmente destacado. Deve funcionar nos temas claro e escuro, ter legenda e tooltip com o valor do mês, e caber em tela de celular (o sistema é usado como PWA).

## Restrições

- Segue a arquitetura atual: Python com biblioteca padrão e SQLite (`app.py`), front-end estático em JavaScript puro (`static/app.js`, `index.html`, `style.css`). Sem frameworks nem dependências novas. O gráfico é SVG feito à mão, como o gráfico da aba Resumo.
- Dados novos vão em tabelas novas no mesmo `dados.db`, criadas pela rotina existente de criação do banco, sem apagar nem alterar dados atuais (o banco de produção já existe e não pode ser tocado).
- Valores em centavos inteiros no banco, como o resto do sistema.
- Usa os mesmos mecanismos de login, validação (`ErroEntrada`) e rotas que o resto da API.
- Como já foi pedido no projeto, mudanças em campo editável não podem refazer a tela inteira ao salvar (isso derrubava o foco da célula clicada; ver commit 761bf1b). Teclas normais (setas, digitação) devem funcionar nos campos.

## Escolhas minhas (Roberto ainda pode mudar)

- "Inserir várias contas de uma vez" é a minha leitura da frase de Roberto: um formulário com várias linhas e um único Salvar. Ele pode ter querido dizer só que o cenário aceita várias contas, adicionadas uma a uma; nesse caso a lista de linhas é um extra inofensivo.
- Horizonte fixo de 12 meses a partir do mês atual. Roberto não pediu navegação por ano.
- Entradas previstas como **um total por mês**, não por fonte de renda. Motivo: é uma projeção e ele quer digitar rápido.
- Contas previstas e contas de cenário **não têm categoria**; entram só nos totais da projeção.
- Todos os cenários e contas previstas são compartilhados entre os usuários do sistema, como o resto dos dados.
- Meses em que Roberto não digitou entrada prevista usam como valor inicial o total real da aba Entradas daquele mês (se houver); a célula mostra de qual origem veio (digitada ou da aba Entradas). Digitar um valor na Projeções sobrepõe o real só dentro da projeção e nunca altera a aba Entradas. Sem nenhum dos dois, o valor é zero.
- A linha Acumulado aparece sempre, em todos os cenários, e não só quando há meses seguidos no vermelho (Roberto disse "se por acaso se repetir"; mostrar sempre é mais simples e não atrapalha).
- A marcação de "pago" é ignorada na projeção: todas as despesas do mês contam.
- "Sem a compra" é um cenário fixo, sem contas de cenário (não é uma linha do banco).
- "Comprometimento" = despesas totais do mês ÷ entradas previstas do mês. As despesas já cadastradas (recorrências, parcelas, avulsos) vêm dos mesmos cálculos que o sistema usa na aba Mês, para os números coincidirem.

## O que fica para quem construir

- Nomes de tabelas, rotas e funções, seguindo o padrão do código.
- Layout fino, cores das linhas do gráfico (devem ser distinguíveis e acessíveis nos dois temas), textos da interface (em português do Brasil).
- Como os cenários são carregados: um endpoint que devolve a projeção calculada para todos os cenários de uma vez é suficiente, desde que o gráfico e a tabela usem os mesmos números.
- Testes para o cálculo (parcelas, arredondamento, divisão por zero, mês de início no meio do horizonte, parcelas que terminam dentro do horizonte).
