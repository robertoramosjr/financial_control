"use strict";

// ------------------------------------------------------------ utilidades

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const numero = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const R = (v) => moeda.format(v || 0);
const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
  "Setembro", "Outubro", "Novembro", "Dezembro"];
const MESES_CURTOS = MESES.map((m) => m.slice(0, 3).toLowerCase());

const hoje = new Date();
const pad = (n) => String(n).padStart(2, "0");
const HOJE_ISO = `${hoje.getFullYear()}-${pad(hoje.getMonth() + 1)}-${pad(hoje.getDate())}`;
const MES_ATUAL = HOJE_ISO.slice(0, 7);

const estado = {
  categorias: [],
  filtroParc: "em_andamento",
  mostrarEncerradas: false,
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function somarMeses(mes, n) {
  const [a, m] = mes.split("-").map(Number);
  const i = a * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
const nomeMes = (mes) => `${MESES[Number(mes.slice(5)) - 1]} ${mes.slice(0, 4)}`;
const mesCurto = (mes) => (mes ? `${MESES_CURTOS[Number(mes.slice(5, 7)) - 1]}/${mes.slice(0, 4)}` : "");
const dataBR = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const sinal = (v) => (v < 0 ? "negativo" : v > 0 ? "positivo" : "");

// Aceita "1.234,56", "1234.56", "R$ 50" e somas como "60,80 + 21,95" (como na planilha).
function lerValor(txt) {
  let s = String(txt ?? "").replace(/R\$|\s|^=/g, "");
  if (!s) return null;
  const partes = s.match(/[+-]?[^+-]+/g);
  if (!partes) return NaN;
  let total = 0;
  for (let p of partes) {
    let neg = p.startsWith("-");
    p = p.replace(/^[+-]/, "");
    if (p.includes(",")) p = p.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(p)) p = p.replace(/\./g, "");
    const n = Number(p);
    if (!isFinite(n)) return NaN;
    total += neg ? -n : n;
  }
  return Math.round(total * 100) / 100;
}

async function api(metodo, url, corpo) {
  const resp = await fetch(url, {
    method: metodo,
    headers: corpo ? { "Content-Type": "application/json" } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (resp.status === 401 && url !== "/api/login") {
    location.href = "/login.html";
    throw new Error("Sessão expirada");
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(dados.erro || `Erro ${resp.status}`);
  return dados;
}

let timerAviso;
function aviso(msg, erro = false) {
  const el = $("#aviso");
  el.textContent = msg;
  el.className = "visivel" + (erro ? " erro-aviso" : "");
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => (el.className = ""), erro ? 4000 : 1800);
}

async function carregarCategorias() {
  estado.categorias = await api("GET", "/api/categorias");
}

function opcoesCategoria(selecionada) {
  return estado.categorias
    .map((c) => `<option value="${c.id}" ${c.id === selecionada ? "selected" : ""}>${esc(c.nome)}</option>`)
    .join("");
}

// ------------------------------------------------------------ modal

/** Abre o formulário em janela. salvar(dados) e apagar() devolvem Promise. */
function abrirModal({ titulo, corpo, salvar, apagar, textoOk = "Salvar", aoAbrir }) {
  const dlg = $("#modal");
  $("#modal-titulo").textContent = titulo;
  $("#modal-corpo").innerHTML = corpo;
  $("#modal-erro").textContent = "";
  $("#modal-ok").textContent = textoOk;
  const btApagar = $("#modal-apagar");
  btApagar.hidden = !apagar;

  const form = $("#modal-form");
  const erro = (e) => ($("#modal-erro").textContent = e.message || e);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await salvar(Object.fromEntries(new FormData(form)), form);
      dlg.close();
      render();
    } catch (e) { erro(e); }
  };
  btApagar.onclick = async () => {
    try {
      if (await apagar()) { dlg.close(); render(); }
    } catch (e) { erro(e); }
  };
  $("#modal-cancelar").onclick = () => dlg.close();
  dlg.showModal();
  aoAbrir?.(form);
  $("input:not([type=hidden]), select", form)?.focus();
}

function exigirValor(txt, nome = "Valor") {
  const v = lerValor(txt);
  if (v === null || Number.isNaN(v)) throw new Error(`${nome} inválido`);
  return v;
}

// ------------------------------------------------------------ formulários

function modalAvulso(mes, item) {
  const ehNovo = !item;
  item = item || { descricao: "", data: HOJE_ISO.startsWith(mes) ? HOJE_ISO : "", valor: "", categoria_id: null };
  abrirModal({
    titulo: ehNovo ? "Nova compra avulsa" : "Editar compra",
    corpo: `
      <label class="campo"><span>Descrição</span><input name="descricao" required value="${esc(item.descricao)}"></label>
      <div class="campo-linha">
        <label class="campo"><span>Valor (R$)</span><input name="valor" required inputmode="decimal"
          value="${item.valor !== "" ? numero.format(item.valor) : ""}" placeholder="ex.: 60,80 + 21,95"></label>
        <label class="campo"><span>Data da compra</span><input type="date" name="data" value="${esc(item.data || "")}"></label>
      </div>
      <div class="campo-linha">
        <label class="campo"><span>Categoria</span><select name="categoria_id" required>${opcoesCategoria(item.categoria_id)}</select></label>
        <label class="campo"><span>Conta no mês de</span><input type="month" name="mes" required value="${esc(item.mes || mes)}"></label>
      </div>
      <p class="dica">"Conta no mês de" é o mês em que a despesa entra (ex.: o mês da fatura do cartão).</p>`,
    salvar: (d) => api(ehNovo ? "POST" : "PUT", ehNovo ? "/api/lancamentos" : `/api/lancamentos/${item.id}`, {
      ...d, valor: exigirValor(d.valor), categoria_id: Number(d.categoria_id), pago: item.pago || false,
    }),
    apagar: ehNovo ? null : async () => {
      if (!confirm(`Apagar "${item.descricao}"?`)) return false;
      await api("DELETE", `/api/lancamentos/${item.id}`);
      return true;
    },
  });
}

function modalRecorrencia(rec, mesContexto = MES_ATUAL) {
  const ehNovo = !rec;
  rec = rec || { descricao: "", valor: "", dia: 10, categoria_id: null, inicio: mesContexto, fim: null };
  const blocoAplicar = ehNovo ? "" : `
    <fieldset class="campo" style="border:1px solid var(--borda);border-radius:8px;padding:8px 12px">
      <legend class="tag">Mudou valor, descrição, dia ou categoria?</legend>
      <label><input type="radio" name="modo" value="frente" checked> Vale a partir de
        <input type="month" name="a_partir_de" value="${mesContexto > rec.inicio ? mesContexto : rec.inicio}"></label>
      <p class="dica" style="margin:4px 0 6px">Os meses anteriores continuam com o valor antigo.</p>
      <label><input type="radio" name="modo" value="todos"> Corrigir em todos os meses (foi erro de digitação)</label>
    </fieldset>`;
  abrirModal({
    titulo: ehNovo ? "Nova recorrência" : "Editar recorrência",
    corpo: `
      <label class="campo"><span>Descrição</span><input name="descricao" required value="${esc(rec.descricao)}"></label>
      <div class="campo-linha">
        <label class="campo"><span>Valor mensal (R$)</span><input name="valor" required inputmode="decimal"
          value="${rec.valor !== "" ? numero.format(rec.valor) : ""}"></label>
        <label class="campo"><span>Dia do vencimento</span><input type="number" name="dia" min="1" max="31" required value="${rec.dia}"></label>
      </div>
      <label class="campo"><span>Categoria</span><select name="categoria_id" required>${opcoesCategoria(rec.categoria_id)}</select></label>
      <div class="campo-linha">
        <label class="campo"><span>Primeiro mês</span><input type="month" name="inicio" required value="${esc(rec.inicio)}"></label>
        <label class="campo"><span>Último mês (opcional)</span><input type="month" name="fim" value="${esc(rec.fim || "")}"></label>
      </div>
      <p class="dica">Cancelou a assinatura? Preencha o último mês em que ela é cobrada — os meses anteriores ficam como estão.</p>
      ${blocoAplicar}`,
    salvar: (d) => {
      const corpo = { ...d, valor: exigirValor(d.valor), dia: Number(d.dia), categoria_id: Number(d.categoria_id) };
      if (d.modo !== "frente") delete corpo.a_partir_de;
      return api(ehNovo ? "POST" : "PUT", ehNovo ? "/api/recorrencias" : `/api/recorrencias/${rec.id}`, corpo);
    },
    apagar: ehNovo ? null : async () => {
      if (!confirm(`Apagar "${rec.descricao}" de TODOS os meses, inclusive os passados?\n\n` +
        `Se a conta só acabou, cancele preenchendo o "Último mês" em vez de apagar.`)) return false;
      await api("DELETE", `/api/recorrencias/${rec.id}`);
      return true;
    },
  });
}

function modalParcelamento(p, mesContexto = MES_ATUAL) {
  const ehNovo = !p;
  const dia = HOJE_ISO.slice(8, 10);
  p = p || { descricao: "", primeira_parcela: `${mesContexto}-${dia}`, valor: "", n_parcelas: "", categoria_id: null };
  abrirModal({
    titulo: ehNovo ? "Novo parcelamento" : "Editar parcelamento",
    corpo: `
      <label class="campo"><span>Descrição</span><input name="descricao" required value="${esc(p.descricao)}"></label>
      <div class="campo-linha">
        <label class="campo"><span>Nº de parcelas</span><input type="number" name="n_parcelas" min="1" required value="${p.n_parcelas}"></label>
        <label class="campo"><span>Data da 1ª parcela</span><input type="date" name="primeira_parcela" required value="${esc(p.primeira_parcela)}"></label>
      </div>
      <div class="campo-linha">
        <label class="campo"><span>Valor de cada parcela (R$)</span><input name="valor" required inputmode="decimal"
          value="${p.valor !== "" ? numero.format(p.valor) : ""}"></label>
        <label class="campo"><span>…ou valor total (R$)</span><input name="total" inputmode="decimal" placeholder="divide pelas parcelas"></label>
      </div>
      <label class="campo"><span>Categoria</span><select name="categoria_id" required>${opcoesCategoria(p.categoria_id)}</select></label>
      <p class="dica" id="previa-parc"></p>`,
    aoAbrir: (form) => {
      const atualizar = (origem) => {
        const n = Number(form.n_parcelas.value);
        if (origem === "total" && n > 0) {
          const t = lerValor(form.total.value);
          if (t) form.valor.value = numero.format(Math.round((t / n) * 100) / 100);
        }
        const v = lerValor(form.valor.value);
        const ini = form.primeira_parcela.value.slice(0, 7);
        $("#previa-parc").textContent = n > 0 && v && ini
          ? `${n}x de ${R(v)} = ${R(v * n)} · de ${mesCurto(ini)} até ${mesCurto(somarMeses(ini, n - 1))}`
          : "";
      };
      form.total.addEventListener("input", () => atualizar("total"));
      form.n_parcelas.addEventListener("input", () => atualizar(form.total.value ? "total" : ""));
      form.valor.addEventListener("input", () => { form.total.value = ""; atualizar(); });
      form.primeira_parcela.addEventListener("input", () => atualizar());
      atualizar();
    },
    salvar: (d) => api(ehNovo ? "POST" : "PUT", ehNovo ? "/api/parcelamentos" : `/api/parcelamentos/${p.id}`, {
      descricao: d.descricao, primeira_parcela: d.primeira_parcela, n_parcelas: Number(d.n_parcelas),
      valor: exigirValor(d.valor, "Valor da parcela"), categoria_id: Number(d.categoria_id),
    }),
    apagar: ehNovo ? null : async () => {
      if (!confirm(`Apagar o parcelamento "${p.descricao}" de todos os meses?`)) return false;
      await api("DELETE", `/api/parcelamentos/${p.id}`);
      return true;
    },
  });
}

// ------------------------------------------------------------ aba Mês

async function telaMes(mes) {
  const v = await api("GET", `/api/mes/${mes}`);
  const t = v.totais;
  const maiorCat = Math.max(1, ...v.por_categoria.map(([, x]) => x));

  const linhaItem = (i, colExtra) => `
    <tr class="clicavel ${i.pago ? "pago" : ""}" data-tipo="${i.tipo}" data-id="${i.id}">
      <td class="chk"><input type="checkbox" title="Pago" ${i.pago ? "checked" : ""}></td>
      <td>${esc(i.descricao)}</td>
      <td class="esconde-celular">${colExtra}</td>
      <td class="esconde-celular tag">${esc(i.categoria)}</td>
      <td class="num">${R(i.valor)}</td>
    </tr>`;

  const tabela = (itens, cabExtra, colExtra, extraFim = "") => `
    <div class="rolagem"><table>
      <thead><tr><th class="centro">Pago</th><th>Descrição</th><th class="esconde-celular">${cabExtra}</th>
        <th class="esconde-celular">Categoria</th><th class="num">Valor</th></tr></thead>
      <tbody>${itens.map((i) => linhaItem(i, colExtra(i))).join("")}${extraFim}</tbody>
    </table></div>`;

  const novaLinha = `
    <tr class="nova-linha">
      <td></td>
      <td><input id="nv-desc" placeholder="Nova compra… (Enter para adicionar)"></td>
      <td><input id="nv-data" type="date" value="${HOJE_ISO.startsWith(mes) ? HOJE_ISO : ""}"></td>
      <td><select id="nv-cat"><option value="">Categoria…</option>${opcoesCategoria()}</select></td>
      <td><input id="nv-valor" inputmode="decimal" placeholder="0,00" style="text-align:right"></td>
    </tr>`;

  $("#conteudo").innerHTML = `
    <div class="cabecalho">
      <div class="navmes">
        <button class="icone" data-ir="${somarMeses(mes, -1)}" title="Mês anterior">‹</button>
        <strong>${nomeMes(mes)}</strong>
        <button class="icone" data-ir="${somarMeses(mes, 1)}" title="Próximo mês">›</button>
      </div>
      ${mes !== MES_ATUAL ? `<button class="discreto" data-ir="${MES_ATUAL}">Ir para hoje</button>` : ""}
      <span class="espaco"></span>
      <button class="primario" id="bt-avulso">+ Compra</button>
      <button id="bt-parc">+ Parcelamento</button>
      <button id="bt-rec">+ Recorrência</button>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Entradas</span><strong>${R(t.entradas)}</strong></div>
      <div class="kpi"><span>Despesas</span><strong>${R(t.despesas)}</strong></div>
      <div class="kpi"><span>Saldo do mês</span><strong class="${sinal(t.saldo)}">${R(t.saldo)}</strong></div>
      <div class="kpi"><span>Falta pagar</span><strong>${R(t.a_pagar)}</strong></div>
    </div>
    <div class="grade-mes">
      <div>
        <section class="cartao">
          <header><h3>Compras avulsas</h3><span class="tag">${v.avulsos.length}</span><span class="soma">${R(t.avulsos)}</span></header>
          ${tabela(v.avulsos, "Data", (i) => dataBR(i.data), novaLinha)}
        </section>
        <section class="cartao">
          <header><h3>Recorrências</h3><span class="tag">${v.recorrencias.length}</span><span class="soma">${R(t.recorrencias)}</span></header>
          ${v.recorrencias.length ? tabela(v.recorrencias, "Vence", (i) => dataBR(i.data)) : `<p class="vazio">Nenhuma recorrência neste mês.</p>`}
        </section>
        <section class="cartao">
          <header><h3>Parcelas</h3><span class="tag">${v.parcelas.length}</span><span class="soma">${R(t.parcelas)}</span></header>
          ${v.parcelas.length ? tabela(v.parcelas, "Parcela", (i) => `<span class="pill">${i.parcela}/${i.n_parcelas}</span>`) : `<p class="vazio">Nenhuma parcela neste mês.</p>`}
        </section>
      </div>
      <aside class="cartao">
        <header><h3>Por categoria</h3></header>
        <div class="barras-cat">
          ${v.por_categoria.map(([c, x]) => `
            <div class="barra-cat">
              <div><span>${esc(c)}</span><span>${R(x)} · ${t.despesas ? Math.round((x / t.despesas) * 100) : 0}%</span></div>
              <div class="trilho"><i style="width:${(x / maiorCat) * 100}%"></i></div>
            </div>`).join("") || `<p class="tag">Sem despesas.</p>`}
        </div>
      </aside>
    </div>`;

  $$("[data-ir]").forEach((b) => (b.onclick = () => (location.hash = `#mes/${b.dataset.ir}`)));
  $("#bt-avulso").onclick = () => modalAvulso(mes);
  $("#bt-parc").onclick = () => modalParcelamento(null, mes);
  $("#bt-rec").onclick = () => modalRecorrencia(null, mes);

  const todos = [...v.avulsos, ...v.recorrencias, ...v.parcelas];
  const acha = (tr) => todos.find((i) => i.tipo === tr.dataset.tipo && i.id === Number(tr.dataset.id));

  $$("tr[data-tipo]").forEach((tr) => {
    tr.onclick = async (ev) => {
      const item = acha(tr);
      if (ev.target.matches("input[type=checkbox]")) {
        try {
          await api("POST", "/api/pago", { tipo: item.tipo, id: item.id, mes, pago: ev.target.checked });
          render();
        } catch (e) { aviso(e.message, true); ev.target.checked = !ev.target.checked; }
        return;
      }
      if (item.tipo === "avulso") return modalAvulso(mes, { ...item, mes });
      const lista = await api("GET", item.tipo === "rec" ? "/api/recorrencias" : "/api/parcelamentos");
      const cad = lista.find((x) => x.id === item.id);
      item.tipo === "rec" ? modalRecorrencia(cad, mes) : modalParcelamento(cad, mes);
    };
  });

  // Adição rápida de compra avulsa (Enter em qualquer campo da linha nova)
  const nova = $(".nova-linha");
  nova?.addEventListener("keydown", async (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const desc = $("#nv-desc").value.trim();
    const valor = lerValor($("#nv-valor").value);
    const cat = Number($("#nv-cat").value);
    if (!desc) return $("#nv-desc").focus();
    if (valor === null || Number.isNaN(valor)) return $("#nv-valor").focus();
    if (!cat) return $("#nv-cat").focus();
    try {
      await api("POST", "/api/lancamentos", { mes, descricao: desc, data: $("#nv-data").value, valor, categoria_id: cat });
      aviso("Compra adicionada");
      sessionStorage.setItem("focoNova", "1");
      await render();
    } catch (e) { aviso(e.message, true); }
  });
  if (sessionStorage.getItem("focoNova")) {
    sessionStorage.removeItem("focoNova");
    $("#nv-desc")?.focus();
  }
}

// ------------------------------------------------------------ aba Recorrências

async function telaRecorrencias() {
  const lista = await api("GET", "/api/recorrencias");
  const visiveis = lista.filter((r) => estado.mostrarEncerradas || r.ativa || r.inicio > MES_ATUAL);
  const totalAtivas = lista.filter((r) => r.ativa).reduce((s, r) => s + r.valor, 0);
  const vigencia = (r) => (r.fim ? `${mesCurto(r.inicio)} → ${mesCurto(r.fim)}` : `desde ${mesCurto(r.inicio)}`);

  $("#conteudo").innerHTML = `
    <div class="cabecalho">
      <h2>Recorrências</h2>
      <span class="tag">contas e assinaturas que se repetem todo mês</span>
      <span class="espaco"></span>
      <label class="tag"><input type="checkbox" id="mostrar-enc" ${estado.mostrarEncerradas ? "checked" : ""}> mostrar encerradas</label>
      <button class="primario" id="bt-nova">+ Nova recorrência</button>
    </div>
    <section class="cartao">
      <header><h3>${visiveis.length} recorrências</h3><span class="soma">Ativas: ${R(totalAtivas)}/mês</span></header>
      <div class="rolagem"><table>
        <thead><tr><th>Descrição</th><th class="centro">Dia</th><th class="esconde-celular">Categoria</th>
          <th class="esconde-celular">Vigência</th><th class="num">Valor</th></tr></thead>
        <tbody>${visiveis.map((r) => `
          <tr class="clicavel ${r.ativa || r.inicio > MES_ATUAL ? "" : "apagada"}" data-id="${r.id}">
            <td>${esc(r.descricao)} ${!r.ativa && r.inicio > MES_ATUAL ? `<span class="pill">futura</span>` : ""}
              ${!r.ativa && r.inicio <= MES_ATUAL ? `<span class="pill">encerrada</span>` : ""}</td>
            <td class="centro">${r.dia}</td>
            <td class="esconde-celular tag">${esc(r.categoria)}</td>
            <td class="esconde-celular tag">${vigencia(r)}</td>
            <td class="num">${R(r.valor)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </section>`;

  $("#bt-nova").onclick = () => modalRecorrencia(null);
  $("#mostrar-enc").onchange = (e) => { estado.mostrarEncerradas = e.target.checked; render(); };
  $$("tr[data-id]").forEach((tr) => (tr.onclick = () => modalRecorrencia(lista.find((r) => r.id === Number(tr.dataset.id)))));
}

// ------------------------------------------------------------ aba Parcelamentos

async function telaParcelamentos() {
  const lista = await api("GET", "/api/parcelamentos");
  const filtros = { em_andamento: "Em andamento", a_comecar: "A começar", quitado: "Quitados", todos: "Todos" };
  const conta = (f) => (f === "todos" ? lista.length : lista.filter((p) => p.situacao === f).length);
  const visiveis = lista.filter((p) => estado.filtroParc === "todos" || p.situacao === estado.filtroParc);
  const andamento = lista.filter((p) => p.situacao === "em_andamento");
  const mensal = andamento.reduce((s, p) => s + p.valor, 0);
  const restante = lista.reduce((s, p) => s + p.restante_apos_mes, 0);

  const progresso = (p) => {
    if (p.situacao === "a_comecar") return `<span class="pill">começa ${mesCurto(p.primeira_parcela)}</span>`;
    if (p.situacao === "quitado") return `<span class="pill ok">quitado</span>`;
    return `<div class="progresso"><div class="trilho"><i style="width:${(p.parcela_atual / p.n_parcelas) * 100}%"></i></div>
      <span class="tag">${p.parcela_atual}/${p.n_parcelas}</span></div>`;
  };

  $("#conteudo").innerHTML = `
    <div class="cabecalho">
      <h2>Parcelamentos</h2>
      <span class="espaco"></span>
      <button class="primario" id="bt-novo">+ Novo parcelamento</button>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Parcelas deste mês</span><strong>${R(mensal)}</strong></div>
      <div class="kpi"><span>Em andamento</span><strong>${andamento.length}</strong></div>
      <div class="kpi"><span>Ainda a pagar depois deste mês</span><strong>${R(restante)}</strong></div>
      <div class="kpi"><span>Terminam este mês</span><strong>${andamento.filter((p) => p.ultimo_mes === MES_ATUAL).length}</strong></div>
    </div>
    <div class="cabecalho">
      <div class="filtros">${Object.entries(filtros).map(([k, n]) =>
        `<button data-f="${k}" class="${estado.filtroParc === k ? "ativo" : ""}">${n} (${conta(k)})</button>`).join("")}</div>
    </div>
    <section class="cartao">
      <div class="rolagem"><table>
        <thead><tr><th>Descrição</th><th class="esconde-celular">Categoria</th><th>Andamento</th>
          <th class="num">Parcela</th><th class="esconde-celular">Última</th><th class="num esconde-celular">Falta (após este mês)</th></tr></thead>
        <tbody>${visiveis.map((p) => `
          <tr class="clicavel" data-id="${p.id}">
            <td>${esc(p.descricao)}</td>
            <td class="esconde-celular tag">${esc(p.categoria)}</td>
            <td>${progresso(p)}</td>
            <td class="num">${R(p.valor)}</td>
            <td class="esconde-celular tag">${mesCurto(p.ultimo_mes)}</td>
            <td class="num esconde-celular">${p.restante_apos_mes ? R(p.restante_apos_mes) : "—"}</td>
          </tr>`).join("") || `<tr><td colspan="6" class="tag">Nada aqui.</td></tr>`}
        </tbody>
      </table></div>
    </section>`;

  $("#bt-novo").onclick = () => modalParcelamento(null);
  $$("[data-f]").forEach((b) => (b.onclick = () => { estado.filtroParc = b.dataset.f; render(); }));
  $$("tr[data-id]").forEach((tr) => (tr.onclick = () => modalParcelamento(lista.find((p) => p.id === Number(tr.dataset.id)))));
}

// ------------------------------------------------------------ aba Entradas

async function telaEntradas(ano) {
  const d = await api("GET", `/api/entradas/${ano}`);
  const totalMes = (m) => d.fontes.reduce((s, f) => s + (f.valores[m] || 0), 0);
  const totalFonte = (f) => f.valores.reduce((s, x) => s + (x || 0), 0);

  $("#conteudo").innerHTML = `
    <div class="cabecalho">
      <div class="navmes">
        <button class="icone" data-ano="${ano - 1}">‹</button><strong>Entradas ${ano}</strong><button class="icone" data-ano="${ano + 1}">›</button>
      </div>
      <span class="espaco"></span>
      <button class="primario" id="bt-fonte">+ Fonte de renda</button>
    </div>
    <p class="dica">Digite o valor e saia do campo para salvar. Pode somar direto: <code>4636,35 + 1936,59</code>. Clique no nome da fonte para renomear ou apagar.</p>
    <section class="cartao entradas"><div class="rolagem"><table>
      <thead><tr><th>Fonte</th>${MESES_CURTOS.map((m) => `<th class="num">${m}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>
        ${d.fontes.map((f) => `<tr>
          <td><button class="discreto" data-fonte="${f.id}">${esc(f.nome)}</button></td>
          ${f.valores.map((x, m) => `<td><input data-f="${f.id}" data-m="${m}" inputmode="decimal" style="min-width:86px"
              value="${x != null ? numero.format(x) : ""}"></td>`).join("")}
          <td class="num"><strong>${R(totalFonte(f))}</strong></td></tr>`).join("")}
        <tr><td><strong>Total</strong></td>${MESES_CURTOS.map((_, m) => `<td class="num"><strong>${numero.format(totalMes(m))}</strong></td>`).join("")}
          <td class="num"><strong>${R(d.fontes.reduce((s, f) => s + totalFonte(f), 0))}</strong></td></tr>
      </tbody>
    </table></div></section>`;

  $$("[data-ano]").forEach((b) => (b.onclick = () => (location.hash = `#entradas/${b.dataset.ano}`)));
  $$("input[data-f]").forEach((inp) => {
    inp.onchange = async () => {
      const v = lerValor(inp.value);
      if (Number.isNaN(v)) return aviso("Valor inválido", true);
      try {
        await api("PUT", "/api/entradas", { fonte_id: Number(inp.dataset.f), mes: `${ano}-${pad(Number(inp.dataset.m) + 1)}`, valor: v });
        aviso("Salvo");
        render();
      } catch (e) { aviso(e.message, true); }
    };
    inp.onkeydown = (e) => e.key === "Enter" && inp.blur();
  });
  const modalFonte = (f) => abrirModal({
    titulo: f ? "Fonte de renda" : "Nova fonte de renda",
    corpo: `<label class="campo"><span>Nome</span><input name="nome" required value="${esc(f?.nome || "")}"></label>`,
    salvar: (dd) => api(f ? "PUT" : "POST", f ? `/api/fontes/${f.id}` : "/api/fontes", dd),
    apagar: f && (async () => {
      if (!confirm(`Apagar "${f.nome}" e todos os valores lançados nela?`)) return false;
      await api("DELETE", `/api/fontes/${f.id}`);
      return true;
    }),
  });
  $("#bt-fonte").onclick = () => modalFonte(null);
  $$("[data-fonte]").forEach((b) => (b.onclick = () => modalFonte(d.fontes.find((f) => f.id === Number(b.dataset.fonte)))));
}

// ------------------------------------------------------------ aba Resumo

function graficoAno(meses) {
  const W = 900, H = 300, m = { t: 16, r: 12, b: 28, l: 56 };
  const vals = meses.flatMap((x) => [x.entradas, x.despesas, x.acumulado]);
  let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const passo = Math.pow(10, Math.floor(Math.log10(Math.max(max - min, 1)))) / 2 || 1;
  max = Math.ceil(max / passo) * passo; min = Math.floor(min / passo) * passo;
  const y = (v) => m.t + ((max - v) / (max - min || 1)) * (H - m.t - m.b);
  const lw = (W - m.l - m.r) / 12;
  const bw = lw * 0.32;
  const xc = (i) => m.l + lw * i + lw / 2;
  const fmtK = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k` : v);

  let grade = "";
  for (let v = min; v <= max + 1e-6; v += passo * (((max - min) / passo) > 8 ? 2 : 1)) {
    grade += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--linha)"/>
      <text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--suave)">${fmtK(v)}</text>`;
  }
  const barras = meses.map((x, i) => `
    <rect x="${xc(i) - bw - 1}" y="${y(Math.max(0, x.entradas))}" width="${bw}" height="${Math.abs(y(x.entradas) - y(0))}" rx="2" fill="var(--barra-entrada)"><title>${MESES[i]} · Entradas ${R(x.entradas)}</title></rect>
    <rect x="${xc(i) + 1}" y="${y(Math.max(0, x.despesas))}" width="${bw}" height="${Math.abs(y(x.despesas) - y(0))}" rx="2" fill="var(--barra-despesa)"><title>${MESES[i]} · Despesas ${R(x.despesas)}</title></rect>
    <text x="${xc(i)}" y="${H - 8}" text-anchor="middle" font-size="12" fill="var(--suave)">${MESES_CURTOS[i]}</text>`).join("");
  const linha = meses.map((x, i) => `${i ? "L" : "M"}${xc(i)},${y(x.acumulado)}`).join(" ");
  const pontos = meses.map((x, i) => `<circle cx="${xc(i)}" cy="${y(x.acumulado)}" r="3.5" fill="var(--cartao)" stroke="var(--linha-acum)" stroke-width="2"><title>${MESES[i]} · Acumulado ${R(x.acumulado)}</title></circle>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Entradas, despesas e saldo acumulado por mês">
    ${grade}<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--suave)"/>
    ${barras}<path d="${linha}" fill="none" stroke="var(--linha-acum)" stroke-width="2"/>${pontos}</svg>`;
}

async function telaResumo(ano) {
  const d = await api("GET", `/api/resumo/${ano}`);
  const soma = (k) => d.meses.reduce((s, x) => s + x[k], 0);
  const cats = d.categorias.map((c) => ({ ...c, total: c.valores.reduce((s, x) => s + x, 0) }))
    .filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const totalDesp = soma("despesas");

  $("#conteudo").innerHTML = `
    <div class="cabecalho">
      <div class="navmes">
        <button class="icone" data-ano="${ano - 1}">‹</button><strong>Resumo ${ano}</strong><button class="icone" data-ano="${ano + 1}">›</button>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><span>Entradas no ano</span><strong>${R(soma("entradas"))}</strong></div>
      <div class="kpi"><span>Despesas no ano</span><strong>${R(totalDesp)}</strong></div>
      <div class="kpi"><span>Saldo do ano</span><strong class="${sinal(soma("saldo"))}">${R(soma("saldo"))}</strong></div>
      <div class="kpi"><span>Média de despesas/mês</span><strong>${R(totalDesp / 12)}</strong></div>
    </div>
    <section class="cartao">
      <header><h3>Projeção do ano</h3></header>
      <div class="grafico">${graficoAno(d.meses)}</div>
      <div class="legenda"><span><i style="background:var(--barra-entrada)"></i>Entradas</span>
        <span><i style="background:var(--barra-despesa)"></i>Despesas</span>
        <span><i style="background:var(--linha-acum);height:3px"></i>Saldo acumulado</span></div>
    </section>
    <section class="cartao"><div class="rolagem"><table>
      <thead><tr><th>Mês</th><th class="num">Entradas</th><th class="num">Despesas</th><th class="num">Saldo do mês</th><th class="num">Acumulado</th></tr></thead>
      <tbody>${d.meses.map((x) => `
        <tr class="clicavel" data-mes="${x.mes}">
          <td>${MESES[Number(x.mes.slice(5)) - 1]}${x.mes === MES_ATUAL ? ` <span class="pill">atual</span>` : ""}</td>
          <td class="num">${R(x.entradas)}</td><td class="num">${R(x.despesas)}</td>
          <td class="num ${sinal(x.saldo)}">${R(x.saldo)}</td><td class="num ${sinal(x.acumulado)}">${R(x.acumulado)}</td>
        </tr>`).join("")}</tbody>
    </table></div></section>
    <section class="cartao">
      <header><h3>Gastos por categoria</h3></header>
      <div class="rolagem"><table>
        <thead><tr><th>Categoria</th>${MESES_CURTOS.map((m) => `<th class="num">${m}</th>`).join("")}<th class="num">Total</th><th class="num">%</th></tr></thead>
        <tbody>${cats.map((c) => `<tr><td style="white-space:nowrap">${esc(c.nome)}</td>
          ${c.valores.map((x) => `<td class="num">${x ? numero.format(x) : `<span class="tag">—</span>`}</td>`).join("")}
          <td class="num"><strong>${numero.format(c.total)}</strong></td>
          <td class="num">${totalDesp ? Math.round((c.total / totalDesp) * 100) : 0}%</td></tr>`).join("")}
        </tbody>
      </table></div>
    </section>`;

  $$("[data-ano]").forEach((b) => (b.onclick = () => (location.hash = `#resumo/${b.dataset.ano}`)));
  $$("tr[data-mes]").forEach((tr) => (tr.onclick = () => (location.hash = `#mes/${tr.dataset.mes}`)));
}

// ------------------------------------------------------------ aba Categorias

async function telaCategorias() {
  await carregarCategorias();
  $("#conteudo").innerHTML = `
    <div class="cabecalho"><h2>Categorias</h2><span class="espaco"></span><button class="primario" id="bt-nova">+ Nova categoria</button></div>
    <section class="cartao"><table>
      <thead><tr><th>Nome</th><th class="num">Itens usando</th></tr></thead>
      <tbody>${estado.categorias.map((c) => `<tr class="clicavel" data-id="${c.id}"><td>${esc(c.nome)}</td><td class="num tag">${c.usos}</td></tr>`).join("")}</tbody>
    </table></section>`;

  const modalCat = (c) => abrirModal({
    titulo: c ? "Editar categoria" : "Nova categoria",
    corpo: `<label class="campo"><span>Nome</span><input name="nome" required value="${esc(c?.nome || "")}"></label>
      ${c && c.usos ? `<label class="campo"><span>Ao apagar, mover os ${c.usos} itens para</span>
        <select name="mover_para">${estado.categorias.filter((x) => x.id !== c.id).map((x) => `<option value="${x.id}">${esc(x.nome)}</option>`).join("")}</select></label>` : ""}`,
    salvar: async (d) => { await api(c ? "PUT" : "POST", c ? `/api/categorias/${c.id}` : "/api/categorias", { nome: d.nome }); },
    apagar: c && (async () => {
      const destino = $("#modal-form").mover_para?.value;
      if (!confirm(`Apagar a categoria "${c.nome}"?`)) return false;
      await api("DELETE", `/api/categorias/${c.id}`, { mover_para: destino ? Number(destino) : null });
      return true;
    }),
  });
  $("#bt-nova").onclick = () => modalCat(null);
  $$("tr[data-id]").forEach((tr) => (tr.onclick = () => modalCat(estado.categorias.find((c) => c.id === Number(tr.dataset.id)))));
}

// ------------------------------------------------------------ navegação

async function render() {
  const [aba = "mes", param] = location.hash.slice(1).split("/");
  $$("#abas a").forEach((a) => a.classList.toggle("ativa", a.dataset.aba === aba));
  try {
    await carregarCategorias();
    const ano = Number(param) || hoje.getFullYear();
    const telas = {
      mes: () => telaMes(/^\d{4}-\d{2}$/.test(param || "") ? param : MES_ATUAL),
      recorrencias: telaRecorrencias,
      parcelamentos: telaParcelamentos,
      entradas: () => telaEntradas(ano),
      resumo: () => telaResumo(ano),
      categorias: telaCategorias,
    };
    await (telas[aba] || telas.mes)();
  } catch (e) {
    $("#conteudo").innerHTML = `<p class="erro">Não consegui carregar: ${esc(e.message)}. O servidor (app.py) está rodando?</p>`;
  }
}

async function iniciar() {
  const eu = await api("GET", "/api/eu").catch(() => ({}));
  if (eu.exige_login && !eu.usuario) return (location.href = "/login.html");
  if (eu.usuario) {
    const bt = $("#sair");
    bt.hidden = false;
    bt.title = `Conectado como ${eu.usuario}`;
    bt.onclick = async () => { await api("POST", "/api/logout"); location.href = "/login.html"; };
  }
  window.addEventListener("hashchange", render);
  render();
}

iniciar();
