#!/usr/bin/env python3
"""Gera as respostas de referência ("golden") que o Worker TypeScript precisa reproduzir.

Usa o app.py como fonte da verdade: monta um banco temporário com dados inventados (nunca o dados.db real),
com "hoje" fixo em 2026-11-11, e grava em tests/golden/:
  semente.sql            INSERTs do banco de teste (o Worker carrega isto no D1 de teste)
  mes-AAAA-MM.json       resposta de visao_mes para 2026-01 .. 2027-12
  resumo-AAAA.json       resposta de resumo_ano para 2026 e 2027
  entradas-AAAA.json     resposta de entradas_ano para 2026 e 2027
  lista-*.json           listagens de categorias, recorrências, parcelamentos e provisões
  semente-projecao.sql   INSERTs dos dados de projeção (aplicados por cima de semente.sql)
  projecao-*.json        resposta de projecao(): base (sem cenários), completa e com outro mês de partida

Rodar de novo só quando o app.py mudar de comportamento:  python3 scripts/gerar_golden.py
"""
import json
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
import app  # noqa: E402

SAIDA = RAIZ / "tests" / "golden"
HOJE = date(2026, 11, 11)
HOJE_MES = "2026-11"

# Ordem em que as tabelas precisam ser preenchidas por causa das chaves estrangeiras.
ORDEM_TABELAS = ["categorias", "fontes_renda", "provisoes", "provisao_meses", "recorrencias", "parcelamentos",
                 "lancamentos", "pagamentos", "entradas", "projecao_entradas", "cenarios", "projecao_contas",
                 "projecao_ajustes"]


# Dados de projeção ficam numa segunda semente, aplicada por cima do núcleo.
TABELAS_PROJECAO = ["projecao_entradas", "cenarios", "projecao_contas", "projecao_ajustes"]


class DataFixa(date):
    """app.date.today() devolve sempre HOJE, para o resultado não depender do dia em que se roda."""

    @classmethod
    def today(cls):
        return HOJE


def semear(con):
    """Dados do núcleo (mês, resumo, cadastros). Cobrem as arestas das regras: dia 31, parcela de mês curto,
    provisão com estouro, mês fechado, valor do mês fora da vigência, empate de data/descrição na ordenação."""
    con.executemany("INSERT INTO recorrencias (id, descricao, dia, valor_centavos, categoria_id, inicio, fim) VALUES (?,?,?,?,?,?,?)", [
        (1, "Aluguel", 5, 150000, 1, "2026-01", None),
        (2, "Netflix", 31, 5590, 7, "2026-03", "2026-12"),
        (3, "Curso de inglês", 10, 19999, 5, "2026-06", "2026-09"),
        (4, "Academia", 15, 8990, 4, "2027-01", None),
        (5, "Internet", 10, 11990, 1, "2026-01", None),
        (6, "Água", 10, 6000, 1, "2026-01", None),
    ])
    con.executemany("INSERT INTO parcelamentos (id, descricao, primeira_parcela, valor_parcela_centavos, n_parcelas, categoria_id) VALUES (?,?,?,?,?,?)", [
        (1, "Notebook", "2026-09-20", 25000, 12, 9),
        (2, "Celular", "2026-01-31", 19990, 6, 9),
        (3, "Sofá", "2026-11-05", 43333, 3, 1),
        (4, "geladeira", "2026-11-05", 29900, 5, 1),
    ])
    con.executemany("INSERT INTO provisoes (id, descricao, categoria_id, valor_centavos, inicio, fim) VALUES (?,?,?,?,?,?)", [
        (1, "Saídas", 6, 60000, "2026-01", None),
        (2, "Mercado", 2, 120000, "2026-05", "2027-06"),
        (3, "Viagem", 6, 30000, "2026-01", "2026-03"),
        (4, "Cabelo", 9, 10000, "2026-11", "2026-11"),
    ])
    con.executemany("INSERT INTO provisao_meses (provisao_id, mes, valor_centavos) VALUES (?,?,?)", [
        (1, "2026-11", 45000), (1, "2026-12", 0), (3, "2026-11", 80000),
    ])
    con.executemany("INSERT INTO lancamentos (id, mes, descricao, data, valor_centavos, categoria_id, pago, provisao_id) VALUES (?,?,?,?,?,?,?,?)", [
        (1, "2026-10", "Mercado", "2026-10-03", 35090, 2, 1, None),
        (2, "2026-10", "Jantar", None, 40000, 6, 0, 1),
        (3, "2026-10", "Cinema", "2026-10-12", 30000, 6, 0, 1),
        (4, "2026-11", "Pizza", "2026-11-08", 15000, 6, 0, 1),
        (5, "2026-11", "Cinema", "2026-11-09", 10000, 6, 1, 1),
        (6, "2026-11", "Feira", "2026-11-02", 130000, 2, 0, 2),
        (7, "2026-11", "Farmácia", None, 4590, 4, 0, None),
        (8, "2026-11", "Presente", "2026-11-02", 8000, 9, 1, None),
        (9, "2026-12", "Show", "2026-12-20", 20000, 6, 0, 1),
        (10, "2026-12", "Mercado", "2026-12-01", 30000, 2, 0, 2),
        (11, "2027-01", "Matrícula", "2027-01-10", 50000, 5, 0, None),
        (12, "2026-02", "Hotel", "2026-02-14", 12000, 6, 1, 3),
    ])
    con.executemany("INSERT INTO pagamentos (tipo, ref_id, mes) VALUES (?,?,?)", [
        ("rec", 1, "2026-10"), ("rec", 1, "2026-11"), ("rec", 2, "2026-11"), ("parc", 2, "2026-11"), ("parc", 1, "2026-10"),
    ])
    con.executemany("INSERT INTO fontes_renda (id, nome, ordem) VALUES (?,?,?)", [(1, "Salário", 0), (2, "Extra", 1)])
    entradas = [(1, f"2026-{m:02d}", 800000) for m in range(1, 13)]
    entradas += [(1, f"2027-{m:02d}", 850000) for m in range(1, 7)]
    entradas += [(2, "2026-03", 120050), (2, "2026-11", 50000), (2, "2027-02", 30000)]
    con.executemany("INSERT INTO entradas (fonte_id, mes, valor_centavos) VALUES (?,?,?)", entradas)


def semear_projecao(con):
    """Dados de projeção, aplicados por cima do núcleo: entrada digitada (inclusive zero), 2 cenários, contas com
    parcela que não divide certo, e ajustes de todo tipo (geral, de cenário, pausa, sobreposição por ordem)."""
    con.executemany("INSERT INTO projecao_entradas (mes, valor_centavos) VALUES (?,?)", [
        ("2026-12", 900000), ("2027-01", 0), ("2027-04", 950000),
    ])
    con.executemany("INSERT INTO cenarios (id, nome, ordem) VALUES (?,?,?)", [(1, "Notebook novo", 0), (2, "Viagem", 1)])
    con.executemany("INSERT INTO projecao_contas (id, cenario_id, descricao, total_centavos, n_parcelas, primeira_parcela) VALUES (?,?,?,?,?,?)", [
        (1, 1, "Notebook", 600000, 12, "2026-12"),
        (2, 1, "Capa", 10001, 2, "2027-01"),
        (3, 2, "Passagens", 250000, 5, "2027-02"),
        (4, None, "IPVA", 300000, 3, "2027-01"),
        (5, 2, "Hotel", 33333, 7, "2026-11"),
    ])
    con.executemany("INSERT INTO projecao_ajustes (id, cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos, ordem) VALUES (?,?,?,?,?,?,?,?)", [
        (1, None, "rec", 1, "2026-12", None, 180000, 1),
        (2, 1, "rec", 2, "2027-01", "2027-03", 0, 2),
        (3, 2, "parc", 1, "2026-12", "2027-02", 10000, 3),
        (4, None, "rec", 1, "2027-01", "2027-02", 200000, 4),
        (5, 1, "rec", 1, "2027-02", None, 170000, 5),
    ])


def sql_de_insercao(con, tabelas):
    """INSERTs das tabelas pedidas, na ordem das chaves estrangeiras, uma instrução por linha."""
    por_tabela = {}
    for linha in con.iterdump():
        achou = re.match(r'INSERT INTO "(\w+)"', linha)
        if achou:
            por_tabela.setdefault(achou.group(1), []).append(linha)
    return "\n".join(l for t in tabelas for l in por_tabela.get(t, [])) + "\n"


def gravar_json(nome, dados):
    (SAIDA / nome).write_text(json.dumps(dados, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def main():
    SAIDA.mkdir(parents=True, exist_ok=True)
    for antigo in SAIDA.glob("*.json"):
        antigo.unlink()
    app.date = DataFixa
    with tempfile.TemporaryDirectory() as tmp:
        app.DB_PATH = Path(tmp) / "golden.db"
        app.BACKUPS = Path(tmp) / "backups"
        app.iniciar_banco()
        with app.conectar() as con:
            semear(con)
            nucleo = [t for t in ORDEM_TABELAS if t not in TABELAS_PROJECAO]
            (SAIDA / "semente.sql").write_text(sql_de_insercao(con, nucleo), encoding="utf-8")
            gravar_json("projecao-base.json", app.projecao(con, HOJE_MES))   # só despesas reais, sem cenários
            for ano in (2026, 2027):
                for m in range(1, 13):
                    mes = f"{ano}-{m:02d}"
                    gravar_json(f"mes-{mes}.json", app.visao_mes(con, mes, HOJE_MES))
                gravar_json(f"resumo-{ano}.json", app.resumo_ano(con, ano))
                gravar_json(f"entradas-{ano}.json", app.entradas_ano(con, ano))
            gravar_json("lista-categorias.json", app.listar_categorias(con))
            gravar_json("lista-recorrencias.json", app.listar_recorrencias(con))
            gravar_json("lista-parcelamentos.json", app.listar_parcelamentos(con))
            gravar_json("lista-provisoes.json", app.listar_provisoes(con))
            semear_projecao(con)
            (SAIDA / "semente-projecao.sql").write_text(sql_de_insercao(con, TABELAS_PROJECAO), encoding="utf-8")
            gravar_json("projecao-completa.json", app.projecao(con, HOJE_MES))
            gravar_json("projecao-2026-03.json", app.projecao(con, "2026-03"))   # outro mês de partida: outros meses "fechados"
    print("Golden gerado em", SAIDA.relative_to(RAIZ))


if __name__ == "__main__":
    main()
