# Provisões — design

## Por quê

Algumas despesas não têm valor fixo (saídas, mercado, farmácia). Roberto quer **reservar um valor por mês** para cada uma, ver o impacto dessa reserva no saldo dos meses (inclusive nas Projeções) e, quando gastar de fato, **lançar a compra descontando da reserva**, sem contar o mesmo dinheiro duas vezes.

## Objetivos

- Cadastrar uma provisão: descrição, categoria, valor mensal, primeiro mês, último mês opcional (mesma vigência das recorrências).
- Mudar o valor provisionado em meses específicos (ex.: dezembro R$ 1.000 em vez de R$ 600), inclusive 0 para "não provisionar neste mês".
- Ao lançar uma compra avulsa, indicar **"Descontar da provisão"**. O campo vem pré-preenchido com a provisão da categoria escolhida (se houver uma vigente no mês) e pode ser trocado ou deixado em "nenhuma".
- Na aba Mês, cada provisão aparece como a linha **"Provisionado – {descrição}"**, cujo valor é o **disponível** do mês (provisionado menos o gasto). O texto mostra também provisionado, gasto ou quanto estourou.

## Regra do valor que conta no mês

- A compra ligada é um **gasto real**: entra em Compras avulsas, na categoria dela, com uma etiqueta da provisão.
- A linha da provisão soma só o **disponível** = `max(provisionado − gasto, 0)`, e só em mês que não terminou. Exemplo: 600 provisionados e 100 gastos → compras 100 + disponível 500 = 600 no mês.
- Consequências: **mês atual e futuros** contam o maior entre o provisionado e o gasto (nos futuros, sem compras, o provisionado). **Mês que já terminou** (anterior ao mês de hoje) conta só o gasto, e a sobra volta para o saldo.
- Nada conta duas vezes. A sobra não passa para o mês seguinte.

## Onde aparece

- Aba Mês: card "Provisões". Total de despesas, saldo e "por categoria" já incluem a regra: as compras ficam na categoria delas e o disponível na categoria da provisão.
- Resumo anual e Projeções: usam os mesmos totais do mês. Projeções ganha a linha "Provisões".
- Aba própria "Provisões" (entre Parcelamentos e Entradas): a lista com valor/mês e o disponível no mês atual, e o botão "+ Nova provisão".

## Não objetivos

- Sobra acumulando de um mês para o outro.
- Ajustes de provisão só na projeção (os ajustes de Projeções continuam valendo só para recorrências e parcelas). Para testar valores, edite a provisão ou o valor do mês.
- Provisão parcelada ou com "pago".

## Casos de borda decididos

- Compra ligada a uma provisão num mês fora da vigência dela: continua contando como compra. A provisão não aparece nesse mês (a não ser que tenha valor do mês).
- Apagar uma provisão: as compras dela perdem a etiqueta e continuam como avulsas comuns. Os valores por mês dela são apagados.
- "Falta pagar" do mês: compras não pagas + o disponível das provisões.
