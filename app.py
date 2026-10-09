#!/usr/bin/env python3
"""Controle Financeiro - servidor.

Uso no computador:
    python3 app.py                    # abre em http://localhost:8765
    python3 app.py --usuario roberto  # cria usuário (ou troca a senha dele)

Na internet (PythonAnywhere etc.) o servidor importa `application` (WSGI) deste
arquivo, com CF_PUBLICO=1 no ambiente: aí o login é obrigatório e o cookie só vale em HTTPS.

Só usa a biblioteca padrão do Python. Os dados ficam em dados.db (SQLite), na pasta
do programa ou na indicada pela variável CF_DADOS, com cópia a cada 6 horas em backups/.
Se existir pelo menos um usuário cadastrado, o sistema pede login.
"""
import argparse
import calendar
import getpass
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import webbrowser
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from http.cookies import SimpleCookie
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

BASE = Path(__file__).resolve().parent
DADOS = Path(os.environ.get("CF_DADOS", BASE))
DB_PATH = DADOS / "dados.db"
STATIC = BASE / "static"
BACKUPS = DADOS / "backups"
MANTER_BACKUPS = 30
SESSAO_DIAS = 90
PUBLICO = os.environ.get("CF_PUBLICO") == "1"   # login obrigatório e cookie só via HTTPS

SCHEMA = """
CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE,
    ordem INTEGER NOT NULL DEFAULT 0
);
-- Contas que se repetem todo mês. Vigência por mês (AAAA-MM): 'inicio' e 'fim'
-- (fim NULL = sem data para acabar). Encerrar uma recorrência não apaga o histórico.
CREATE TABLE IF NOT EXISTS recorrencias (
    id INTEGER PRIMARY KEY,
    descricao TEXT NOT NULL,
    dia INTEGER NOT NULL CHECK (dia BETWEEN 1 AND 31),
    valor_centavos INTEGER NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    inicio TEXT NOT NULL,
    fim TEXT
);
CREATE TABLE IF NOT EXISTS parcelamentos (
    id INTEGER PRIMARY KEY,
    descricao TEXT NOT NULL,
    primeira_parcela TEXT NOT NULL,          -- AAAA-MM-DD
    valor_parcela_centavos INTEGER NOT NULL,
    n_parcelas INTEGER NOT NULL CHECK (n_parcelas >= 1),
    categoria_id INTEGER NOT NULL REFERENCES categorias(id)
);
-- Compras avulsas. 'mes' é o mês em que a despesa conta (ex.: mês da fatura).
CREATE TABLE IF NOT EXISTS lancamentos (
    id INTEGER PRIMARY KEY,
    mes TEXT NOT NULL,
    descricao TEXT NOT NULL,
    data TEXT,
    valor_centavos INTEGER NOT NULL,
    categoria_id INTEGER NOT NULL REFERENCES categorias(id),
    pago INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_lanc_mes ON lancamentos(mes);
-- "Pago" de recorrências e parcelas fica preso ao item (tipo + id) e ao mês,
-- então cadastrar algo novo nunca desloca as marcações dos outros.
CREATE TABLE IF NOT EXISTS pagamentos (
    tipo TEXT NOT NULL CHECK (tipo IN ('rec', 'parc')),
    ref_id INTEGER NOT NULL,
    mes TEXT NOT NULL,
    PRIMARY KEY (tipo, ref_id, mes)
);
CREATE TABLE IF NOT EXISTS fontes_renda (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE,
    ordem INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS entradas (
    fonte_id INTEGER NOT NULL REFERENCES fontes_renda(id) ON DELETE CASCADE,
    mes TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL,
    PRIMARY KEY (fonte_id, mes)
);
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS falhas_login (
    ip TEXT NOT NULL,
    quando REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira TEXT NOT NULL
);
"""

CATEGORIAS_PADRAO = ["Moradia", "Alimentação", "Transporte", "Saúde", "Educação",
                     "Lazer", "Assinaturas", "Vestuário", "Outros"]

MES_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DATA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------- utilidades

class ErroEntrada(Exception):
    pass


@contextmanager
def conectar():
    """Conexão com commit no fim (ou rollback se der erro) e sempre fechada."""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        with con:
            yield con
    finally:
        con.close()


def iniciar_banco():
    novo = not DB_PATH.exists()
    with conectar() as con:
        con.executescript(SCHEMA)
        if novo:
            con.executemany("INSERT INTO categorias (nome, ordem) VALUES (?, ?)",
                            [(n, i) for i, n in enumerate(CATEGORIAS_PADRAO)])


def fazer_backup():
    if not DB_PATH.exists():
        return
    BACKUPS.mkdir(exist_ok=True)
    destino = BACKUPS / f"dados-{date.today().isoformat()}.db"
    copia = sqlite3.connect(destino)
    with conectar() as origem:
        origem.backup(copia)
    copia.close()
    antigos = sorted(BACKUPS.glob("dados-*.db"))[:-MANTER_BACKUPS]
    for arq in antigos:
        arq.unlink()


def talvez_backup():
    """Chamado a cada requisição: faz cópia se a última tiver mais de 6 horas."""
    ultimo = max((a.stat().st_mtime for a in BACKUPS.glob("dados-*.db")), default=0) if BACKUPS.exists() else 0
    if time.time() - ultimo > 6 * 3600:
        try:
            fazer_backup()
        except Exception as e:  # noqa: BLE001 - backup falhar não pode derrubar o servidor
            print("Falha no backup:", e, file=sys.stderr)


# ---------------------------------------------------------------- login

ITERACOES = 600_000


def hash_senha(senha):
    sal = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", senha.encode(), sal, ITERACOES)
    return f"pbkdf2_sha256${ITERACOES}${sal.hex()}${h.hex()}"


def conferir_senha(senha, guardado):
    _, it, sal, h = guardado.split("$")
    calc = hashlib.pbkdf2_hmac("sha256", senha.encode(), bytes.fromhex(sal), int(it))
    return hmac.compare_digest(calc.hex(), h)


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def existe_usuario():
    with conectar() as con:
        return con.execute("SELECT 1 FROM usuarios LIMIT 1").fetchone() is not None


def usuario_da_sessao(token):
    if not token:
        return None
    with conectar() as con:
        r = con.execute("""SELECT u.nome FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
                           WHERE s.token_hash = ? AND s.expira > ?""",
                        (hash_token(token), datetime.now().isoformat())).fetchone()
    return r["nome"] if r else None


# Senhas erradas: no máximo 10 por IP e 30 no total a cada 15 minutos. Fica no banco
# para valer mesmo se o servidor reiniciar ou rodar em mais de um processo.
LIMITE_IP, LIMITE_GERAL, JANELA = 10, 30, 15 * 60


def login_bloqueado(con, ip):
    con.execute("DELETE FROM falhas_login WHERE quando < ?", (time.time() - JANELA,))
    por_ip = con.execute("SELECT COUNT(*) FROM falhas_login WHERE ip = ?", (ip,)).fetchone()[0]
    geral = con.execute("SELECT COUNT(*) FROM falhas_login").fetchone()[0]
    return por_ip >= LIMITE_IP or geral >= LIMITE_GERAL


def fazer_login(con, d):
    nome, senha = str(d.get("usuario", "")).strip(), str(d.get("senha", ""))
    u = con.execute("SELECT id, senha_hash FROM usuarios WHERE nome = ?", (nome,)).fetchone()
    if not u or not conferir_senha(senha, u["senha_hash"]):
        return None
    token = secrets.token_urlsafe(32)
    con.execute("DELETE FROM sessoes WHERE expira <= ?", (datetime.now().isoformat(),))
    con.execute("INSERT INTO sessoes (token_hash, usuario_id, expira) VALUES (?, ?, ?)",
                (hash_token(token), u["id"], (datetime.now() + timedelta(days=SESSAO_DIAS)).isoformat()))
    return token


def cadastrar_usuario(nome):
    iniciar_banco()
    senha = getpass.getpass(f"Senha para {nome}: ")
    if len(senha) < 8:
        sys.exit("A senha precisa ter pelo menos 8 caracteres.")
    if getpass.getpass("Repita a senha: ") != senha:
        sys.exit("As senhas não conferem.")
    with conectar() as con:
        con.execute("""INSERT INTO usuarios (nome, senha_hash) VALUES (?, ?)
                       ON CONFLICT (nome) DO UPDATE SET senha_hash = excluded.senha_hash""", (nome, hash_senha(senha)))
        # Trocar a senha derruba as sessões abertas desse usuário.
        con.execute("DELETE FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE nome = ?)", (nome,))
    print(f"Usuário {nome!r} pronto.")


def centavos(valor):
    try:
        return round(float(str(valor).replace(",", ".")) * 100)
    except (TypeError, ValueError):
        raise ErroEntrada(f"Valor inválido: {valor!r}")


def reais(c):
    return round(c / 100, 2)


def mes_idx(mes):
    a, m = map(int, mes.split("-"))
    return a * 12 + (m - 1)


def idx_mes(i):
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def somar_meses(mes, n):
    return idx_mes(mes_idx(mes) + n)


def data_no_mes(mes, dia):
    a, m = map(int, mes.split("-"))
    return date(a, m, min(dia, calendar.monthrange(a, m)[1])).isoformat()


def exigir(d, campo, tipo=str):
    v = d.get(campo)
    if v is None or (isinstance(v, str) and not v.strip()):
        raise ErroEntrada(f"Campo obrigatório: {campo}")
    return v.strip() if isinstance(v, str) else tipo(v)


def exigir_mes(d, campo, opcional=False):
    v = d.get(campo)
    if opcional and not v:
        return None
    if not isinstance(v, str) or not MES_RE.match(v):
        raise ErroEntrada(f"Mês inválido em {campo}: use AAAA-MM")
    return v


def exigir_data(d, campo, opcional=False):
    v = d.get(campo)
    if opcional and not v:
        return None
    if not isinstance(v, str) or not DATA_RE.match(v):
        raise ErroEntrada(f"Data inválida em {campo}: use AAAA-MM-DD")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise ErroEntrada(f"Data inválida em {campo}: {v}")
    return v


def exigir_categoria(con, d):
    cid = d.get("categoria_id")
    if not con.execute("SELECT 1 FROM categorias WHERE id = ?", (cid,)).fetchone():
        raise ErroEntrada("Escolha uma categoria válida")
    return cid


# ------------------------------------------------------------ regras do mês

def recorrencias_do_mes(con, mes):
    rows = con.execute("""
        SELECT r.*, c.nome AS categoria, (p.mes IS NOT NULL) AS pago
        FROM recorrencias r
        JOIN categorias c ON c.id = r.categoria_id
        LEFT JOIN pagamentos p ON p.tipo = 'rec' AND p.ref_id = r.id AND p.mes = ?
        WHERE r.inicio <= ? AND (r.fim IS NULL OR r.fim >= ?)
        ORDER BY r.dia, r.descricao""", (mes, mes, mes)).fetchall()
    return [{
        "tipo": "rec", "id": r["id"], "descricao": r["descricao"],
        "data": data_no_mes(mes, r["dia"]), "valor": reais(r["valor_centavos"]),
        "categoria_id": r["categoria_id"], "categoria": r["categoria"], "pago": bool(r["pago"]),
    } for r in rows]


def numero_parcela(primeira, mes):
    return mes_idx(mes) - mes_idx(primeira[:7]) + 1


def parcelas_do_mes(con, mes):
    rows = con.execute("""
        SELECT pa.*, c.nome AS categoria, (p.mes IS NOT NULL) AS pago
        FROM parcelamentos pa
        JOIN categorias c ON c.id = pa.categoria_id
        LEFT JOIN pagamentos p ON p.tipo = 'parc' AND p.ref_id = pa.id AND p.mes = ?
        """, (mes,)).fetchall()
    out = []
    for r in rows:
        k = numero_parcela(r["primeira_parcela"], mes)
        if 1 <= k <= r["n_parcelas"]:
            out.append({
                "tipo": "parc", "id": r["id"], "descricao": r["descricao"],
                "parcela": k, "n_parcelas": r["n_parcelas"],
                "data": data_no_mes(mes, int(r["primeira_parcela"][8:10])),
                "valor": reais(r["valor_parcela_centavos"]),
                "categoria_id": r["categoria_id"], "categoria": r["categoria"],
                "pago": bool(r["pago"]),
            })
    out.sort(key=lambda x: (x["data"], x["descricao"].lower()))
    return out


def avulsos_do_mes(con, mes):
    rows = con.execute("""
        SELECT l.*, c.nome AS categoria FROM lancamentos l
        JOIN categorias c ON c.id = l.categoria_id
        WHERE l.mes = ? ORDER BY l.data, l.id""", (mes,)).fetchall()
    return [{
        "tipo": "avulso", "id": r["id"], "descricao": r["descricao"], "data": r["data"],
        "valor": reais(r["valor_centavos"]), "categoria_id": r["categoria_id"],
        "categoria": r["categoria"], "pago": bool(r["pago"]),
    } for r in rows]


def entradas_do_mes(con, mes):
    return reais(con.execute("SELECT COALESCE(SUM(valor_centavos), 0) FROM entradas WHERE mes = ?",
                             (mes,)).fetchone()[0])


def total(itens):
    return round(sum(i["valor"] for i in itens), 2)


def visao_mes(con, mes):
    av, rec, parc = avulsos_do_mes(con, mes), recorrencias_do_mes(con, mes), parcelas_do_mes(con, mes)
    todos = av + rec + parc
    por_cat = {}
    for i in todos:
        por_cat[i["categoria"]] = round(por_cat.get(i["categoria"], 0) + i["valor"], 2)
    despesas = total(todos)
    entradas = entradas_do_mes(con, mes)
    return {
        "mes": mes, "avulsos": av, "recorrencias": rec, "parcelas": parc,
        "totais": {
            "avulsos": total(av), "recorrencias": total(rec), "parcelas": total(parc),
            "despesas": despesas, "entradas": entradas, "saldo": round(entradas - despesas, 2),
            "a_pagar": round(sum(i["valor"] for i in todos if not i["pago"]), 2),
        },
        "por_categoria": sorted(por_cat.items(), key=lambda kv: -kv[1]),
    }


def resumo_ano(con, ano):
    cats = [r["nome"] for r in con.execute("SELECT nome FROM categorias ORDER BY ordem, nome")]
    meses, matriz, acumulado = [], {c: [0.0] * 12 for c in cats}, 0.0
    for m in range(1, 13):
        v = visao_mes(con, f"{ano:04d}-{m:02d}")
        acumulado = round(acumulado + v["totais"]["saldo"], 2)
        meses.append({"mes": v["mes"], "despesas": v["totais"]["despesas"],
                      "entradas": v["totais"]["entradas"], "saldo": v["totais"]["saldo"],
                      "acumulado": acumulado})
        for cat, valor in v["por_categoria"]:
            matriz.setdefault(cat, [0.0] * 12)[m - 1] = valor
    return {"ano": ano, "meses": meses, "categorias": [{"nome": c, "valores": matriz[c]} for c in matriz]}


# -------------------------------------------------------------- cadastros

def listar_recorrencias(con):
    hoje = date.today().isoformat()[:7]
    rows = con.execute("""SELECT r.*, c.nome AS categoria FROM recorrencias r
                          JOIN categorias c ON c.id = r.categoria_id
                          ORDER BY (r.fim IS NOT NULL AND r.fim < ?), r.descricao COLLATE NOCASE""",
                       (hoje,)).fetchall()
    return [{
        "id": r["id"], "descricao": r["descricao"], "dia": r["dia"], "valor": reais(r["valor_centavos"]),
        "categoria_id": r["categoria_id"], "categoria": r["categoria"],
        "inicio": r["inicio"], "fim": r["fim"],
        "ativa": r["inicio"] <= hoje and (r["fim"] is None or r["fim"] >= hoje),
    } for r in rows]


def dados_recorrencia(con, d):
    dia = int(exigir(d, "dia", int))
    if not 1 <= dia <= 31:
        raise ErroEntrada("Dia deve estar entre 1 e 31")
    inicio, fim = exigir_mes(d, "inicio"), exigir_mes(d, "fim", opcional=True)
    if fim and fim < inicio:
        raise ErroEntrada("O mês final não pode ser antes do inicial")
    return (exigir(d, "descricao"), dia, centavos(exigir(d, "valor")), exigir_categoria(con, d), inicio, fim)


def salvar_recorrencia(con, d, rid=None):
    campos = dados_recorrencia(con, d)
    if rid is None:
        return con.execute("""INSERT INTO recorrencias (descricao, dia, valor_centavos, categoria_id, inicio, fim)
                              VALUES (?, ?, ?, ?, ?, ?)""", campos).lastrowid
    atual = con.execute("SELECT * FROM recorrencias WHERE id = ?", (rid,)).fetchone()
    if not atual:
        raise ErroEntrada("Recorrência não encontrada")
    a_partir = exigir_mes(d, "a_partir_de", opcional=True)
    mudou_conteudo = campos[:4] != (atual["descricao"], atual["dia"], atual["valor_centavos"], atual["categoria_id"])
    if mudou_conteudo and a_partir and a_partir > atual["inicio"]:
        # Mudança vale só daqui pra frente: encerra a versão antiga no mês anterior
        # e cria uma nova, levando junto as marcações de "pago" futuras.
        descricao, dia, valor, cat, _, fim = campos
        con.execute("UPDATE recorrencias SET fim = ? WHERE id = ?", (somar_meses(a_partir, -1), rid))
        novo = con.execute("""INSERT INTO recorrencias (descricao, dia, valor_centavos, categoria_id, inicio, fim)
                              VALUES (?, ?, ?, ?, ?, ?)""", (descricao, dia, valor, cat, a_partir, fim)).lastrowid
        con.execute("UPDATE pagamentos SET ref_id = ? WHERE tipo = 'rec' AND ref_id = ? AND mes >= ?",
                    (novo, rid, a_partir))
        return novo
    con.execute("""UPDATE recorrencias SET descricao=?, dia=?, valor_centavos=?, categoria_id=?, inicio=?, fim=?
                   WHERE id = ?""", campos + (rid,))
    return rid


def listar_parcelamentos(con):
    hoje = date.today().isoformat()[:7]
    rows = con.execute("""SELECT pa.*, c.nome AS categoria FROM parcelamentos pa
                          JOIN categorias c ON c.id = pa.categoria_id""").fetchall()
    out = []
    for r in rows:
        n, v = r["n_parcelas"], r["valor_parcela_centavos"]
        k = numero_parcela(r["primeira_parcela"], hoje)
        restantes = n - max(0, min(k, n))           # parcelas depois deste mês
        out.append({
            "id": r["id"], "descricao": r["descricao"], "primeira_parcela": r["primeira_parcela"],
            "valor": reais(v), "n_parcelas": n, "categoria_id": r["categoria_id"], "categoria": r["categoria"],
            "ultimo_mes": somar_meses(r["primeira_parcela"][:7], n - 1),
            "parcela_atual": k if 1 <= k <= n else None,
            "situacao": "a_comecar" if k < 1 else ("quitado" if k > n else "em_andamento"),
            "valor_total": reais(v * n), "restante_apos_mes": reais(v * restantes),
        })
    ordem = {"em_andamento": 0, "a_comecar": 1, "quitado": 2}
    out.sort(key=lambda p: (ordem[p["situacao"]], p["ultimo_mes"], p["descricao"].lower()))
    return out


def salvar_parcelamento(con, d, pid=None):
    n = int(exigir(d, "n_parcelas", int))
    if n < 1:
        raise ErroEntrada("Número de parcelas deve ser pelo menos 1")
    campos = (exigir(d, "descricao"), exigir_data(d, "primeira_parcela"), centavos(exigir(d, "valor")),
              n, exigir_categoria(con, d))
    if pid is None:
        return con.execute("""INSERT INTO parcelamentos (descricao, primeira_parcela, valor_parcela_centavos,
                              n_parcelas, categoria_id) VALUES (?, ?, ?, ?, ?)""", campos).lastrowid
    con.execute("""UPDATE parcelamentos SET descricao=?, primeira_parcela=?, valor_parcela_centavos=?,
                   n_parcelas=?, categoria_id=? WHERE id = ?""", campos + (pid,))
    return pid


def salvar_lancamento(con, d, lid=None):
    campos = (exigir_mes(d, "mes"), exigir(d, "descricao"), exigir_data(d, "data", opcional=True),
              centavos(exigir(d, "valor")), exigir_categoria(con, d), 1 if d.get("pago") else 0)
    if lid is None:
        return con.execute("""INSERT INTO lancamentos (mes, descricao, data, valor_centavos, categoria_id, pago)
                              VALUES (?, ?, ?, ?, ?, ?)""", campos).lastrowid
    con.execute("""UPDATE lancamentos SET mes=?, descricao=?, data=?, valor_centavos=?, categoria_id=?, pago=?
                   WHERE id = ?""", campos + (lid,))
    return lid


def marcar_pago(con, d):
    tipo, ref, mes = d.get("tipo"), d.get("id"), exigir_mes(d, "mes")
    if tipo == "avulso":
        con.execute("UPDATE lancamentos SET pago = ? WHERE id = ?", (1 if d.get("pago") else 0, ref))
    elif tipo in ("rec", "parc"):
        if d.get("pago"):
            con.execute("INSERT OR IGNORE INTO pagamentos (tipo, ref_id, mes) VALUES (?, ?, ?)", (tipo, ref, mes))
        else:
            con.execute("DELETE FROM pagamentos WHERE tipo = ? AND ref_id = ? AND mes = ?", (tipo, ref, mes))
    else:
        raise ErroEntrada("Tipo inválido")


def listar_categorias(con):
    return [dict(r) for r in con.execute("""
        SELECT c.id, c.nome, c.ordem,
          (SELECT COUNT(*) FROM recorrencias WHERE categoria_id = c.id)
        + (SELECT COUNT(*) FROM parcelamentos WHERE categoria_id = c.id)
        + (SELECT COUNT(*) FROM lancamentos WHERE categoria_id = c.id) AS usos
        FROM categorias c ORDER BY c.ordem, c.nome""")]


def salvar_categoria(con, d, cid=None):
    nome = exigir(d, "nome")
    try:
        if cid is None:
            ordem = con.execute("SELECT COALESCE(MAX(ordem), -1) + 1 FROM categorias").fetchone()[0]
            return con.execute("INSERT INTO categorias (nome, ordem) VALUES (?, ?)", (nome, ordem)).lastrowid
        con.execute("UPDATE categorias SET nome = ? WHERE id = ?", (nome, cid))
        return cid
    except sqlite3.IntegrityError:
        raise ErroEntrada(f"Já existe a categoria {nome!r}")


def apagar_categoria(con, cid, d):
    destino = d.get("mover_para")
    if destino:
        if int(destino) == cid:
            raise ErroEntrada("Escolha outra categoria para receber os itens")
        for tabela in ("recorrencias", "parcelamentos", "lancamentos"):
            con.execute(f"UPDATE {tabela} SET categoria_id = ? WHERE categoria_id = ?", (destino, cid))
    try:
        con.execute("DELETE FROM categorias WHERE id = ?", (cid,))
    except sqlite3.IntegrityError:
        raise ErroEntrada("Categoria em uso: escolha para qual categoria mover os itens")


def entradas_ano(con, ano):
    fontes = [dict(r) for r in con.execute("SELECT id, nome FROM fontes_renda ORDER BY ordem, nome")]
    valores = {f["id"]: [None] * 12 for f in fontes}
    for r in con.execute("SELECT fonte_id, mes, valor_centavos FROM entradas WHERE mes LIKE ?", (f"{ano:04d}-%",)):
        valores[r["fonte_id"]][int(r["mes"][5:]) - 1] = reais(r["valor_centavos"])
    for f in fontes:
        f["valores"] = valores[f["id"]]
    return {"ano": ano, "fontes": fontes}


def salvar_entrada(con, d):
    mes, fonte = exigir_mes(d, "mes"), d.get("fonte_id")
    valor = d.get("valor")
    if valor in (None, ""):
        con.execute("DELETE FROM entradas WHERE fonte_id = ? AND mes = ?", (fonte, mes))
    else:
        con.execute("""INSERT INTO entradas (fonte_id, mes, valor_centavos) VALUES (?, ?, ?)
                       ON CONFLICT (fonte_id, mes) DO UPDATE SET valor_centavos = excluded.valor_centavos""",
                    (fonte, mes, centavos(valor)))


def salvar_fonte(con, d, fid=None):
    nome = exigir(d, "nome")
    try:
        if fid is None:
            ordem = con.execute("SELECT COALESCE(MAX(ordem), -1) + 1 FROM fontes_renda").fetchone()[0]
            return con.execute("INSERT INTO fontes_renda (nome, ordem) VALUES (?, ?)", (nome, ordem)).lastrowid
        con.execute("UPDATE fontes_renda SET nome = ? WHERE id = ?", (nome, fid))
        return fid
    except sqlite3.IntegrityError:
        raise ErroEntrada(f"Já existe a fonte {nome!r}")


# ------------------------------------------------------------------ HTTP

def apagar(tabela, tipo_pag=None):
    def f(con, i, _d):
        con.execute(f"DELETE FROM {tabela} WHERE id = ?", (i,))
        if tipo_pag:
            con.execute("DELETE FROM pagamentos WHERE tipo = ? AND ref_id = ?", (tipo_pag, i))
    return f


# (método, padrão) -> função(con, id_ou_None, corpo_ou_query)
ROTAS = [
    ("GET", r"/api/mes/(\d{4}-\d{2})", lambda con, m, q: visao_mes(con, exigir_mes({"m": m}, "m"))),
    ("GET", r"/api/resumo/(\d{4})", lambda con, a, q: resumo_ano(con, int(a))),
    ("POST", r"/api/pago", lambda con, _, d: marcar_pago(con, d)),

    ("GET", r"/api/categorias", lambda con, _, q: listar_categorias(con)),
    ("POST", r"/api/categorias", lambda con, _, d: salvar_categoria(con, d)),
    ("PUT", r"/api/categorias/(\d+)", lambda con, i, d: salvar_categoria(con, d, int(i))),
    ("DELETE", r"/api/categorias/(\d+)", lambda con, i, d: apagar_categoria(con, int(i), d)),

    ("GET", r"/api/recorrencias", lambda con, _, q: listar_recorrencias(con)),
    ("POST", r"/api/recorrencias", lambda con, _, d: salvar_recorrencia(con, d)),
    ("PUT", r"/api/recorrencias/(\d+)", lambda con, i, d: salvar_recorrencia(con, d, int(i))),
    ("DELETE", r"/api/recorrencias/(\d+)", lambda con, i, d: apagar("recorrencias", "rec")(con, int(i), d)),

    ("GET", r"/api/parcelamentos", lambda con, _, q: listar_parcelamentos(con)),
    ("POST", r"/api/parcelamentos", lambda con, _, d: salvar_parcelamento(con, d)),
    ("PUT", r"/api/parcelamentos/(\d+)", lambda con, i, d: salvar_parcelamento(con, d, int(i))),
    ("DELETE", r"/api/parcelamentos/(\d+)", lambda con, i, d: apagar("parcelamentos", "parc")(con, int(i), d)),

    ("POST", r"/api/lancamentos", lambda con, _, d: salvar_lancamento(con, d)),
    ("PUT", r"/api/lancamentos/(\d+)", lambda con, i, d: salvar_lancamento(con, d, int(i))),
    ("DELETE", r"/api/lancamentos/(\d+)", lambda con, i, d: apagar("lancamentos")(con, int(i), d)),

    ("GET", r"/api/entradas/(\d{4})", lambda con, a, q: entradas_ano(con, int(a))),
    ("PUT", r"/api/entradas", lambda con, _, d: salvar_entrada(con, d)),
    ("POST", r"/api/fontes", lambda con, _, d: salvar_fonte(con, d)),
    ("PUT", r"/api/fontes/(\d+)", lambda con, i, d: salvar_fonte(con, d, int(i))),
    ("DELETE", r"/api/fontes/(\d+)", lambda con, i, d: apagar("fontes_renda")(con, int(i), d)),
]
ROTAS = [(m, re.compile(f"^{p}$"), f) for m, p, f in ROTAS]


class Resposta:
    def __init__(self, status=200, corpo=b"", tipo="application/json; charset=utf-8", cookie=None):
        if not isinstance(corpo, bytes):
            corpo = json.dumps(corpo, ensure_ascii=False).encode()
        self.status, self.corpo = status, corpo
        self.cabecalhos = [
            ("Content-Type", tipo),
            ("Content-Length", str(len(corpo))),
            ("Cache-Control", "no-store" if tipo.startswith("application/json") else "no-cache"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
        ]
        if cookie is not None:
            self.cabecalhos.append(("Set-Cookie", cookie))


class Requisicao:
    """O que o tratamento precisa saber da requisição, venha do http.server ou do WSGI."""

    def __init__(self, metodo, caminho, query, cookie, ler_corpo, ip):
        self.metodo, self.caminho, self.query, self.ip = metodo, caminho, query, ip
        c = SimpleCookie(cookie or "")
        self.token = c["sessao"].value if "sessao" in c else None
        self._ler_corpo = ler_corpo

    def json(self):
        dados = self._ler_corpo()
        return json.loads(dados or b"{}")


def cookie_sessao(token, idade):
    seguro = "; Secure" if PUBLICO else ""
    return f"sessao={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={idade}{seguro}"


def arquivo_estatico(caminho):
    nome = "index.html" if caminho in ("", "/") else caminho.lstrip("/")
    arq = (STATIC / nome).resolve()
    if STATIC.resolve() not in arq.parents or not arq.is_file():
        return Resposta(404, b"Nao encontrado", "text/plain; charset=utf-8")
    tipo = mimetypes.guess_type(arq.name)[0] or "application/octet-stream"
    if tipo.startswith("text/") or tipo in ("application/javascript", "image/svg+xml", "application/json"):
        tipo += "; charset=utf-8"
    return Resposta(200, arq.read_bytes(), tipo)


def rotas_de_login(req):
    if req.caminho == "/api/login" and req.metodo == "POST":
        d = req.json()
        with conectar() as con:
            if login_bloqueado(con, req.ip):
                return Resposta(429, {"erro": "Muitas tentativas erradas. Espere 15 minutos."})
            token = fazer_login(con, d)
            if not token:
                con.execute("INSERT INTO falhas_login (ip, quando) VALUES (?, ?)", (req.ip, time.time()))
                return Resposta(401, {"erro": "Usuário ou senha incorretos"})
        return Resposta(200, {"ok": True}, cookie=cookie_sessao(token, SESSAO_DIAS * 86400))
    if req.caminho == "/api/logout" and req.metodo == "POST":
        if req.token:
            with conectar() as con:
                con.execute("DELETE FROM sessoes WHERE token_hash = ?", (hash_token(req.token),))
        return Resposta(200, {"ok": True}, cookie=cookie_sessao("", 0))
    if req.caminho == "/api/eu" and req.metodo == "GET":
        return Resposta(200, {"usuario": usuario_da_sessao(req.token), "exige_login": PUBLICO or existe_usuario()})
    return None


def tratar(req):
    """Recebe uma Requisicao e devolve uma Resposta. Único ponto de entrada da aplicação."""
    if not req.caminho.startswith("/api/"):
        if req.metodo != "GET":
            return Resposta(405, {"erro": "Método não permitido"})
        return arquivo_estatico(req.caminho)
    try:
        talvez_backup()
        resp = rotas_de_login(req)
        if resp:
            return resp
        if (PUBLICO or existe_usuario()) and not usuario_da_sessao(req.token):
            return Resposta(401, {"erro": "Faça login"})
        for m, padrao, func in ROTAS:
            achou = padrao.match(req.caminho)
            if m == req.metodo and achou:
                break
        else:
            return Resposta(404, {"erro": "Rota não encontrada"})
        corpo = {k: v[0] for k, v in parse_qs(req.query).items()} if req.metodo == "GET" else req.json()
        with conectar() as con:
            res = func(con, achou.group(1) if achou.groups() else None, corpo)
        return Resposta(200, res if req.metodo == "GET" else {"ok": True, "id": res})
    except ErroEntrada as e:
        return Resposta(400, {"erro": str(e)})
    except Exception as e:  # noqa: BLE001 - mostra o erro na tela em vez de travar
        print("Erro:", repr(e), file=sys.stderr)
        return Resposta(500, {"erro": "Erro interno no servidor"})


def ler_limitado(ler, n):
    if n > 1_000_000:
        raise ErroEntrada("Requisição grande demais")
    return ler(n) if n else b""


# ------------------------------------------------------------ WSGI (internet)

_iniciado = threading.Lock(), [False]


def application(environ, start_response):
    trava, feito = _iniciado
    with trava:
        if not feito[0]:
            iniciar_banco()
            feito[0] = True
    # O IP real vem do proxy da hospedagem; X-Real-IP é preenchido por ele, não pelo navegador.
    ip = (environ.get("HTTP_X_REAL_IP")
          or environ.get("HTTP_X_FORWARDED_FOR", "").split(",")[-1].strip()
          or environ.get("REMOTE_ADDR", ""))
    n = int(environ.get("CONTENT_LENGTH") or 0)
    req = Requisicao(environ["REQUEST_METHOD"], environ.get("PATH_INFO", "/"), environ.get("QUERY_STRING", ""),
                     environ.get("HTTP_COOKIE"), lambda: ler_limitado(environ["wsgi.input"].read, n), ip)
    resp = tratar(req)
    start_response(f"{resp.status} {HTTPStatus(resp.status).phrase}", resp.cabecalhos)
    return [resp.corpo]


# ------------------------------------------------------------ servidor local

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def atender(self):
        url = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        req = Requisicao(self.command, url.path, url.query, self.headers.get("Cookie"),
                         lambda: ler_limitado(self.rfile.read, n), self.client_address[0])
        resp = tratar(req)
        self.send_response(resp.status)
        for k, v in resp.cabecalhos:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(resp.corpo)

    do_GET = do_POST = do_PUT = do_DELETE = atender


def main():
    ap = argparse.ArgumentParser(description="Controle Financeiro")
    ap.add_argument("--porta", type=int, default=8765)
    ap.add_argument("--usuario", metavar="NOME", help="cria o usuário ou troca a senha dele, e sai")
    ap.add_argument("--sem-navegador", action="store_true")
    args = ap.parse_args()

    if args.usuario:
        return cadastrar_usuario(args.usuario)

    iniciar_banco()
    fazer_backup()
    srv = ThreadingHTTPServer(("127.0.0.1", args.porta), Handler)
    url = f"http://localhost:{args.porta}"
    print(f"Controle Financeiro rodando em {url}  (Ctrl+C para sair)", flush=True)
    if not args.sem_navegador:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nAté mais!")


if __name__ == "__main__":
    main()
