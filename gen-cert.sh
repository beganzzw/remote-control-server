#!/bin/bash
# ============================================================
# 生成自签名 SSL 证书（SAN 绑定 IP，默认 10.10.10.130）
# 用法: bash gen-cert.sh
# 说明: 用配置文件写 CN/SAN，避免 Git Bash 把 -subj "/CN=..." 误当成路径
#       （否则会变成 D:/soft/Git/CN=... 并报 req: subject name is expected...）
# ============================================================

set -e

CERT_DIR="./signaling-server/path/to"
IP="10.10.10.130"
DAYS=3650

mkdir -p "$CERT_DIR"

CONF=$(mktemp)
trap 'rm -f "$CONF"' EXIT

cat > "$CONF" <<EOF
[req]
distinguished_name = req_dn
x509_extensions = v3_req
prompt = no

[req_dn]
CN = ${IP}

[v3_req]
subjectAltName = IP:${IP}
keyUsage = digitalSignature, keyEncipherment
EOF

echo "[1/2] 生成私钥和证书..."
openssl req -x509 -newkey rsa:4096 -sha256 -days "$DAYS" -nodes \
  -keyout "$CERT_DIR/${IP}-key.pem" \
  -out    "$CERT_DIR/${IP}.pem" \
  -config "$CONF" \
  -extensions v3_req

echo "[2/2] 完成！"
echo ""
echo "证书文件："
echo "  私钥: $CERT_DIR/${IP}-key.pem"
echo "  证书: $CERT_DIR/${IP}.pem"
echo ""
echo "有效期: $DAYS 天"
openssl x509 -in "$CERT_DIR/${IP}.pem" -noout -dates
