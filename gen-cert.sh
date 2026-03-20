#!/bin/bash
# ============================================================
# 生成自签名 SSL 证书（SAN 绑定 10.10.10.130）
# 用法: bash gen-cert.sh
# ============================================================

set -e

CERT_DIR="./signaling-server/path/to"
IP="10.10.10.130"
DAYS=3650

mkdir -p "$CERT_DIR"

echo "[1/2] 生成私钥和证书..."
openssl req -x509 -newkey rsa:4096 -sha256 -days $DAYS -nodes \
  -keyout "$CERT_DIR/${IP}-key.pem" \
  -out    "$CERT_DIR/${IP}.pem" \
  -subj   "/CN=${IP}" \
  -addext "subjectAltName=IP:${IP}"

echo "[2/2] 完成！"
echo ""
echo "证书文件："
echo "  私钥: $CERT_DIR/${IP}-key.pem"
echo "  证书: $CERT_DIR/${IP}.pem"
echo ""
echo "有效期: $DAYS 天"
openssl x509 -in "$CERT_DIR/${IP}.pem" -noout -dates
