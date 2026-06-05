/**
 * 信令服务地址（Socket.IO）。改此处即可同步默认连接与主进程证书白名单 hostname。
 * signaling-server 默认 HTTPS 8080，见 D:\work\signaling-server\config.js
 */
const SIGNALING_SERVER_URL = "https://10.10.10.130:8080";

/** 卡片展示用系统名称，缺省为 OS 计算机名 */
const SYSTEM_NAME = process.env.SYSTEM_NAME || "";

/** 本机 IP，缺省由 host-network 自动探测 */
const HOST_IP = process.env.HOST_IP || "";

/** 指定网卡名称（如 Ethernet） */
const HOST_IP_INTERFACE_NAME = process.env.HOST_IP_INTERFACE_NAME || "";

/** 开发环境：除 SIGNALING_SERVER_URL 的 hostname 外，仍信任这些主机上的自签证书 */
const EXTRA_DEV_SIGNALING_HOSTS = ["10.10.10.96"];

function getDevAllowInsecureSignalingHosts() {
  const hosts = new Set(EXTRA_DEV_SIGNALING_HOSTS);
  try {
    hosts.add(new URL(SIGNALING_SERVER_URL).hostname);
  } catch (_) {
    // ignore
  }
  return hosts;
}

module.exports = {
  SIGNALING_SERVER_URL,
  SYSTEM_NAME,
  HOST_IP,
  HOST_IP_INTERFACE_NAME,
  EXTRA_DEV_SIGNALING_HOSTS,
  getDevAllowInsecureSignalingHosts,
};
