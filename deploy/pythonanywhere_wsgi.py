# Conteúdo do arquivo WSGI do PythonAnywhere (aba Web -> "WSGI configuration file").
# Apague tudo o que estiver lá, cole isto e troque SEU_USUARIO pelo seu usuário do PythonAnywhere.
import os
import sys

USUARIO = "SEU_USUARIO"

os.environ["CF_DADOS"] = f"/home/{USUARIO}/dados"     # banco e backups ficam fora da pasta do código
os.environ["CF_PUBLICO"] = "1"                         # login obrigatório
sys.path.insert(0, f"/home/{USUARIO}/financial_control")

from app import application  # noqa: E402,F401
