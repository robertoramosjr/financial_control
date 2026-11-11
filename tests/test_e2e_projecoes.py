"""Roda tests/e2e_projecoes.cjs: sobe o app com banco temporário e dirige a aba Projeções num Chrome headless.
Pulado quando node ou google-chrome não estão instalados. Nunca toca o dados.db real.

Por padrão testa o servidor Python (app.py). Com CF_ALVO=worker testa o Worker da Cloudflare, rodando local
(`wrangler dev --local`, com um D1 temporário e um usuário de teste)."""
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SENHA_E2E = "senha-e2e-12345"


def porta_livre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def esperar_porta(porta, tentativas):
    for _ in range(tentativas):
        try:
            socket.create_connection(("127.0.0.1", porta), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def subir_python(tmp, porta, env):
    srv = subprocess.Popen([sys.executable, str(RAIZ / "app.py"), "--porta", str(porta), "--sem-navegador"],
                           env={**env, "CF_DADOS": tmp}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv.grupo_proprio = False
    return srv


def subir_worker(tmp, porta, env):
    """D1 local temporário com o esquema e o usuário "ana"; devolve o processo do wrangler dev."""
    env = {**env, "CI": "1", "WRANGLER_SEND_METRICS": "false"}
    estado = os.path.join(tmp, "estado")
    wrangler = ["npx", "wrangler"]
    subprocess.run([*wrangler, "d1", "migrations", "apply", "controle-financeiro", "--local", "--persist-to", estado],
                   cwd=RAIZ, env=env, check=True, capture_output=True, timeout=120)
    sql = subprocess.run(["node", str(RAIZ / "scripts" / "criar-usuario.mjs"), "ana"], input=f"{SENHA_E2E}\n{SENHA_E2E}\n",
                         capture_output=True, text=True, check=True).stdout
    arquivo = os.path.join(tmp, "usuario.sql")
    Path(arquivo).write_text(sql)
    subprocess.run([*wrangler, "d1", "execute", "controle-financeiro", "--local", "--persist-to", estado, "--file", arquivo],
                   cwd=RAIZ, env=env, check=True, capture_output=True, timeout=120)
    srv = subprocess.Popen([*wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", str(porta), "--persist-to", estado],
                           cwd=RAIZ, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    srv.grupo_proprio = True
    return srv


def parar(srv):
    """O wrangler roda em grupo de processos próprio (o npx cria filhos); o app.py é um processo só."""
    try:
        if srv.grupo_proprio:
            os.killpg(srv.pid, signal.SIGTERM)
        else:
            srv.terminate()
    except ProcessLookupError:
        pass
    srv.wait()


@unittest.skipUnless(shutil.which("node") and shutil.which("google-chrome"), "precisa de node e google-chrome")
class TestE2EProjecoes(unittest.TestCase):
    def test_aba_projecoes_no_navegador(self):
        worker = os.environ.get("CF_ALVO") == "worker"
        with tempfile.TemporaryDirectory() as tmp:
            porta, cdp = porta_livre(), porta_livre()
            env = {**os.environ, "CDP_PORT": str(cdp)}
            if worker:
                env["CF_SENHA"] = SENHA_E2E
            srv = (subir_worker if worker else subir_python)(tmp, porta, env)
            perfil = os.path.join(tmp, "perfil")
            try:
                self.assertTrue(esperar_porta(porta, 600 if worker else 50), "o servidor não subiu")
                r = subprocess.run(["node", str(RAIZ / "tests" / "e2e_projecoes.cjs"), str(porta), perfil, "completa"],
                                   env=env, capture_output=True, text=True, timeout=240)
            finally:
                parar(srv)
                subprocess.run(["pkill", "-f", f"user-data-dir={perfil}"], check=False)
            if os.environ.get("E2E_VERBOSE"):
                print(r.stdout)
            falhas = [l for l in r.stdout.splitlines() if l.startswith("FAIL")]
            self.assertEqual(r.returncode, 0, "\n".join(falhas) or (r.stdout + r.stderr)[-2000:])


if __name__ == "__main__":
    unittest.main()
