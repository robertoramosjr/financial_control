#!/usr/bin/env bash
# Instala ou atualiza o Controle Financeiro numa VM Debian 12 (Google Cloud).
# Uso, de dentro da pasta descompactada:   sudo bash deploy/instalar.sh [dominio]
# Sem domínio, usa <ip-da-vm>.sslip.io (HTTPS gratuito, sem precisar comprar domínio).
# Rodar de novo atualiza o programa e NUNCA sobrescreve o banco de dados que já está no servidor.
set -euo pipefail

ORIGEM="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/controle-financeiro
DADOS=/var/lib/controle-financeiro
SERVICO=controle-financeiro

[ "$(id -u)" = 0 ] || { echo "Rode com sudo: sudo bash deploy/instalar.sh"; exit 1; }

echo "==> Instalando pacotes"
apt-get update -q
apt-get install -y -q python3 sqlite3 curl
if ! apt-get install -y -q caddy; then
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

echo "==> Copiando o programa"
id financas &>/dev/null || useradd --system --home-dir "$DADOS" --shell /usr/sbin/nologin financas
mkdir -p "$APP" "$DADOS"
rm -rf "$APP/static"
cp -r "$ORIGEM/app.py" "$ORIGEM/static" "$APP/"
if [ ! -f "$DADOS/dados.db" ] && [ -f "$ORIGEM/dados.db" ]; then
  cp "$ORIGEM/dados.db" "$DADOS/dados.db"
  echo "    banco de dados enviado para o servidor"
fi
chown -R financas:financas "$DADOS"
chmod 700 "$DADOS"

como_app() { sudo -u financas env CF_DADOS="$DADOS" python3 "$APP/app.py" "$@"; }
tem_usuario() {
  sudo -u financas env CF_DADOS="$DADOS" python3 -c \
    "import sys; sys.path.insert(0, '$APP'); import app; app.iniciar_banco(); print(app.existe_usuario())"
}
if [ "$(tem_usuario)" != "True" ]; then
  echo
  echo "==> Crie o seu usuário de acesso (a senha não aparece enquanto você digita)"
  read -rp "Nome de usuário: " NOME
  como_app --usuario "$NOME"
fi

echo "==> Configurando o serviço"
cat > /etc/systemd/system/$SERVICO.service <<UNIT
[Unit]
Description=Controle Financeiro
After=network.target

[Service]
User=financas
Environment=CF_DADOS=$DADOS
Environment=CF_PUBLICO=1
ExecStart=/usr/bin/python3 $APP/app.py
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DADOS

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q $SERVICO
systemctl restart $SERVICO

echo "==> Configurando HTTPS"
IP=$(curl -sf -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
DOMINIO="${1:-${IP//./-}.sslip.io}"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMINIO {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:8765
}
CADDY
systemctl enable -q caddy
systemctl reload caddy || systemctl restart caddy

sleep 2
if systemctl is-active -q $SERVICO; then
  echo
  echo "Pronto! Acesse: https://$DOMINIO"
  echo "(o certificado HTTPS pode levar 1 minuto para sair na primeira vez)"
else
  echo "O serviço não subiu. Veja o erro com: sudo journalctl -u $SERVICO -n 30"
  exit 1
fi
