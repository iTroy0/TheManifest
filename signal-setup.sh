#!/bin/bash
# PeerJS signaling server setup for The Manifest
# Run on Ubuntu VPS: sudo bash signal-setup.sh
# Prerequisites: domain pointed to this server's IP

set -e

DOMAIN="signal.manifest-portal.com"
SIGNAL_PORT=9000

echo "==> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "==> Installing PeerJS server..."
npm install -g peer

echo "==> Installing nginx + certbot..."
apt install -y nginx certbot python3-certbot-nginx

echo "==> Configuring nginx reverse proxy..."
cat > /etc/nginx/sites-available/peerjs << CONF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${SIGNAL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
CONF

ln -sf /etc/nginx/sites-available/peerjs /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo "==> Getting SSL certificate..."
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos --register-unsafely-without-email

echo "==> Creating PeerJS systemd service..."
cat > /etc/systemd/system/peerjs.service << CONF
[Unit]
Description=PeerJS Signaling Server
After=network.target

[Service]
Type=simple
ExecStart=$(which peerjs) --port ${SIGNAL_PORT} --path /signal --proxied true
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
CONF

echo "==> Starting PeerJS server..."
systemctl daemon-reload
systemctl enable peerjs
systemctl start peerjs

echo "==> Configuring firewall..."
ufw allow 80/tcp
ufw allow 443/tcp

echo ""
echo "=========================================="
echo "  PeerJS signaling server is running!"
echo "=========================================="
echo ""
echo "  URL: https://${DOMAIN}/signal"
echo ""
echo "  Add to your .env or Vercel:"
echo ""
echo "  VITE_SIGNAL_HOST=${DOMAIN}"
echo "  VITE_SIGNAL_PATH=/signal"
echo ""
echo "=========================================="
