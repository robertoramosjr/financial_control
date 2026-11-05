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


if __name__ == "__main__":
    unittest.main()
