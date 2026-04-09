#!/bin/bash
# coturn TURN server setup for The Manifest
# Run on Ubuntu VPS: sudo bash turn-setup.sh

set -e

# Auto-detect public IP
PUBLIC_IP=$(curl -s https://api.ipify.org)
if [ -z "$PUBLIC_IP" ]; then
  echo "Could not detect public IP. Enter it manually:"
  read -r PUBLIC_IP
fi

TURN_USER="manifest"
TURN_PASS="$(openssl rand -base64 18)"
TURN_PORT=3478

echo "==> Detected IP: ${PUBLIC_IP}"
echo "==> Installing coturn..."
apt update && apt install -y coturn

echo "==> Enabling coturn service..."
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "==> Writing turnserver.conf..."
cat > /etc/turnserver.conf << CONF
listening-port=${TURN_PORT}
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=0.0.0.0
external-ip=${PUBLIC_IP}
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
realm=manifest.relay
fingerprint
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
log-file=/var/log/turnserver.log
simple-log
total-quota=100
stale-nonce=600
max-bps=25000000
CONF

touch /var/log/turnserver.log && chown turnserver:turnserver /var/log/turnserver.log

echo "==> Configuring firewall (ufw)..."
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow 49152:65535/udp

echo "==> Starting coturn..."
systemctl restart coturn
systemctl enable coturn

echo ""
echo "=========================================="
echo "  TURN server is running!"
echo "=========================================="
echo ""
echo "  Add these to your .env or Vercel:"
echo ""
echo "  VITE_TURN_URL=${PUBLIC_IP}"
echo "  VITE_TURN_USER=${TURN_USER}"
echo "  VITE_TURN_PASS=${TURN_PASS}"
echo ""
echo "=========================================="
