# Migração para a Cloudflare: registro de design

Data: 2026-11-11. Plano: `docs/superpowers/plans/2026-11-11-migracao-cloudflare.md`.

## Por quê

O site rodava no PythonAnywhere (plano gratuito), que exige reativar o site de tempos em tempos, e a atualização
a partir do GitHub era manual (`git pull` + Reload). O objetivo é um site sempre no ar, sem custo, que se
atualize sozinho a cada push na branch `main`.

## O que foi decidido

- **Worker em TypeScript + D1** (SQLite da Cloudflare), com `static/` servido pela plataforma
  (*Static Assets*). A Cloudflare não roda o servidor Python nem arquivos SQLite; a alternativa que mantinha o
  Python (Containers) é paga.
- **Mesma API, mesmo frontend.** Caminhos, corpos JSON, códigos HTTP e mensagens de erro iguais aos do `app.py`;
  `static/` não mudou. A paridade é provada por `tests/golden/` (respostas do Python que o Worker reproduz),
  pela comparação das 40 rotas e pelo teste de navegador contra o Worker local.
- **Login sempre obrigatório** (como `CF_PUBLICO=1`), sessões de 90 dias, no máximo 10 falhas por IP e 30 no total
  a cada 15 minutos.
- O `app.py` e seus testes continuam no repositório (referência, uso local e fonte dos `golden`).

## Fatos da plataforma que moldaram o código

- **PBKDF2:** a WebCrypto do Workers limita (em produção) o PBKDF2 a 100.000 iterações (workerd #1346); os hashes
  do Python usam 600.000. Por isso as senhas são recadastradas (`scripts/criar-usuario.mjs`) e `conferirSenha`
  devolve `false`, nunca erro, para hashes com mais de 100.000 iterações. O runtime local dos testes **não**
  aplica esse limite, então nenhum teste local o prova; confirme no primeiro deploy (login com a senha nova).
  **Risco aberto:** 100.000 iterações custam cerca de 10 ms de CPU (medido no Node e no workerd local), que é o
  limite do plano gratuito. Em produção isso pode virar erro 1102 no login, a única rota sem contorno. O README
  manda conferir nos logs logo após o primeiro deploy e nomeia as saídas (Workers Paid ou menos iterações).
- **Login contra rajadas:** a tentativa é reservada numa única instrução SQL antes de conferir a senha
  (`reservarTentativa` em `src/auth.ts`); conferir e gravar em passos separados deixava 60 requisições simultâneas
  passarem pelo limite de 10 por IP (achado da revisão final, com teste em `auth-concorrencia.test.ts`).
- **Backup:** Time Travel do D1 guarda 7 dias no plano gratuito (30 no pago) e não há backup automático em arquivo;
  a rotina de `wrangler d1 export` é manual.
- **D1 gratuito: 50 consultas por requisição** (e 5 milhões de linhas lidas por dia). O Python fazia ~5 consultas
  por mês e o resumo anual ~60. Por isso as regras de `src/mes.ts` são funções puras sobre um retrato dos dados
  carregado de uma vez (`carregarDados`, 8 consultas numa `db.batch`), e a projeção carrega 12 num batch só.
- **Escritas em vários passos** (dividir recorrência, apagar com dependentes, apagar categoria movendo itens) usam
  `db.batch`, que é transacional: um passo que falha desfaz os anteriores (há teste).

## Pequenas diferenças em relação ao Python (todas em entrada malformada)

Onde o Python devolvia erro 500 por uma exceção não tratada, o Worker devolve 400 com mensagem: JSON quebrado,
`dia`/`n_parcelas` que não é inteiro, `mover_para` inexistente ou não numérico ao apagar categoria, item que não é
objeto na lista de contas. O "mês atual" usa o fuso de São Paulo (o servidor do PythonAnywhere usava UTC).

## Como virar a chave (resta fazer, com a conta do usuário)

Os passos de "Publicar (uma vez)" do README. Depois de validar o site novo (Mês, Resumo, Projeções, Provisões e
um lançamento de teste), o usuário desativa o PythonAnywhere. Antes, **baixar o `dados.db` de verdade de
`~/dados/` no PythonAnywhere**: o que está no computador pode ser uma versão antiga.
