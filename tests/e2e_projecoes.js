// Teste de ponta a ponta da aba Projeções (Chrome headless via DevTools). Rodado por tests/test_e2e_projecoes.py.
// Uso: node e2e_projecoes.js <porta-do-app> <dir-perfil-chrome> [tabela|completa]   (env CDP_PORT: porta do DevTools)
const { spawn } = require("child_process");
const PORTA = process.argv[2], PERFIL = process.argv[3], FASE = process.argv[4] || "tabela";
const CDP = process.env.CDP_PORT || "9334";
const BASE = `http://localhost:${PORTA}`;
const J = { "Content-Type": "application/json" };
const api = (m, u, b) => fetch(BASE + u, { method: m, headers: J, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const check = (nome, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${nome}${ok ? "" : "  -> " + extra}`); if (!ok) falhas++; };

(async () => {
  const ch = spawn("google-chrome", ["--headless=new", "--no-sandbox", `--remote-debugging-port=${CDP}`, `--user-data-dir=${PERFIL}`, "about:blank"], { stdio: "ignore" });
  await dorme(2500);
  const tabs = await (await fetch(`http://localhost:${CDP}/json`)).json();
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) pend[m.id](m.result); };
  const send = (method, params = {}) => new Promise((r) => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? "ERRO:" + r.exceptionDetails.text + JSON.stringify(r.exceptionDetails.exception?.description) : r.result?.value; };
  const esperar = async (cond, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(cond)) return true; await dorme(100); } return false; };
  const centro = async (sel) => JSON.parse(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:"center",inline:"center"});const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`));
  const clicar = async (sel) => { const p = await centro(sel); for (const t of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type: t, x: p.x, y: p.y, button: "left", clickCount: 1 }); await dorme(150); };
  const tecla = async (k, code, vk, text) => { await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, text }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }); };
  const enter = () => tecla("Enter", "Enter", 13, "\r");
  const digitar = (t) => send("Input.insertText", { text: t });
  const txt = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()`);
  const preencher = (sel, v) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);

  // dados de base
  const mes = await (async () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
  await api("POST", "/api/fontes", { nome: "Salário" });
  await api("PUT", "/api/entradas", { fonte_id: 1, mes, valor: 9800 });
  await api("POST", "/api/recorrencias", { descricao: "Aluguel", dia: 5, valor: 3000, categoria_id: 1, inicio: "2020-01" });

  await send("Page.enable");
  await send("Page.navigate", { url: BASE + "/#projecoes" });
  await dorme(1500);
  await ev(`window.confirm = () => true`);

  check("aba Projeções existe na barra", await ev(`!!document.querySelector('#abas a[data-aba="projecoes"]')`));
  const tem = await esperar(`!!document.querySelector('tr[data-linha="saldo"]')`);
  check("tabela de projeção renderiza", tem);
  if (!tem) { ch.kill(); process.exit(1); }

  check("12 colunas de mês", (await ev(`document.querySelectorAll('table.proj thead th.num').length`)) === 12);
  const linhas = await ev(`[...document.querySelectorAll('table.proj tr[data-linha]')].map(t=>t.dataset.linha).join(",")`);
  check("ordem das linhas", linhas === "entradas,rec,parc,avulsos,previstas,cenario,saldo,acumulado,comp", linhas);
  check("1º mês é o mês atual", (await txt("table.proj thead th.num")).includes(String(mes.slice(0, 4))));

  // entrada digitada com soma, sem recriar o input
  await ev(`window.__inp = document.querySelector('input[data-pm="1"]')`);
  await clicar('input[data-pm="1"]');
  await digitar("4636,35 + 1936,59");
  await enter();
  await dorme(600);
  check("input não foi recriado ao salvar", await ev(`document.contains(window.__inp)`));
  check("valor somado formatado", (await ev(`document.querySelector('input[data-pm="1"]').value`)) === "6.572,94");
  const srv = await api("GET", "/api/projecao");
  check("servidor gravou 6572.94 (digitada)", srv.entradas[1].valor === 6572.94 && srv.entradas[1].origem === "digitada", JSON.stringify(srv.entradas[1]));
  check("saldo do mês 2 recalculado na tela", (await txt('tr[data-linha="saldo"] td[data-i="1"]')).includes("3.572,94"), await txt('tr[data-linha="saldo"] td[data-i="1"]'));
  check("célula do mês atual marca origem 'real'", (await ev(`document.querySelector('input[data-pm="0"]').dataset.origem`)) === "real");

  // foco: editar A e clicar direto em B; setas funcionam
  await clicar('input[data-pm="2"]'); await digitar("100");
  await clicar('input[data-pm="3"]'); await dorme(500);
  check("clicar em B depois de editar A mantém foco em B", (await ev(`document.activeElement.dataset.pm`)) === "3");
  await digitar("200");
  const a = await ev(`document.activeElement.selectionStart`);
  await tecla("ArrowLeft", "ArrowLeft", 37); await tecla("ArrowLeft", "ArrowLeft", 37);
  check("setas movem o cursor", (await ev(`document.activeElement.selectionStart`)) === a - 2, `antes ${a}`);
  await enter(); await dorme(500);
  check("célula A foi salva", (await ev(`document.querySelector('input[data-pm="2"]').value`)) === "100,00");

  // saldo negativo e comprometimento "–"
  await clicar('input[data-pm="4"]'); await digitar("0"); await enter(); await dorme(500);
  check("saldo negativo em vermelho com valor", await ev(`(()=>{const c=document.querySelector('tr[data-linha="saldo"] td[data-i="4"]');return c.classList.contains("negativo")&&c.textContent.includes("3.000")})()`));
  check("comprometimento '–' com entrada zero", (await txt('tr[data-linha="comp"] td[data-i="4"]')) === "–");
  check("acumulado presente", (await txt('tr[data-linha="acumulado"] td[data-i="4"]')).includes("R$"));
  check("pior mês destacado", (await txt("#pior-mes")).includes("Pior mês"));

  // layout: sem rolagem horizontal da página em 390px, tema escuro
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await dorme(300);
  check("sem rolagem horizontal da página em 390px", (await ev(`document.documentElement.scrollWidth <= 392`)));
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });

  if (FASE === "tabela") { console.log(falhas ? `${falhas} falha(s)` : "tabela: tudo certo"); ch.kill(); process.exit(falhas ? 1 : 0); }

  // cenários e contas
  const abrirModalCom = async (botao) => { await clicar(botao); return esperar(`document.querySelector("#modal").open`); };
  const enviarModal = async () => { await ev(`document.querySelector("#modal-form").requestSubmit()`); await dorme(700); };
  check("'+ cenário' abre modal", await abrirModalCom("#bt-novo-cen"));
  await preencher('#modal-form [name="nome"]', "Notebook 6x"); await enviarModal();
  check("cenário novo fica selecionado", (await txt("#proj-cenarios .ativo")) === "Notebook 6x", await txt("#proj-cenarios"));

  check("'+ conta' abre modal", await abrirModalCom("#bt-conta"));
  await clicar("#bt-mais-linha");
  check("'+ linha' acrescenta linha", (await ev(`document.querySelectorAll("#modal .linha-conta").length`)) === 2);
  const L = (n, c, v) => ev(`document.querySelectorAll("#modal .linha-conta")[${n}].querySelector('[name="${c}"]').value = ${JSON.stringify(v)}`);
  await L(0, "descricao", "Notebook"); await L(0, "valor", "3000"); await L(0, "n_parcelas", "6"); await L(0, "primeira_parcela", mes);
  await L(1, "descricao", "Viagem"); await L(1, "valor", "900,00"); await L(1, "n_parcelas", "3"); await L(1, "primeira_parcela", mes);
  await enviarModal();
  const proj = await api("GET", "/api/projecao");
  check("duas contas gravadas num Salvar", proj.cenarios.at(-1).contas.length === 2);
  check("linha 'Do cenário' soma parcelas (500+300)", (await txt('tr[data-linha="cenario"] td[data-i="0"]')).includes("800"), await txt('tr[data-linha="cenario"] td[data-i="0"]'));

  await clicar('#proj-cenarios button[data-cen=""]');
  await dorme(500);
  check("'Sem a compra': linha do cenário zerada", (await txt('tr[data-linha="cenario"] td[data-i="0"]')).replace(/\D/g, "") === "0" || (await txt('tr[data-linha="cenario"] td[data-i="0"]')) === "–");
  check("'Sem a compra': sem +conta/renomear/apagar", await ev(`!document.querySelector("#bt-conta") && !document.querySelector("#bt-ren-cen") && !document.querySelector("#bt-apg-cen")`));

  check("'+ conta prevista' abre modal", await abrirModalCom("#bt-prevista"));
  await L(0, "descricao", "Inglês"); await L(0, "valor", "650"); await L(0, "n_parcelas", "1"); await L(0, "primeira_parcela", mes);
  await enviarModal();
  check("prevista soma em 'Sem a compra'", (await txt('tr[data-linha="previstas"] td[data-i="0"]')).includes("650"));

  await clicar('#proj-cenarios button:not([data-cen=""])'); await dorme(500);
  check("prevista soma também no cenário", (await txt('tr[data-linha="previstas"] td[data-i="0"]')).includes("650"));
  // gráfico (cenário selecionado: "Notebook 6x"; entradas > 0 só nos meses 0..3)
  const svg = (q) => ev(`document.querySelectorAll(${JSON.stringify("#proj-grafico svg " + q)}).length`);
  check("gráfico: uma linha por cenário", (await svg("path[data-cen]")) === 2);
  check("gráfico: legenda com os nomes", (await ev(`document.querySelector("#proj-grafico .legenda").textContent`)).includes("Sem a compra") && (await ev(`document.querySelector("#proj-grafico .legenda").textContent`)).includes("Notebook 6x"));
  check("gráfico pct: pontos só onde há entrada (4 por cenário)", (await svg('circle[data-cen=""]')) === 4, String(await svg('circle[data-cen=""]')));
  check("gráfico pct: título do ponto em %", (await ev(`document.querySelector('#proj-grafico circle[data-cen=""] title').textContent`)).includes("%"));
  check("gráfico: sem NaN e com linha de referência", (await ev(`!document.querySelector("#proj-grafico svg").innerHTML.includes("NaN")`)) && (await svg("line.ref")) === 1);
  check("gráfico: cenário selecionado destacado", await ev(`(()=>{const a=document.querySelector('#proj-grafico path[data-sel="1"]');const b=document.querySelector('#proj-grafico path[data-sel="0"]');return a&&b&&Number(a.getAttribute("stroke-width"))>Number(b.getAttribute("stroke-width"))})()`));
  await clicar("#bt-modo-graf"); await dorme(200);
  check("gráfico saldo: 12 pontos por cenário, valores em R$", (await svg('circle[data-cen=""]')) === 12 && (await ev(`document.querySelector('#proj-grafico circle[data-cen=""] title').textContent`)).includes("R$"));
  check("gráfico saldo: ainda tem linha de referência (R$ 0)", (await svg("line.ref")) === 1);
  await clicar("#bt-modo-graf"); await dorme(200);
  await ev(`window.__inp = document.querySelector('input[data-pm="5"]')`);
  await clicar('input[data-pm="5"]'); await digitar("5000"); await enter(); await dorme(600);
  check("editar entrada atualiza o gráfico (5 pontos) sem recriar o campo", (await svg('circle[data-cen=""]')) === 5 && (await ev(`document.contains(window.__inp)`)));
  for (let i = 1; i <= 6; i++) await api("POST", "/api/projecao/cenarios", { nome: "Extra " + i });
  await ev(`render()`); await dorme(800);
  check("mais cenários que cores: 8 linhas, repetidas com tracejado", (await svg("path[data-cen]")) === 8 && (await ev(`document.querySelectorAll('#proj-grafico path[stroke-dasharray]').length`)) >= 1);
  for (const c of (await api("GET", "/api/projecao")).cenarios.filter((c) => c.nome.startsWith("Extra"))) await api("DELETE", "/api/projecao/cenarios/" + c.id);
  await ev(`render()`); await dorme(600);
  check("gráfico cabe em 390px", await (async () => { await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true }); await dorme(300); const ok = await ev(`document.documentElement.scrollWidth <= 392`); await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false }); return ok; })());

  await clicar("#bt-dup-cen"); await dorme(700);
  check("duplicar seleciona 'Cópia de …' com as contas", (await txt("#proj-cenarios .ativo")) === "Cópia de Notebook 6x" && (await ev(`document.querySelectorAll('#sec-conta tr[data-conta]').length`)) === 2);
  check("renomear abre modal", await abrirModalCom("#bt-ren-cen"));
  await preencher('#modal-form [name="nome"]', "Notebook 12x"); await enviarModal();
  check("renomeado", (await txt("#proj-cenarios .ativo")) === "Notebook 12x");
  await clicar("#sec-conta tr[data-conta]");
  check("clicar numa conta abre edição com Apagar", (await esperar(`document.querySelector("#modal").open && !document.querySelector("#modal-apagar").hidden`)));
  await ev(`document.querySelector("#modal-cancelar").click()`);
  await clicar("#bt-apg-cen"); await dorme(700);
  check("apagar o selecionado volta para 'Sem a compra'", (await txt("#proj-cenarios .ativo")) === "Sem a compra", await txt("#proj-cenarios .ativo"));

  // ajustes em despesas fixas
  const comb = (await api("POST", "/api/recorrencias", { descricao: "Combustível", dia: 10, valor: 900, categoria_id: 1, inicio: "2020-01" })).id;
  const spot = (await api("POST", "/api/recorrencias", { descricao: "Spotify", dia: 12, valor: 30, categoria_id: 1, inicio: "2020-01" })).id;
  const cen = (await api("POST", "/api/projecao/cenarios", { nome: "Corte" })).id;
  const mesesP = (await api("GET", "/api/projecao")).meses;
  const totaisReais = async () => JSON.stringify((await api("GET", `/api/mes/${mes}`)).totais);
  const reaisAntes = await totaisReais();
  await ev(`render()`); await dorme(800);
  const rec = (i) => txt(`tr[data-linha="rec"] td[data-i="${i}"]`);
  const abrirMes = async (i) => {   // idempotente: clicar no mês já aberto o fecharia
    if ((await ev(`document.querySelector("th.mes-aberto .mes-btn")?.dataset.mesI`)) !== String(i)) await clicar(`th .mes-btn[data-mes-i="${i}"]`);
    await esperar(`!!document.querySelector("#proj-painel tr")`);
  };
  const linhaPainel = (nome, botao) => ev(`(()=>{const tr=[...document.querySelectorAll("#proj-painel tr")].find(t=>t.textContent.includes(${JSON.stringify(nome)}));tr.querySelector(${JSON.stringify(botao)}).click();return true})()`);
  const aplicarModal = async (valor, alcance, escopo) => {
    await esperar(`document.querySelector("#modal").open`);
    await preencher('#modal-form [name="valor"]', valor);
    await ev(`document.querySelector('#modal [name="alcance"][value="${alcance}"]').checked = true`);
    await ev(`document.querySelector('#modal [name="escopo"][value="${escopo}"]').checked = true`);
    await enviarModal();
  };

  check("recorrências sem ajuste: 3.930 no mês 1", (await rec(1)) === "3.930,00", await rec(1));
  await abrirMes(1);
  check("painel lista as despesas do mês", (await txt("#proj-painel")).includes("Combustível") && (await txt("#proj-painel")).includes("Aluguel"));
  await linhaPainel("Combustível", "[data-editar]");
  await aplicarModal("700", "diante", "geral");
  check("ajuste geral em diante: mês 1 vira 3.730", (await rec(1)) === "3.730,00", await rec(1));
  check("ajuste geral em diante: mês 5 também", (await rec(5)) === "3.730,00", await rec(5));
  check("ajuste não vale antes do mês escolhido", (await rec(0)) === "3.930,00", await rec(0));
  check("painel mostra 'era' e selo 'geral'", (await txt("#proj-painel")).includes("era") && (await txt("#proj-painel")).includes("geral"));
  check("cabeçalho do mês ganha a marca de ajuste", (await txt('th .mes-btn[data-mes-i="1"]')).includes("•"));

  await clicar(`#proj-cenarios button[data-cen="${cen}"]`); await dorme(500);
  check("ajuste geral vale no cenário", (await rec(1)) === "3.730,00", await rec(1));
  await abrirMes(1);
  await linhaPainel("Spotify", "[data-editar]");
  await aplicarModal("0", "mes", "cenario");
  check("ajuste de cenário (Spotify 0) vale no cenário", (await rec(1)) === "3.700,00", await rec(1));
  check("painel: cancelado na projeção", (await txt("#proj-painel")).includes("cancelado na projeção"));
  await linhaPainel("Spotify", "[data-editar]");
  await esperar(`document.querySelector("#modal").open`);
  check("editar item com ajuste do cenário já vem com 'só neste cenário' marcado", await ev(`document.querySelector('#modal [name="escopo"][value="cenario"]').checked`));
  await ev(`document.querySelector("#modal-cancelar").click()`);

  // desfazer: mostra o escopo, pede confirmação mesmo de um mês só e avisa o que passa a valer
  await linhaPainel("Spotify", "[data-desfazer]");
  check("desfazer de um mês só abre confirmação (não apaga direto)", await esperar(`document.querySelector("#modal").open`));
  check("confirmação diz que o ajuste é só deste cenário", (await txt("#modal-corpo")).includes("só neste cenário"), await txt("#modal-corpo"));
  await ev(`document.querySelector("#modal-cancelar").click()`);
  check("cancelar a confirmação mantém o ajuste", (await rec(1)) === "3.700,00", await rec(1));
  await api("POST", "/api/projecao/ajustes", { tipo: "rec", ref_id: comb, valor: 500, mes_inicio: mesesP[1], mes_fim: mesesP[1], escopo: "cenario", cenario_id: cen });
  await ev(`render()`); await dorme(800);
  await linhaPainel("Combustível", "[data-desfazer]");
  await esperar(`document.querySelector("#modal").open`);
  check("desfazer avisa qual ajuste passa a valer", (await txt("#modal-corpo")).includes("passa a valer") && (await txt("#modal-corpo")).includes("todos os cenários"), await txt("#modal-corpo"));
  await enviarModal();
  check("confirmar desfaz o ajuste do cenário e revela o geral", (await rec(1)) === "3.700,00" && (await ev(`!document.querySelector("#modal").open`)), await rec(1));
  check("normalizarMes aceita AAAA-MM, MM/AAAA e rejeita lixo", await ev(`normalizarMes("2027-03")==="2027-03" && normalizarMes("03/2027")==="2027-03" && normalizarMes("3/2027")==="2027-03" && normalizarMes("13/2027")===null && normalizarMes("abc")===null`));

  await clicar('#proj-cenarios button[data-cen=""]'); await dorme(500);
  check("ajuste de cenário não vale em 'Sem a compra'", (await rec(1)) === "3.730,00", await rec(1));
  await abrirMes(1);
  await linhaPainel("Spotify", "[data-editar]");
  check("'Sem a compra' não oferece 'só em este cenário'", await ev(`!!document.querySelector('#modal [name="escopo"][value="geral"]') && !document.querySelector('#modal [name="escopo"][value="cenario"]')`));
  await ev(`document.querySelector("#modal-cancelar").click()`);

  // pausa (intervalo) e desfazer só um mês
  await api("POST", "/api/projecao/ajustes", { tipo: "rec", ref_id: 1, valor: 2500, mes_inicio: mesesP[1], mes_fim: mesesP[3], escopo: "geral" });
  await ev(`render()`); await dorme(800);
  check("pausa: meses 1 a 3 reduzidos, mês 4 volta ao normal", (await rec(3)) === "3.230,00" && (await rec(4)) === "3.730,00", `${await rec(3)} ${await rec(4)}`);
  await abrirMes(2);
  await linhaPainel("Aluguel", "[data-desfazer]");
  check("desfazer num ajuste de vários meses pergunta o alcance", await esperar(`document.querySelector("#modal").open && !document.querySelector("#modal-apagar").hidden`));
  await enviarModal();
  check("desfazer só o mês 2: mês 2 normal, 1 e 3 ajustados", (await rec(2)) === "3.730,00" && (await rec(1)) === "3.230,00" && (await rec(3)) === "3.230,00", `${await rec(1)} ${await rec(2)} ${await rec(3)}`);

  // gráfico com e sem ajustes
  await clicar('#proj-cenarios button[data-cen=""]'); await dorme(300);
  check("gráfico sem ajustes desligado por padrão", (await svg("path.sem-ajustes")) === 0);
  await clicar("#ck-sem-ajustes"); await dorme(300);
  check("'Mostrar sem ajustes' desenha as linhas pontilhadas", (await svg("path.sem-ajustes")) >= 1, String(await svg("path.sem-ajustes")));
  check("legenda explica o pontilhado", (await ev(`document.querySelector("#proj-grafico .legenda").textContent`)).includes("sem ajustes"));
  check("gráfico com sem-ajustes sem NaN", await ev(`!document.querySelector("#proj-grafico svg").innerHTML.includes("NaN")`));
  await clicar("#bt-modo-graf"); await dorme(200);
  check("troca de eixo mantém as linhas sem ajustes", (await svg("path.sem-ajustes")) >= 1);
  await clicar("#ck-sem-ajustes"); await dorme(300);
  check("desligar remove as linhas sem ajustes", (await svg("path.sem-ajustes")) === 0);

  check("totais reais (aba Mês) intactos depois dos ajustes", (await totaisReais()) === reaisAntes, await totaisReais());
  const reaisDepois = JSON.parse(await totaisReais());
  check("recorrências reais do mês seguem em 3.930", reaisDepois.recorrencias === 3930, JSON.stringify(reaisDepois));

  console.log(falhas ? `${falhas} falha(s)` : "tudo certo");
  ch.kill(); process.exit(falhas ? 1 : 0);
})();
