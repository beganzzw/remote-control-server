/**
 * 被控端本机 IP 探测（局域网展示用）
 */
const os = require('os');

const VIRTUAL_NAME_RE =
  /virtual|vmware|hyper-v|vethernet|docker|vbox|loopback|tunnel|tun|tap|vpn|wsl|npcap|bluetooth/i;

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function scoreInterface(name, family) {
  if (family !== 'IPv4') return -1;
  if (VIRTUAL_NAME_RE.test(name)) return 0;
  if (name.toLowerCase().startsWith('eth') || name.toLowerCase().startsWith('en')) {
    return 3;
  }
  return 2;
}

/**
 * @param {{ hostIp?: string, interfaceName?: string }} options
 * @returns {string|undefined}
 */
function resolveHostIp(options = {}) {
  const configured = (options.hostIp || process.env.HOST_IP || '').trim();
  if (configured) return configured;

  const ifaceName = (
    options.interfaceName ||
    process.env.HOST_IP_INTERFACE_NAME ||
    ''
  ).trim();

  const interfaces = os.networkInterfaces();
  const candidates = [];

  Object.keys(interfaces).forEach((name) => {
    if (ifaceName && name !== ifaceName) return;
    const addrs = interfaces[name] || [];
    addrs.forEach((addr) => {
      if (addr.internal || addr.family !== 'IPv4') return;
      if (!isPrivateIpv4(addr.address)) return;
      candidates.push({
        name,
        address: addr.address,
        score: scoreInterface(name, addr.family),
      });
    });
  });

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].address;
}

module.exports = { resolveHostIp, isPrivateIpv4 };
