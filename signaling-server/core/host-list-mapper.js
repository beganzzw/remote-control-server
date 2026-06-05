/**
 * 将内存中的 hostData 映射为控制端列表项（方案 B：全量在线主机）
 */
function mapHostListItem(host) {
  const registeredAt =
    host.registeredAt instanceof Date
      ? host.registeredAt.toISOString()
      : host.registeredAt
  const lastSeenAt =
    host.lastSeenAt instanceof Date
      ? host.lastSeenAt.toISOString()
      : host.lastSeenAt

  return {
    hostId: host.hostId,
    systemName: host.systemName || host.hostName,
    hostName: host.hostName,
    hostIp: host.hostIp || undefined,
    capabilities: host.capabilities || [],
    slaveId: host.slaveId,
    registeredAt,
    lastSeenAt,
    connectionStatus: host.connectionStatus || 'available',
    isAvailable: Boolean(host.isAvailable),
  }
}

function mapAllHostsList(availableHostsMap) {
  return Array.from(availableHostsMap.values()).map(mapHostListItem)
}

module.exports = { mapHostListItem, mapAllHostsList }
