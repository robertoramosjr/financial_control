"""Testa scripts/exportar_dados.py: o SQL gerado, carregado num banco novo com o esquema do D1
(migrations/0001_esquema.sql), tem de reproduzir os dados do banco original, sem usuários nem sessões."""
import hashlib
import importlib.util
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from tests.test_projecoes import BancoTemporario, app
except ImportError:  # rodando com discover -s tests
    from test_projecoes import BancoTemporario, app

RAIZ = Path(__file__).resolve().parent.parent
MIGRACAO = RAIZ / "migrations" / "0001_esquema.sql"
TABELAS = ["categorias", "fontes_renda", "provisoes", "provisao_meses", "recorrencias", "parcelamentos",
           "lancamentos", "pagamentos", "entradas", "projecao_entradas", "cenarios", "projecao_contas",
           "projecao_ajustes"]


def carregar_modulo(nome):
    spec = importlib.util.spec_from_file_location(nome, RAIZ / "scripts" / f"{nome}.py")
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


gerar_golden = carregar_modulo("gerar_golden")      # só para reaproveitar os dados de teste (semear*)
exportar_dados = carregar_modulo("exportar_dados")


def linhas(con, tabela):
    return con.execute(f"SELECT * FROM {tabela} ORDER BY rowid").fetchall()


class TestExportarDados(BancoTemporario):
    def setUp(self):
        super().setUp()
        self.saida = Path(self._tmp.name) / "export.sql"
        with app.conectar() as con:
            gerar_golden.semear(con)
            gerar_golden.semear_projecao(con)
            # dados que tornam o SQL traiçoeiro, e dados que NÃO podem sair
            con.execute("INSERT INTO lancamentos (mes, descricao, data, valor_centavos, categoria_id, pago) "
                        "VALUES ('2026-11', ?, NULL, 1234, 1, 0)", ("Linha 1\nlinha 2 com 'aspas', \"duplas\" e açúcar ✓",))
            con.execute("INSERT INTO usuarios (nome, senha_hash) VALUES ('ana', 'pbkdf2_sha256$600000$aa$bb')")
            con.execute("INSERT INTO sessoes (token_hash, usuario_id, expira) VALUES ('t', 1, '2099-01-01')")
            con.execute("INSERT INTO falhas_login (ip, quando) VALUES ('1.2.3.4', 1.0)")

    def exportar(self):
        return exportar_dados.exportar(app.DB_PATH, self.saida)

    def carregar_no_d1_de_mentira(self):
        """Banco novo só com a migração (que já traz as 9 categorias padrão), como o D1 recém-criado."""
        destino = sqlite3.connect(":memory:")
        destino.executescript(MIGRACAO.read_text(encoding="utf-8"))
        destino.execute("PRAGMA foreign_keys = ON")      # o D1 confere as chaves estrangeiras
        destino.executescript(self.saida.read_text(encoding="utf-8"))
        return destino

    def test_o_sql_reproduz_todas_as_tabelas_linha_a_linha(self):
        contagens = self.exportar()
        destino = self.carregar_no_d1_de_mentira()
        origem = sqlite3.connect(app.DB_PATH)
        for tabela in TABELAS:
            with self.subTest(tabela=tabela):
                self.assertEqual([tuple(l) for l in linhas(destino, tabela)],
                                 [tuple(l) for l in linhas(origem, tabela)])
                self.assertEqual(contagens[tabela], len(linhas(origem, tabela)))
        self.assertGreater(contagens["lancamentos"], 12)

    def test_os_ids_sao_preservados_mesmo_com_categorias_padrao_no_destino(self):
        with app.conectar() as con:
            con.execute("UPDATE categorias SET nome = 'Casa' WHERE id = 1")
        self.exportar()
        destino = self.carregar_no_d1_de_mentira()
        self.assertEqual(destino.execute("SELECT nome FROM categorias WHERE id = 1").fetchone()[0], "Casa")
        self.assertEqual(destino.execute("SELECT COUNT(*) FROM categorias").fetchone()[0], 9)

    def test_nao_exporta_usuarios_sessoes_nem_falhas_de_login(self):
        self.exportar()
        sql = self.saida.read_text(encoding="utf-8")
        for proibido in ("usuarios", "sessoes", "falhas_login", "senha_hash", "pbkdf2", "token_hash", "1.2.3.4"):
            self.assertNotIn(proibido, sql)
        destino = self.carregar_no_d1_de_mentira()
        self.assertEqual(destino.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0], 0)

    def test_so_tem_delete_de_categorias_e_inserts_um_por_linha(self):
        self.exportar()
        linhas_sql = [l for l in self.saida.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("--")]
        self.assertEqual(linhas_sql[0], "DELETE FROM categorias;")
        for l in linhas_sql[1:]:
            self.assertTrue(l.startswith("INSERT INTO "), l)
        for l in linhas_sql:
            self.assertTrue(l.endswith(";"), l)       # nenhuma instrução foi partida por quebra de linha

    def test_nao_altera_o_banco_de_origem(self):
        antes = hashlib.sha256(app.DB_PATH.read_bytes()).hexdigest()
        self.exportar()
        self.assertEqual(hashlib.sha256(app.DB_PATH.read_bytes()).hexdigest(), antes)

    def test_banco_antigo_sem_provisoes_exporta_o_que_tem(self):
        antigo = Path(self._tmp.name) / "antigo.db"
        con = sqlite3.connect(antigo)
        con.executescript("""
            CREATE TABLE categorias (id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE, ordem INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE lancamentos (id INTEGER PRIMARY KEY, mes TEXT NOT NULL, descricao TEXT NOT NULL, data TEXT,
                valor_centavos INTEGER NOT NULL, categoria_id INTEGER NOT NULL REFERENCES categorias(id),
                pago INTEGER NOT NULL DEFAULT 0);
            INSERT INTO categorias VALUES (1, 'Moradia', 0);
            INSERT INTO lancamentos VALUES (1, '2026-01', 'Luz', NULL, 5000, 1, 0);""")
        con.commit()
        con.close()
        contagens = exportar_dados.exportar(antigo, self.saida)
        self.assertEqual(contagens, {"categorias": 1, "lancamentos": 1})
        destino = self.carregar_no_d1_de_mentira()
        self.assertEqual(destino.execute("SELECT descricao, provisao_id FROM lancamentos").fetchall(), [("Luz", None)])

    def test_linha_de_comando(self):
        r = subprocess.run([sys.executable, str(RAIZ / "scripts" / "exportar_dados.py"), "--db", str(app.DB_PATH),
                            "--saida", str(self.saida)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("lancamentos", r.stdout)
        self.assertTrue(self.saida.exists())

    def test_linha_de_comando_com_banco_inexistente_falha_sem_criar_nada(self):
        r = subprocess.run([sys.executable, str(RAIZ / "scripts" / "exportar_dados.py"), "--db", str(Path(self._tmp.name) / "nao.db"),
                            "--saida", str(self.saida)], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.saida.exists())
        self.assertFalse((Path(self._tmp.name) / "nao.db").exists())


if __name__ == "__main__":
    unittest.main()
