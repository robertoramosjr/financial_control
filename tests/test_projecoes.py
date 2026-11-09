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

    def test_conta_com_limites_absurdos_e_recusada_sem_erro_500(self):
        cid = self.novo_cenario()
        ruins = [{"n_parcelas": 601}, {"n_parcelas": 10 ** 30}, {"valor": "inf"}, {"valor": float("inf")},
                 {"valor": 0.01, "n_parcelas": 3}]
        for ruim in ruins:
            status, _ = chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [{**CONTA, **ruim}]})
            self.assertEqual(status, 400, ruim)
        self.assertEqual(contagem("projecao_contas"), 0)
        self.assertEqual(chamar("POST", "/api/projecao/contas", {"cenario_id": cid, "contas": [{**CONTA, "n_parcelas": 600}]})[0], 200)

    def test_entrada_projetada_negativa_e_recusada(self):
        self.assertEqual(chamar("PUT", "/api/projecao/entradas", {"mes": "2026-11", "valor": -5})[0], 400)
        self.assertEqual(chamar("PUT", "/api/projecao/entradas", {"mes": "2026-11", "valor": float("inf")})[0], 400)
        self.assertEqual(contagem("projecao_entradas"), 0)


def ajuste(con, cenario_id, tipo, ref_id, inicio, fim, valor):
    return con.execute("""INSERT INTO projecao_ajustes (cenario_id, tipo, ref_id, mes_inicio, mes_fim, valor_centavos)
                          VALUES (?, ?, ?, ?, ?, ?)""", (cenario_id, tipo, ref_id, inicio, fim, round(valor * 100))).lastrowid


def rec_id(con, valor=3000):
    recorrencia(con, valor)
    return con.execute("SELECT MAX(id) FROM recorrencias").fetchone()[0]


class TestAjustes(BancoTemporario):
    def test_sem_ajustes_nada_muda(self):
        with app.conectar() as con:
            rec_id(con)
            c = app.projecao(con, INICIO)["cenarios"][0]
        self.assertEqual(c["despesas"], c["sem_ajustes"]["despesas"])
        self.assertEqual(c["saldo"], c["sem_ajustes"]["saldo"])
        self.assertEqual(c["base"]["recorrencias"][0], 3000.0)

    def test_ajuste_so_neste_mes(self):
        with app.conectar() as con:
            r = rec_id(con)
            ajuste(con, None, "rec", r, INICIO, INICIO, 2000)
            c = app.projecao(con, INICIO)["cenarios"][0]
        self.assertEqual(c["despesas"][:2], [2000.0, 3000.0])
        self.assertEqual(c["sem_ajustes"]["despesas"][0], 3000.0)
        item = c["itens"][0][0]
        self.assertEqual((item["original"], item["valor"]), (3000.0, 2000.0))
        self.assertEqual(item["ajuste"]["escopo"], "geral")
        self.assertIsNone(c["itens"][1][0]["ajuste"])

    def test_ajuste_em_diante_e_intervalo_pausa(self):
        with app.conectar() as con:
            r = rec_id(con)
            ajuste(con, None, "rec", r, INICIO, None, 2500)
            c = app.projecao(con, INICIO)["cenarios"][0]
            self.assertEqual(c["despesas"], [2500.0] * 12)
            con.execute("DELETE FROM projecao_ajustes")
            ajuste(con, None, "rec", r, INICIO, "2026-12", 0)
            c = app.projecao(con, INICIO)["cenarios"][0]
        self.assertEqual(c["despesas"][:4], [0.0, 0.0, 3000.0, 3000.0])

    def test_ajuste_de_cenario_vale_so_nele(self):
        with app.conectar() as con:
            r = rec_id(con)
            a, b = cenario(con, "A"), cenario(con, "B")
            ajuste(con, a, "rec", r, INICIO, INICIO, 1000)
            cs = {c["nome"]: c for c in app.projecao(con, INICIO)["cenarios"]}
        self.assertEqual(cs["A"]["despesas"][0], 1000.0)
        self.assertEqual(cs["A"]["itens"][0][0]["ajuste"]["escopo"], "cenario")
        self.assertEqual(cs["B"]["despesas"][0], 3000.0)
        self.assertEqual(cs["Sem a compra"]["despesas"][0], 3000.0)

    def test_ajuste_do_cenario_vence_o_geral(self):
        with app.conectar() as con:
            r = rec_id(con)
            a = cenario(con, "A")
            ajuste(con, None, "rec", r, INICIO, INICIO, 2000)
            ajuste(con, a, "rec", r, INICIO, INICIO, 1000)
            cs = {c["nome"]: c for c in app.projecao(con, INICIO)["cenarios"]}
        self.assertEqual(cs["A"]["despesas"][0], 1000.0)
        self.assertEqual(cs["Sem a compra"]["despesas"][0], 2000.0)

    def test_mais_recente_vence_no_mesmo_nivel(self):
        with app.conectar() as con:
            r = rec_id(con)
            ajuste(con, None, "rec", r, INICIO, None, 2000)
            ajuste(con, None, "rec", r, INICIO, INICIO, 500)
            c = app.projecao(con, INICIO)["cenarios"][0]
        self.assertEqual(c["despesas"][:2], [500.0, 2000.0])

    def test_ajuste_em_parcela_e_fora_da_vida(self):
        with app.conectar() as con:
            con.execute("""INSERT INTO parcelamentos (descricao, primeira_parcela, valor_parcela_centavos, n_parcelas, categoria_id)
                           VALUES ('Sofá', ?, 10000, 3, 1)""", (INICIO + "-10",))
            pid = con.execute("SELECT MAX(id) FROM parcelamentos").fetchone()[0]
            ajuste(con, None, "parc", pid, INICIO, "2027-10", 50)
            c = app.projecao(con, INICIO)["cenarios"][0]
        self.assertEqual(c["base"]["parcelas"], [50.0, 50.0, 50.0] + [0.0] * 9)
        self.assertEqual(c["itens"][3], [])
        self.assertEqual(c["itens"][0][0]["parcela"], 1)
        self.assertEqual(c["itens"][0][0]["n_parcelas"], 3)

    def test_ajuste_nao_toca_os_totais_reais(self):
        with app.conectar() as con:
            r = rec_id(con)
            antes = app.visao_mes(con, INICIO)["totais"]
            ajuste(con, None, "rec", r, INICIO, None, 1)
            app.projecao(con, INICIO)
            self.assertEqual(app.visao_mes(con, INICIO)["totais"], antes)
            self.assertEqual(con.execute("SELECT valor_centavos FROM recorrencias").fetchone()[0], 300000)

    def test_sem_ajustes_nunca_inclui_ajuste_nenhum(self):
        with app.conectar() as con:
            r = rec_id(con)
            a = cenario(con, "A")
            ajuste(con, None, "rec", r, INICIO, None, 1)
            ajuste(con, a, "rec", r, INICIO, None, 2)
            cs = app.projecao(con, INICIO)["cenarios"]
        for c in cs:
            self.assertEqual(c["sem_ajustes"]["despesas"], [3000.0] * 12)


class TestAjustesApi(BancoTemporario):
    def setUp(self):
        super().setUp()
        with app.conectar() as con:
            self.rec = rec_id(con)

    def corpo(self, **extra):
        return {"tipo": "rec", "ref_id": self.rec, "valor": "2000", "mes_inicio": INICIO, "mes_fim": None,
                "escopo": "geral", "cenario_id": None, **extra}

    def cenario(self, nome="A"):
        return chamar("POST", "/api/projecao/cenarios", {"nome": nome})[1]["id"]

    def criar(self, **extra):
        status, r = chamar("POST", "/api/projecao/ajustes", self.corpo(**extra))
        self.assertEqual(status, 200, r)
        return r["id"]

    def valores(self, indice=0):
        with app.conectar() as con:
            return app.projecao(con, INICIO)["cenarios"][indice]["despesas"]

    def test_cria_ajuste_geral_e_aparece_na_projecao(self):
        self.criar(mes_fim=INICIO)
        _, p = chamar("GET", "/api/projecao")
        self.assertEqual(p["cenarios"][0]["itens"][0][0]["valor"], 2000.0)

    def test_cria_ajuste_de_cenario(self):
        cid = self.cenario()
        self.criar(escopo="cenario", cenario_id=cid)
        self.assertEqual(self.valores(0)[0], 3000.0)
        self.assertEqual(self.valores(1)[0], 2000.0)

    def test_ajuste_invalido_e_recusado_sem_erro_500(self):
        cid = self.cenario()
        ruins = [{"valor": "-1"}, {"valor": "inf"}, {"valor": "abc"}, {"valor": float("inf")}, {"valor": None},
                 {"mes_inicio": "2027-01", "mes_fim": "2026-12"}, {"mes_inicio": "2026-13"},
                 {"tipo": "avulso"}, {"ref_id": 999}, {"escopo": "cenario"},
                 {"escopo": "cenario", "cenario_id": 999}, {"escopo": "outro"}]
        for ruim in ruins:
            status, _ = chamar("POST", "/api/projecao/ajustes", self.corpo(**ruim))
            self.assertEqual(status, 400, ruim)
        self.assertEqual(contagem("projecao_ajustes"), 0)
        self.assertEqual(chamar("POST", "/api/projecao/ajustes", self.corpo(escopo="cenario", cenario_id=cid))[0], 200)

    def test_valor_zero_cancela(self):
        self.criar(valor="0", mes_fim=INICIO)
        self.assertEqual(self.valores()[:2], [0.0, 3000.0])

    def test_desfazer_mes_no_meio_divide_o_ajuste(self):
        aid = self.criar(mes_fim="2027-03")
        self.assertEqual(chamar("POST", f"/api/projecao/ajustes/{aid}/desfazer-mes", {"mes": "2027-01"})[0], 200)
        self.assertEqual(self.valores()[:6], [2000.0, 2000.0, 3000.0, 2000.0, 2000.0, 3000.0])

    def test_desfazer_mes_na_ponta_encurta(self):
        aid = self.criar(mes_fim="2026-12")
        chamar("POST", f"/api/projecao/ajustes/{aid}/desfazer-mes", {"mes": INICIO})
        self.assertEqual(self.valores()[:3], [3000.0, 2000.0, 3000.0])
        self.assertEqual(contagem("projecao_ajustes"), 1)
        self.assertEqual(chamar("DELETE", f"/api/projecao/ajustes/{aid}")[0], 200)
        aid2 = self.criar(mes_fim="2027-02")
        chamar("POST", f"/api/projecao/ajustes/{aid2}/desfazer-mes", {"mes": "2027-02"})
        self.assertEqual(self.valores()[:4], [2000.0, 2000.0, 2000.0, 3000.0])

    def test_desfazer_mes_unico_apaga(self):
        aid = self.criar(mes_fim=INICIO)
        chamar("POST", f"/api/projecao/ajustes/{aid}/desfazer-mes", {"mes": INICIO})
        self.assertEqual(contagem("projecao_ajustes"), 0)

    def test_desfazer_mes_de_ajuste_sem_fim(self):
        aid = self.criar()
        chamar("POST", f"/api/projecao/ajustes/{aid}/desfazer-mes", {"mes": "2027-01"})
        v = self.valores()
        self.assertEqual((v[0], v[1], v[2], v[3], v[11]), (2000.0, 2000.0, 3000.0, 2000.0, 2000.0))

    def test_desfazer_mes_fora_do_intervalo_ou_inexistente_400(self):
        aid = self.criar(mes_fim="2026-12")
        self.assertEqual(chamar("POST", f"/api/projecao/ajustes/{aid}/desfazer-mes", {"mes": "2027-05"})[0], 400)
        self.assertEqual(chamar("POST", f"/api/projecao/ajustes/{aid}/desfazer-mes", {"mes": "x"})[0], 400)
        self.assertEqual(chamar("POST", "/api/projecao/ajustes/999/desfazer-mes", {"mes": INICIO})[0], 400)
        self.assertEqual(contagem("projecao_ajustes"), 1)

    def test_desfazer_mes_nao_muda_outros_meses_com_ajuste_sobreposto(self):
        a1 = self.criar(valor="2000")                              # em diante, desde INICIO
        self.criar(valor="1000", mes_inicio="2027-03")             # mais recente, em diante desde março
        antes = self.valores()
        self.assertEqual(antes[4:8], [1000.0] * 4)
        chamar("POST", f"/api/projecao/ajustes/{a1}/desfazer-mes", {"mes": "2027-01"})
        depois = self.valores()
        self.assertEqual(depois[2], 3000.0)                        # janeiro voltou ao normal
        self.assertEqual(depois[:2] + depois[3:], antes[:2] + antes[3:])   # nenhum outro mês mudou

    def test_valor_enorme_e_corpo_que_nao_e_objeto_dao_400(self):
        for ruim in ({"valor": "1e17"}, {"valor": "1e300"}, {"valor": 10 ** 20}):
            self.assertEqual(chamar("POST", "/api/projecao/ajustes", self.corpo(**ruim))[0], 400, ruim)
        self.assertEqual(chamar("POST", "/api/projecao/ajustes", [1])[0], 400)
        self.assertEqual(contagem("projecao_ajustes"), 0)

    def test_apagar_ajuste_inteiro(self):
        aid = self.criar()
        self.assertEqual(chamar("DELETE", f"/api/projecao/ajustes/{aid}")[0], 200)
        self.assertEqual(contagem("projecao_ajustes"), 0)

    def test_apagar_recorrencia_real_apaga_ajustes_dela(self):
        self.criar()
        self.assertEqual(chamar("DELETE", f"/api/recorrencias/{self.rec}")[0], 200)
        self.assertEqual(contagem("projecao_ajustes"), 0)
        self.assertEqual(chamar("GET", "/api/projecao")[0], 200)

    def test_apagar_parcelamento_real_apaga_ajustes_dele(self):
        with app.conectar() as con:
            con.execute("""INSERT INTO parcelamentos (descricao, primeira_parcela, valor_parcela_centavos, n_parcelas, categoria_id)
                           VALUES ('Sofá', '2026-11-10', 10000, 3, 1)""")
            pid = con.execute("SELECT MAX(id) FROM parcelamentos").fetchone()[0]
        self.criar(tipo="parc", ref_id=pid)
        self.criar()
        self.assertEqual(chamar("DELETE", f"/api/parcelamentos/{pid}")[0], 200)
        self.assertEqual(contagem("projecao_ajustes"), 1)

    def test_apagar_cenario_apaga_so_ajustes_dele(self):
        cid = self.cenario()
        self.criar(escopo="cenario", cenario_id=cid)
        self.criar()
        self.assertEqual(chamar("DELETE", f"/api/projecao/cenarios/{cid}")[0], 200)
        self.assertEqual(contagem("projecao_ajustes"), 1)

    def test_duplicar_cenario_copia_ajustes_do_cenario_mas_nao_os_gerais(self):
        cid = self.cenario()
        self.criar(escopo="cenario", cenario_id=cid)
        self.criar()
        status, r = chamar("POST", f"/api/projecao/cenarios/{cid}/duplicar")
        self.assertEqual(status, 200)
        with app.conectar() as con:
            n = lambda c: con.execute("SELECT COUNT(*) FROM projecao_ajustes WHERE cenario_id IS ?", (c,)).fetchone()[0]
            self.assertEqual((n(cid), n(r["id"]), n(None)), (1, 1, 1))


if __name__ == "__main__":
    unittest.main()
