#!/bin/bash
# ============================================================
# 服务健康检查脚本
# 用法: bash verify.sh
# ============================================================

set -e

SIGNAL_HOST="10.10.10.130"
SIGNAL_PORT="8080"
TURN_HOST="10.10.10.130"
TURN_PORT="3478"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }

echo ""
echo "========================================="
echo "  远程控制服务 - 健康检查"
echo "========================================="
echo ""

# ── 1. Docker 容器状态 ──────────────────────────────────────
echo "【1】Docker 容器状态"
for name in coturn signaling; do
  status=$(docker inspect --format='{{.State.Status}}' "$name" 2>/dev/null || echo "not_found")
  if [ "$status" = "running" ]; then
    ok "  $name: running"
  else
    fail "  $name: $status"
  fi
done
echo ""

# ── 2. 信令服务 HTTP/HTTPS 可达性 ───────────────────────────
echo "【2】信令服务可达性（${SIGNAL_HOST}:${SIGNAL_PORT}）"

# 先尝试 HTTPS
RESP=$(curl -sk -o /dev/null -w "%{http_code}" \
  --max-time 5 \
  "https://${SIGNAL_HOST}:${SIGNAL_PORT}/" 2>/dev/null || echo "000")

if [ "$RESP" = "200" ]; then
  ok "  HTTPS 可达（HTTP 200）"
else
  warn "  HTTPS 返回: $RESP，尝试 HTTP..."
  RESP=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 5 \
    "http://${SIGNAL_HOST}:${SIGNAL_PORT}/" 2>/dev/null || echo "000")
  if [ "$RESP" = "200" ]; then
    warn "  HTTP 可达（证书未生效，运行 gen-cert.sh 后重启）"
  else
    fail "  信令服务不可达（HTTP $RESP）"
    echo "      → 检查: docker-compose logs signaling"
  fi
fi
echo ""

# ── 3. 证书检查 ──────────────────────────────────────────────
echo "【3】SSL 证书"
CERT_FILE="signaling-server/path/to/${SIGNAL_HOST}.pem"
KEY_FILE="signaling-server/path/to/${SIGNAL_HOST}-key.pem"

if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  ok "  证书文件存在"
  # 检查证书有效期
  EXPIRY=$(openssl x509 -in "$CERT_FILE" -noout -enddate 2>/dev/null \
    | cut -d= -f2 || echo "无法解析")
  ok "  有效期至: $EXPIRY"
  # 检查 SAN
  SAN=$(openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName 2>/dev/null \
    | grep -o "IP:.*" || echo "未找到 SAN")
  ok "  SAN: $SAN"
else
  fail "  证书文件不存在，请运行: bash gen-cert.sh"
fi
echo ""

# ── 4. TURN 端口监听 ─────────────────────────────────────────
echo "【4】TURN 服务端口（${TURN_HOST}:${TURN_PORT}）"
if command -v nc &>/dev/null; then
  if nc -z -w3 "$TURN_HOST" "$TURN_PORT" 2>/dev/null; then
    ok "  TCP ${TURN_PORT} 可达"
  else
    fail "  TCP ${TURN_PORT} 不可达"
    echo "      → 检查: docker-compose logs coturn"
  fi
else
  warn "  nc 未安装，跳过 TCP 端口检查"
fi

# 检查 Relay 端口范围是否映射
RELAY_MAPPED=$(docker port coturn 2>/dev/null | grep "50000" | head -1 || echo "")
if [ -n "$RELAY_MAPPED" ]; then
  ok "  Relay 端口范围 50000-50100 已映射"
else
  fail "  Relay 端口范围未映射，媒体流中继将失败"
fi
echo ""

# ── 5. turnutils 连通性测试（可选）──────────────────────────
echo "【5】TURN 认证测试"
if command -v turnutils_uclient &>/dev/null; then
  TURN_OUT=$(turnutils_uclient -u user -w password \
    -p "$TURN_PORT" "$TURN_HOST" 2>&1 | tail -3 || echo "failed")
  if echo "$TURN_OUT" | grep -qi "success\|allocated"; then
    ok "  TURN 认证成功"
  else
    fail "  TURN 认证失败（用户名/密码或网络问题）"
    echo "      $TURN_OUT"
  fi
else
  warn "  turnutils_uclient 未安装，跳过 TURN 认证测试"
  echo "      安装: sudo apt-get install coturn"
  echo "      或用浏览器测试: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
fi
echo ""

echo "========================================="
echo "  检查完成"
echo "========================================="
echo ""
echo "日志查看："
echo "  docker-compose logs -f signaling"
echo "  docker-compose logs -f coturn"
echo "  tail -f coturn/log/turnserver.log"
echo ""
