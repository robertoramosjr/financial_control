# Controle Financeiro

Controle de despesas da casa: compras avulsas, recorrências (assinaturas/contas mensais),
parcelamentos, entradas, projeções por cenário e resumo anual. Python puro (sem dependências) + SQLite.

Na aba Projeções, clicar no nome de um mês abre as despesas dele (recorrências e parcelas) e permite
cortar, reduzir ou pausar uma delas só na projeção (nada real muda), para todos os cenários ou só um.
O gráfico pode mostrar cada cenário também sem os ajustes.

Na aba Provisões você reserva um valor por mês para gastos variáveis (ex.: Saídas, R$ 600). Ao lançar uma
compra, escolha a provisão em "Descontar da provisão" (vem preenchido pela categoria): a compra conta como gasto
e a linha "Provisionado – Saídas" do mês mostra só o que ainda está disponível. Em mês que já terminou conta só
o que foi gasto (a sobra volta ao saldo); se estourar, conta o gasto. Para mudar o valor de um mês só, clique na
provisão na aba Mês daquele mês.

## No computador

    python3 app.py

Abre em http://localhost:8765. Sem usuário cadastrado, não pede login.
Para importar a planilha antiga: `pip install openpyxl && python3 importar_planilha.py "Controle Financeiro.xlsx"`.

## Na internet (PythonAnywhere)

Os dados (`dados.db`) **não** ficam no repositório: moram em `~/dados/` no servidor,
com backup automático a cada 6 horas em `~/dados/backups/`.

Instalação (uma vez):
1. Console Bash: `git clone https://<TOKEN>@github.com/robertoramosjr/financial_control.git`
   (token de acesso do GitHub, só leitura deste repositório) e `mkdir ~/dados`.
2. Aba Files: enviar `dados.db` para `~/dados/`.
3. Aba Web: *Add a new web app* -> *Manual configuration* -> Python mais novo disponível.
   No arquivo WSGI, colar o conteúdo de `deploy/pythonanywhere_wsgi.py` (trocando SEU_USUARIO).
   Em *Security*, ligar **Force HTTPS**. Clicar em **Reload**.
4. Console Bash: `CF_DADOS=~/dados python3 ~/financial_control/app.py --usuario SEU_NOME`
   (repita para cada pessoa; o mesmo comando troca a senha).

Atualizar depois de mudanças no código:

    cd ~/financial_control && git pull

e clicar em **Reload** na aba Web. Os dados não são tocados.

## Alternativa: VM própria (Google Cloud, Oracle...)

`sudo bash deploy/instalar.sh` numa VM Debian 12 instala o serviço com HTTPS via Caddy.
