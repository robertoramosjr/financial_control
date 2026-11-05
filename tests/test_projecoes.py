import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

INICIO = "2026-11"


class BancoTemporario(unittest.TestCase):
    """Cada teste roda num banco novo e temporário: o dados.db real nunca é tocado."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._antigos = (app.DB_PATH, app.BACKUPS)
        app.DB_PATH = Path(self._tmp.name) / "teste.db"
        app.BACKUPS = Path(self._tmp.name) / "backups"
        app.iniciar_banco()

    def tearDown(self):
        app.DB_PATH, app.BACKUPS = self._antigos
        self._tmp.cleanup()


def recorrencia(con, valor, inicio="2026-01", fim=None):
    con.execute("""INSERT INTO recorrencias (descricao, dia, valor_centavos, categoria_id, inicio, fim)
                   VALUES ('Aluguel', 5, ?, 1, ?, ?)""", (round(valor * 100), inicio, fim))


def entrada_real(con, mes, valor):
    con.execute("INSERT OR IGNORE INTO fontes_renda (id, nome) VALUES (1, 'Salário')")
    con.execute("INSERT INTO entradas (fonte_id, mes, valor_centavos) VALUES (1, ?, ?)", (mes, round(valor * 100)))


def entrada_digitada(con, mes, valor):
    con.execute("INSERT INTO projecao_entradas (mes, valor_centavos) VALUES (?, ?)", (mes, round(valor * 100)))


def cenario(con, nome="Notebook"):
    return con.execute("INSERT INTO cenarios (nome) VALUES (?)", (nome,)).lastrowid


def conta(con, cenario_id, total, n, primeira, descricao="Conta"):
    return con.execute("""INSERT INTO projecao_contas (cenario_id, descricao, total_centavos, n_parcelas, primeira_parcela)
                          VALUES (?, ?, ?, ?, ?)""", (cenario_id, descricao, round(total * 100), n, primeira)).lastrowid


class TestParcela(unittest.TestCase):
    def test_parcela_centavos(self):
        self.assertEqual(app.parcela_centavos(10000, 3), 3333)
        self.assertEqual(app.parcela_centavos(10000, 1), 10000)
        self.assertEqual(app.parcela_centavos(10001, 2), 5001)


class TestProjecao(BancoTemporario):
    def test_cenario_base_so_tem_despesas_reais(self):
        with app.conectar() as con:
            recorrencia(con, 3000)
            entrada_real(con, INICIO, 9800)
            p = app.projecao(con, INICIO)
        base = p["cenarios"][0]
        self.assertEqual((base["id"], base["nome"], base["contas"]), (None, "Sem a compra", []))
        self.assertEqual(len(p["meses"]), 12)
        self.assertEqual(p["meses"][0], INICIO)
        self.assertEqual(base["despesas"][0], 3000.0)
        self.assertEqual(base["saldo"][0], 6800.0)
        self.assertAlmostEqual(base["comprometimento"][0], 0.306, places=3)
        self.assertEqual(p["entradas"][0], {"valor": 9800.0, "origem": "real"})

    def test_entrada_digitada_sobrepoe_real_e_zero_nao_e_vazio(self):
        with app.conectar() as con:
            entrada_real(con, INICIO, 9800)
            entrada_digitada(con, INICIO, 11000)
            entrada_digitada(con, "2026-12", 0)
            p = app.projecao(con, INICIO)
        self.assertEqual(p["entradas"][0], {"valor": 11000.0, "origem": "digitada"})
        self.assertEqual(p["entradas"][1], {"valor": 0.0, "origem": "digitada"})
        self.assertEqual(p["entradas"][2], {"valor": 0.0, "origem": "vazia"})

    def test_comprometimento_none_sem_entrada(self):
        with app.conectar() as con:
            recorrencia(con, 3000)
            base = app.projecao(con, INICIO)["cenarios"][0]
        self.assertIsNone(base["comprometimento"][0])
        self.assertEqual(base["saldo"][0], -3000.0)

    def test_conta_de_cenario_parcelas(self):
        with app.conectar() as con:
            recorrencia(con, 3000)
            conta(con, cenario(con), 3000, 6, "2026-12")
            p = app.projecao(con, INICIO)
        base, cen = p["cenarios"][0], p["cenarios"][1]
        self.assertEqual(cen["contas"][0]["valores"], [0, 500, 500, 500, 500, 500, 500, 0, 0, 0, 0, 0])
        self.assertEqual(cen["despesas"][1], base["despesas"][1] + 500)
        self.assertEqual(cen["despesas"][7], base["despesas"][7])
        self.assertEqual(base["despesas"][1], 3000.0)

    def test_conta_iniciada_antes_do_horizonte(self):
        with app.conectar() as con:
            cid = cenario(con)
            conta(con, cid, 1200, 12, "2026-09", "Doze")
            conta(con, cid, 500, 1, "2026-09", "Uma")
            contas = app.projecao(con, INICIO)["cenarios"][1]["contas"]
        doze = next(c for c in contas if c["descricao"] == "Doze")
        uma = next(c for c in contas if c["descricao"] == "Uma")
        self.assertEqual(doze["valores"][0], 100.0)           # parcela 3 de 12
        self.assertEqual(sum(1 for v in doze["valores"] if v), 10)
        self.assertEqual(uma["valores"], [0] * 12)

    def test_previstas_valem_para_todos_os_cenarios(self):
        with app.conectar() as con:
            conta(con, None, 650, 1, "2027-02", "Inglês")
            cenario(con)
            p = app.projecao(con, INICIO)
        self.assertEqual(p["previstas"][0]["valores"][3], 650.0)
        for cen in p["cenarios"]:
            self.assertEqual(cen["despesas"][3], 650.0)
            self.assertEqual(cen["despesas"][2], 0.0)

    def test_acumulado_e_pior_mes(self):
        with app.conectar() as con:
            recorrencia(con, 1000, fim="2027-01")
            for mes, v in (("2026-11", 1100), ("2026-12", 700), ("2027-01", 1200)):
                entrada_digitada(con, mes, v)
            base = app.projecao(con, INICIO)["cenarios"][0]
        self.assertEqual(base["saldo"][:3], [100.0, -300.0, 200.0])
        self.assertEqual(base["acumulado"][:3], [100.0, -200.0, 0.0])
        self.assertEqual(base["pior_mes"], {"mes": "2026-12", "saldo": -300.0})

    def test_projecao_nao_altera_totais_reais(self):
        with app.conectar() as con:
            recorrencia(con, 3000)
            entrada_real(con, INICIO, 9800)
            antes = (app.visao_mes(con, INICIO), app.resumo_ano(con, 2026))
            conta(con, cenario(con), 3000, 6, INICIO)
            conta(con, None, 650, 1, "2027-02")
            entrada_digitada(con, INICIO, 1)
            depois = (app.visao_mes(con, INICIO), app.resumo_ano(con, 2026))
        self.assertEqual(antes, depois)


def chamar(metodo, caminho, corpo=None):
    ler = (lambda: json.dumps(corpo).encode()) if corpo is not None else (lambda: b"")
    r = app.tratar(app.Requisicao(metodo, caminho, "", None, ler, "127.0.0.1"))
    return r.status, json.loads(r.corpo)


def contagem(tabela):
    with app.conectar() as con:
        return con.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]


CONTA = {"descricao": "Notebook", "valor": 3000, "n_parcelas": 6, "primeira_parcela": "2026-12"}


class TestApi(BancoTemporario):
    def novo_cenario(self, nome="Notebook 6x"):
        status, r = chamar("POST", "/api/projecao/cenarios", {"nome": nome})
        self.assertEqual(status, 200)
        return r["id"]

    def test_lote_grava_todas_as_contas(self):
        cid = self.novo_cenario()
        status, _ = chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [
            CONTA, {**CONTA, "descricao": "Viagem", "valor": 900, "n_parcelas": 3}]})
        self.assertEqual(status, 200)
        _, p = chamar("GET", "/api/projecao")
        self.assertEqual([c["descricao"] for c in p["cenarios"][1]["contas"]], ["Notebook", "Viagem"])

    def test_lote_com_linha_invalida_nao_grava_nenhuma(self):
        cid = self.novo_cenario()
        ruins = [{"n_parcelas": 0}, {"n_parcelas": 1.5}, {"valor": 0}, {"valor": -5}, {"valor": "abc"},
                 {"primeira_parcela": "2026-13"}, {"descricao": " "}]
        for ruim in ruins:
            status, _ = chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [CONTA, {**CONTA, **ruim}]})
            self.assertEqual(status, 400, ruim)
        for corpo in ({"cenario_id": 999, "contas": [CONTA]}, {"cenario_id": cid, "contas": []}):
            self.assertEqual(chamar("POST", "/api/projecao/contas", corpo)[0], 400, corpo)
        self.assertEqual(contagem("projecao_contas"), 0)

    def test_entrada_projetada_vazio_remove_e_zero_fica(self):
        self.assertEqual(chamar("PUT", "/api/projecao/entradas", {"mes": "2026-11", "valor": 1234.56})[0], 200)
        self.assertEqual(chamar("PUT", "/api/projecao/entradas", {"mes": "2026-12", "valor": 0})[0], 200)
        _, p = chamar("GET", "/api/projecao")
        self.assertEqual(p["entradas"][1], {"valor": 0.0, "origem": "digitada"})
        self.assertEqual(chamar("PUT", "/api/projecao/entradas", {"mes": "2026-11", "valor": ""})[0], 200)
        self.assertEqual(contagem("projecao_entradas"), 1)
        status, r = chamar("PUT", "/api/projecao/entradas", {"mes": "2026-11", "valor": "1.234,56"})
        self.assertEqual((status, r["erro"].split(":")[0]), (400, "Valor inválido"))
        self.assertEqual(chamar("PUT", "/api/projecao/entradas", {"mes": "2026-1", "valor": 5})[0], 400)

    def test_cenario_nome_vazio_ou_repetido(self):
        self.novo_cenario("Notebook")
        self.assertEqual(chamar("POST", "/api/projecao/cenarios", {"nome": "  "})[0], 400)
        status, r = chamar("POST", "/api/projecao/cenarios", {"nome": "NOTEBOOK"})
        self.assertEqual(status, 400)
        self.assertIn("Já existe o cenário", r["erro"])

    def test_apagar_cenario_apaga_suas_contas_e_preserva_previstas(self):
        cid = self.novo_cenario()
        chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [CONTA]})
        chamar("POST", "/api/projecao/contas", {"cenario_id": None, "contas": [CONTA]})
        self.assertEqual(chamar("DELETE", f"/api/projecao/cenarios/{cid}")[0], 200)
        with app.conectar() as con:
            restantes = [r["cenario_id"] for r in con.execute("SELECT cenario_id FROM projecao_contas")]
        self.assertEqual(restantes, [None])

    def test_duplicar_cenario_copia_contas(self):
        cid = self.novo_cenario("Notebook")
        chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [CONTA, {**CONTA, "descricao": "B"}]})
        _, a = chamar("POST", f"/api/projecao/cenarios/{cid}/duplicar")
        _, b = chamar("POST", f"/api/projecao/cenarios/{cid}/duplicar")
        _, p = chamar("GET", "/api/projecao")
        por_id = {c["id"]: c for c in p["cenarios"]}
        self.assertEqual(por_id[a["id"]]["nome"], "Cópia de Notebook")
        self.assertEqual(por_id[b["id"]]["nome"], "Cópia de Notebook 2")
        self.assertEqual([c["descricao"] for c in por_id[a["id"]]["contas"]], ["Notebook", "B"])
        self.assertEqual(contagem("projecao_contas"), 6)

    def test_renomear_cenario(self):
        cid = self.novo_cenario("Velho")
        self.assertEqual(chamar("PUT", f"/api/projecao/cenarios/{cid}", {"nome": "Novo"})[0], 200)
        _, p = chamar("GET", "/api/projecao")
        self.assertEqual(p["cenarios"][1]["nome"], "Novo")

    def test_editar_e_apagar_conta(self):
        cid = self.novo_cenario()
        _, r = chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [CONTA]})
        conta_id = r["id"][0]
        self.assertEqual(chamar("PUT", f"/api/projecao/contas/{conta_id}", {**CONTA, "valor": 1200, "n_parcelas": 12})[0], 200)
        _, p = chamar("GET", "/api/projecao")
        c = p["cenarios"][1]["contas"][0]
        self.assertEqual((c["total"], c["n_parcelas"]), (1200.0, 12))
        self.assertEqual(chamar("DELETE", f"/api/projecao/contas/{conta_id}")[0], 200)
        self.assertEqual(contagem("projecao_contas"), 0)
        status, r = chamar("PUT", "/api/projecao/contas/999", CONTA)
        self.assertEqual((status, r["erro"]), (400, "Conta não encontrada"))


if __name__ == "__main__":
    unittest.main()
