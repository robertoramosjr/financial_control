# Projeções: ajustar despesas fixas — design

## Por quê

A aba Projeções já responde "esta compra cabe no orçamento?". Falta a outra metade da pergunta: **"e se eu cortar alguma coisa para o plano caber?"** Roberto quer "brincar com o orçamento": e se eu cancelar esta assinatura, reduzir o combustível (conta fixa em que dá para cortar), pausar algo por alguns meses. Quer ver o efeito no saldo e no comprometimento dos meses, sem mexer nos lançamentos reais.

## Objetivos

- Para um mês da projeção, ver a lista das despesas previstas nele (recorrências e parcelas em andamento) com o valor de cada uma.
- Alterar o valor de uma despesa **só dentro da projeção**, com um destes alcances:
  1. só aquele mês;
  2. daquele mês em diante, sem fim;
  3. daquele mês até um mês final escolhido; depois o valor volta ao normal (é assim que se faz uma **pausa**).
- Valor 0 significa cancelar a despesa. Também é possível reduzir (ex.: combustível de 900 para 700) ou aumentar.
- Cada ajuste vale para **todos os cenários** ou **só para o cenário selecionado**, à escolha de Roberto na hora de criar. Assim ele faz um corte geral (cancelar uma assinatura vale em qualquer plano) e ainda consegue editar um cenário em separado.
- Tabela, saldo, comprometimento, "pior mês" e gráfico passam a refletir os ajustes, nos mesmos números.
- O gráfico permite ver **cada cenário com e sem ajustes**, para enxergar quanto os cortes melhoram o plano.
- Ver de relance o que foi alterado e poder desfazer.

## Não objetivos / anti-objetivos

- Lançamentos avulsos **não** são ajustáveis (decisão de Roberto: não faz sentido).
- Não cria, apaga nem edita recorrências ou parcelamentos reais. Não vira cancelamento real com um clique.
- Anti-objetivo: um ajuste nunca pode aparecer nos totais reais (aba Mês, Resumo, qualquer total fora de Projeções), nem alterar `recorrencias`, `parcelamentos` ou `pagamentos`. Se aparecer, a feature falhou, mesmo que a tela de Projeções esteja certa.

## O que o usuário vê

**Painel "Despesas de [mês]".** Na tabela do cenário selecionado, clicar no cabeçalho de um mês (escolha de Roberto: "jeito A", entre dois mockups) abre, abaixo da tabela, o painel com as despesas previstas naquele mês: recorrências e parcelas em andamento, cada uma com descrição, valor (já com o ajuste, se houver) e botão **editar**. Parcelas mostram "parcela k/n". O mês aberto fica destacado na tabela. Avulsos não aparecem na lista (são só contados nos totais, como hoje).

**Janela de edição.** Abre ao clicar em editar e mostra "Descrição, mês (valor de hoje: R$ X)":

- **Novo valor**, aceitando a mesma sintaxe de valores do resto do sistema; `0` cancela.
- **Vale para**, com três opções: só este mês; deste mês em diante; deste mês até [mês final] (campo de mês, obrigatório nessa opção, não anterior ao mês de início).
- **Aplicar em**, com duas opções: **todos os cenários** ou **só em [nome do cenário selecionado]**.
- Botão **Aplicar na projeção** e aviso de que nada real é alterado.

**Despesa ajustada.** No painel aparece o valor ajustado com o valor original ao lado ("R$ 0, era 30"), em destaque visual; cancelada aparece riscada com "cancelado na projeção". Um botão **desfazer** remove o ajuste daquele mês (ver "O que fica para quem construir" sobre ajustes que cobrem vários meses).

**Efeito na tabela.** As linhas Recorrências e Parcelas em andamento passam a somar os valores ajustados (os gerais e os do cenário selecionado). Saldo, Acumulado, Comprometimento e pior mês recalculam. Os meses com algum ajuste ganham uma marca discreta no cabeçalho. No painel, cada ajuste indica se é **geral** ou **só deste cenário**.

**Gráfico.** Continua com uma linha por cenário, agora já com os ajustes. Um controle **"Mostrar sem ajustes"** desenha, para cada cenário, também a versão sem nenhum ajuste, tracejada e na mesma cor da linha ajustada, com legenda e tooltip que distinguem "com ajustes" e "sem ajustes". O botão existente de eixo (comprometimento % / saldo R$) continua valendo para ambas.

## Restrições

- Mesma arquitetura: Python com biblioteca padrão e SQLite (`app.py`), front-end em JavaScript puro, sem dependências novas. Dados novos em tabela nova no `dados.db`, criada pela rotina existente de criação do banco, sem tocar nos dados atuais (o banco de produção existe).
- Valores em centavos inteiros no banco.
- Mesmos login, validação (`ErroEntrada`) e rotas da API do resto da aba.
- Salvar um ajuste não pode refazer a tela inteira nem derrubar o foco de campos (mesma regra do restante de Projeções).
- O cálculo parte das mesmas funções que a aba Mês usa para recorrências e parcelas, para os números sem ajuste continuarem coincidindo.

## Escolhas minhas (Roberto ainda pode mudar)

- Ajuste **geral** vale para todos os cenários, inclusive "Sem a compra". Ajuste **de cenário** vale só para aquele cenário. Se os dois existem para a mesma despesa e mês, **vale o do cenário** (o mais específico); entre dois do mesmo tipo, vale o mais recente.
- **"Sem a compra" só aceita ajustes gerais**, porque não é um cenário guardado no banco. Quando está selecionado, a opção "só neste cenário" não aparece. A versão "sem ajustes" dele no gráfico é a base real.
- Duplicar um cenário copia também os ajustes de cenário dele (os gerais continuam sendo compartilhados, não são copiados).
- O comparativo "sem ajustes" do gráfico é um **controle ligado/desligado**, desligado por padrão, para o gráfico não nascer com o dobro de linhas. Esse padrão é uma escolha minha.
- Ajustes **não têm categoria nem aparecem como linha própria** na tabela: entram dentro de Recorrências e Parcelas. O efeito aparece pelo painel e pela marca no cabeçalho do mês.
- Ajustar uma parcela só tem efeito nos meses em que ela existe. Ajuste em mês fora da vida da despesa é ignorado.
- A marcação de "pago" continua ignorada na projeção, como já é.
- Apagar um cenário apaga seus ajustes de cenário (os gerais permanecem). Se a recorrência ou o parcelamento real for apagado, seus ajustes somem junto ou ficam inofensivos (a critério de quem construir, desde que nada quebre).

## O que fica para quem construir

- Nomes de tabela, rotas e funções, seguindo o padrão do código.
- Modelo de dados dos ajustes (a ideia: despesa por tipo e id, cenário ou nulo para "geral", mês inicial, mês final opcional, valor em centavos), e se "desfazer" remove o ajuste inteiro ou só trata o mês clicado. Meu pedido: ao desfazer num mês coberto por um ajuste de vários meses, **perguntar** se desfaz só aquele mês ou o ajuste todo, ou usar a regra mais simples que não surpreenda.
- Layout fino do painel e da janela, textos em português do Brasil, comportamento no celular (o sistema é PWA).
- Testes: mês único, em diante, intervalo/pausa, valor 0, sobreposição (geral contra de cenário), parcela fora da vida, duplicar cenário, gráfico com e sem ajustes, e que os totais reais e as tabelas reais permanecem intactos.
