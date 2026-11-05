"""Roda tests/e2e_projecoes.js: sobe o app com banco temporário e dirige a aba Projeções num Chrome headless.
Pulado quando node ou google-chrome não estão instalados. Nunca toca o dados.db real."""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def porta_livre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(shutil.which("node") and shutil.which("google-chrome"), "precisa de node e google-chrome")
class TestE2EProjecoes(unittest.TestCase):
    def test_aba_projecoes_no_navegador(self):
        with tempfile.TemporaryDirectory() as tmp:
            porta, cdp = porta_livre(), porta_livre()
            env = {**os.environ, "CF_DADOS": tmp, "CDP_PORT": str(cdp)}
            srv = subprocess.Popen([sys.executable, str(RAIZ / "app.py"), "--porta", str(porta), "--sem-navegador"],
                                   env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            perfil = os.path.join(tmp, "perfil")
            try:
                for _ in range(50):
                    try:
                        socket.create_connection(("127.0.0.1", porta), 0.2).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                r = subprocess.run(["node", str(RAIZ / "tests" / "e2e_projecoes.js"), str(porta), perfil, "completa"],
                                   env=env, capture_output=True, text=True, timeout=180)
            finally:
                srv.terminate()
                srv.wait()
                subprocess.run(["pkill", "-f", f"user-data-dir={perfil}"], check=False)
            falhas = [l for l in r.stdout.splitlines() if l.startswith("FAIL")]
            self.assertEqual(r.returncode, 0, "\n".join(falhas) or (r.stdout + r.stderr)[-2000:])


if __name__ == "__main__":
    unittest.main()
