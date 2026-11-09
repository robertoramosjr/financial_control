import sqlite3
import unittest

try:
    from tests.test_projecoes import BancoTemporario, chamar, contagem, INICIO, app
except ImportError:  # rodando com discover -s tests
    from test_projecoes import BancoTemporario, chamar, contagem, INICIO, app

HOJE = "2026-11"


def provisao(con, valor, inicio="2026-01", fim=None, categoria_id=1, descricao="Saídas"):
    return con.execute("""INSERT INTO provisoes (descricao, categoria_id, valor_centavos, inicio, fim)
                          VALUES (?, ?, ?, ?, ?)""",
                       (descricao, categoria_id, round(valor * 100), inicio, fim)).lastrowid


def compra(con, mes, valor, provisao_id=None, pago=0, categoria_id=1):
    return con.execute("""INSERT INTO lancamentos (mes, descricao, data, valor_centavos, categoria_id, pago, provisao_id)
                          VALUES (?, 'Jantar', NULL, ?, ?, ?, ?)""",
                       (mes, round(valor * 100), categoria_id, pago, provisao_id)).lastrowid


def valor_mes(con, pid, mes, valor):
    con.execute("INSERT INTO provisao_meses (provisao_id, mes, valor_centavos) VALUES (?, ?, ?)",
                (pid, mes, round(valor * 100)))


class TestProvisoesMes(BancoTemporario):
    def visao(self, mes, hoje=HOJE):
        with app.conectar() as con:
            return app.visao_mes(con, mes, hoje=hoje)

    def test_mes_futuro_sem_compras_conta_o_provisionado(self):
        with app.conectar() as con:
            provisao(con, 600)
        v = self.visao("2026-12")
        self.assertEqual(v["totais"]["provisoes"], 600.0)
        self.assertEqual(v["totais"]["despesas"], 600.0)
        p = v["provisoes"][0]
        self.assertEqual((p["gasto"], p["disponivel"], p["fechado"]), (0.0, 600.0, False))

    def test_mes_atual_mostra_o_disponivel(self):
        with app.conectar() as con:
            pid = provisao(con, 600)
            compra(con, HOJE, 100, pid)
        v = self.visao(HOJE)
        self.assertEqual(v["totais"]["avulsos"], 100.0)
        self.assertEqual(v["avulsos"][0]["provisao"], "Saídas")
        self.assertEqual(v["avulsos"][0]["provisao_id"], pid)
        self.assertEqual(v["totais"]["provisoes"], 500.0)
        self.assertEqual(v["provisoes"][0]["disponivel"], 500.0)
        self.assertEqual(v["totais"]["despesas"], 600.0)

    def test_mes_atual_estourado_conta_o_gasto(self):
        with app.conectar() as con:
            pid = provisao(con, 600)
            compra(con, HOJE, 400, pid)
            compra(con, HOJE, 300, pid)
        v = self.visao(HOJE)
        p = v["provisoes"][0]
        self.assertEqual(v["totais"]["avulsos"], 700.0)
        self.assertEqual((p["valor"], p["disponivel"], p["estouro"]), (0.0, 0.0, 100.0))
        self.assertEqual(v["totais"]["despesas"], 700.0)

    def test_mes_terminado_conta_so_o_gasto(self):
        with app.conectar() as con:
            pid = provisao(con, 600)
            compra(con, "2026-10", 400, pid)
        v = self.visao("2026-10")
        p = v["provisoes"][0]
        self.assertEqual((p["fechado"], p["valor"], p["disponivel"]), (True, 0.0, 200.0))
        self.assertEqual(v["totais"]["despesas"], 400.0)

    def test_mes_terminado_sem_compras_conta_zero(self):
        with app.conectar() as con:
            provisao(con, 600)
        self.assertEqual(self.visao("2026-10")["totais"]["despesas"], 0.0)

    def test_valor_do_mes_vence_o_padrao(self):
        with app.conectar() as con:
            pid = provisao(con, 600)
            valor_mes(con, pid, "2026-12", 1000)
        p = self.visao("2026-12")["provisoes"][0]
        self.assertEqual((p["provisionado"], p["valor_do_mes"]), (1000.0, True))
        p = self.visao("2027-01")["provisoes"][0]
        self.assertEqual((p["provisionado"], p["valor_do_mes"]), (600.0, False))

    def test_valor_do_mes_zero_e_compra_fora_da_vigencia_contam_o_gasto(self):
        with app.conectar() as con:
            pid = provisao(con, 600)
            valor_mes(con, pid, "2026-12", 0)
            compra(con, "2026-12", 80, pid)
            pid2 = provisao(con, 300, fim="2026-11", descricao="Mercado")
            compra(con, "2027-01", 50, pid2)
        v = self.visao("2026-12")
        self.assertEqual((v["totais"]["despesas"], v["totais"]["provisoes"]), (80.0, 0.0))
        v = self.visao("2027-01")
        self.assertEqual([p["descricao"] for p in v["provisoes"]], ["Saídas"])
        self.assertEqual(v["totais"]["despesas"], 650.0)   # 600 de Saídas + 50 da compra de Mercado

    def test_provisao_fora_da_vigencia_nao_aparece(self):
        with app.conectar() as con:
            provisao(con, 600, inicio="2027-01")
        self.assertEqual(self.visao("2026-12")["provisoes"], [])

    def test_por_categoria_e_a_pagar(self):
        with app.conectar() as con:
            pid = provisao(con, 600, categoria_id=6)
            cid = compra(con, HOJE, 150, pid, categoria_id=2)
        v = self.visao(HOJE)
        cats = dict(v["por_categoria"])
        self.assertEqual(cats, {"Alimentação": 150.0, "Lazer": 450.0})
        self.assertEqual(v["totais"]["a_pagar"], 600.0)
        with app.conectar() as con:
            con.execute("UPDATE lancamentos SET pago = 1 WHERE id = ?", (cid,))
        self.assertEqual(self.visao(HOJE)["totais"]["a_pagar"], 450.0)

    def test_resumo_ano_usa_a_regra(self):
        with app.conectar() as con:
            pid = provisao(con, 600, inicio="2099-01")
            valor_mes(con, pid, "2099-12", 1000)
            r = app.resumo_ano(con, 2099)
        self.assertEqual(r["meses"][0]["despesas"], 600.0)
        self.assertEqual(r["meses"][11]["despesas"], 1000.0)

    def test_projecao_inclui_provisoes(self):
        with app.conectar() as con:
            pid = provisao(con, 600)
            compra(con, INICIO, 150, pid)
            p = app.projecao(con, INICIO)
        self.assertEqual(p["base"]["provisoes"][0], 450.0)
        self.assertEqual(p["base"]["provisoes"][1], 600.0)
        self.assertEqual(p["base"]["avulsos"][0], 150.0)
        self.assertEqual(p["cenarios"][0]["despesas"][0], 600.0)
        self.assertEqual(p["cenarios"][0]["sem_ajustes"]["despesas"][0], 600.0)

    def test_migracao_de_banco_antigo(self):
        app.DB_PATH.unlink()
        con = sqlite3.connect(app.DB_PATH)
        con.executescript("""
            CREATE TABLE categorias (id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE, ordem INTEGER NOT NULL DEFAULT 0);
            INSERT INTO categorias (nome) VALUES ('Moradia');
            CREATE TABLE lancamentos (id INTEGER PRIMARY KEY, mes TEXT NOT NULL, descricao TEXT NOT NULL, data TEXT,
                valor_centavos INTEGER NOT NULL, categoria_id INTEGER NOT NULL REFERENCES categorias(id),
                pago INTEGER NOT NULL DEFAULT 0);
            INSERT INTO lancamentos (mes, descricao, valor_centavos, categoria_id) VALUES ('2026-11', 'Antiga', 1234, 1);
        """)
        con.commit()
        con.close()
        app.iniciar_banco()
        app.iniciar_banco()
        with app.conectar() as con:
            colunas = [r["name"] for r in con.execute("PRAGMA table_info(lancamentos)")]
            self.assertIn("provisao_id", colunas)
            v = app.visao_mes(con, "2026-11", hoje=HOJE)
        self.assertEqual(v["avulsos"][0]["provisao_id"], None)
        self.assertEqual(v["totais"]["avulsos"], 12.34)


if __name__ == "__main__":
    unittest.main()
