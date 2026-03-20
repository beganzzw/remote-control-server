// 被控端（Host）处理模块
class HostHandler {
  constructor(io, sessionManager, availableHosts) {
    this.io = io
    this.sessionManager = sessionManager
    this.availableHosts = availableHosts
  }

  registerEvents(socket) {
    socket.on('register-host', (hostInfo) =>
      this.handleRegister(socket, hostInfo)
    )
    socket.on('accept-connection', (data) =>
      this.handleAcceptConnection(socket, data)
    )
    socket.on('reject-connection', (data) =>
      this.handleRejectConnection(socket, data)
    )
    socket.on('disconnect', () => this.handleDisconnect(socket))
    socket.on('connection-lost', (data) =>
      this.handleConnectionLost(socket, data)
    )
  }

  // 处理被控端注册
  handleRegister(socket, hostInfo) {
    try {
      if (!hostInfo?.hostName) {
        return socket.emit('error', { message: '无效的被控端信息（缺少名称）' })
      }

      const hostData = {
        hostId: socket.id,
        hostName: hostInfo.hostName,
        slaveId: hostInfo.slaveId || socket.id,
        capabilities: hostInfo.capabilities || [],
        displayId: hostInfo.displayId || 'default',
        connectionStatus: 'available',
        connectingClientId: null,   // ✅ 修复：必须初始化，否则 accept 校验永远失败
        isAvailable: true,
        registeredAt: new Date(),
      }

      this.availableHosts.set(socket.id, hostData)
      this.broadcastAvailableHosts()

      socket.emit('host-registered', { success: true, hostId: socket.id })
      console.log(`[被控端] 已注册: ${hostData.hostName} (${socket.id})`)
    } catch (error) {
      console.error(`[被控端] 注册失败: ${error.message}`)
      socket.emit('error', { message: `注册失败: ${error.message}` })
    }
  }

  // 处理被控端接受连接
  handleAcceptConnection(socket, data) {
    try {
      const { targetId: clientId, sessionId } = data
      const host = this.availableHosts.get(socket.id)

      if (!host) {
        return socket.emit('error', { message: '被控端未注册' })
      }

      if (host.connectionStatus !== 'connecting') {
        return socket.emit('error', { message: `状态不匹配（当前: ${host.connectionStatus}，期望: connecting）` })
      }

      if (host.connectingClientId !== clientId) {
        return socket.emit('error', { message: '连接请求来源不匹配' })
      }

      // 更新状态为已连接
      host.connectionStatus = 'connected'
      host.connectingClientId = null
      host.isAvailable = false
      this.availableHosts.set(socket.id, host)
      this.broadcastAvailableHosts()

      // 创建会话
      this.sessionManager.createSession(socket.id, sessionId)
      this.sessionManager.bindClientToSession(sessionId, clientId)

      // 通知控制端
      this.io.to(clientId).emit('connection-accepted', {
        hostId: socket.id,
        hostName: host.hostName,
        sessionId,
        slaveId: host.slaveId,
      })

      console.log(`[被控端] ${socket.id} 接受了控制端 ${clientId} 的连接（会话: ${sessionId}）`)
    } catch (error) {
      console.error(`[被控端] 处理接受连接失败: ${error.message}`)
      socket.emit('error', { message: `处理连接失败: ${error.message}` })
    }
  }

  // 处理被控端拒绝连接
  handleRejectConnection(socket, data) {
    try {
      const { targetId: clientId, reason } = data
      const host = this.availableHosts.get(socket.id)

      if (!host || host.connectionStatus !== 'connecting' || host.connectingClientId !== clientId) {
        return socket.emit('error', { message: '无效的连接请求（状态不匹配）' })
      }

      host.connectionStatus = 'available'
      host.connectingClientId = null
      this.availableHosts.set(socket.id, host)
      this.broadcastAvailableHosts()

      this.io.to(clientId).emit('connection-rejected', {
        hostId: socket.id,
        reason,
      })

      console.log(`[被控端] ${socket.id} 拒绝了控制端 ${clientId} 的连接`)
    } catch (error) {
      console.error(`[被控端] 处理拒绝连接失败: ${error.message}`)
    }
  }

  // 处理连接断开通知（来自被控端主动上报）
  handleConnectionLost(socket, data) {
    try {
      const { sessionId, sourceId, targetId } = data
      const host = this.availableHosts.get(socket.id)

      if (!host) return

      console.log(`[被控端] 连接断开通知: ${host.hostName} (${socket.id})，会话: ${sessionId}`)

      host.connectionStatus = 'available'
      host.isAvailable = true
      host.connectingClientId = null
      this.availableHosts.set(socket.id, host)
      this.broadcastAvailableHosts()

      const session = this.sessionManager.getSession(sessionId)
      if (session) {
        this.io.to(targetId).emit('connection-lost', {
          sessionId,
          sourceId,
          reason: '数据通道已关闭',
        })
        this.sessionManager.closeSession(sessionId)
        console.log(`[会话] 已关闭会话 ${sessionId}`)
      }
    } catch (error) {
      console.error(`[被控端] 处理连接断开通知失败: ${error.message}`)
    }
  }

  // 处理被控端断线
  handleDisconnect(socket) {
    const hostId = socket.id
    const host = this.availableHosts.get(hostId)

    if (host) {
      console.log(`[被控端] 已断开: ${host.hostName} (${hostId})`)

      const session = this.sessionManager.getSessionByHost(hostId)
      if (session) {
        this.io.to(session.clientId).emit('session-closed', {
          reason: '被控端已断开连接',
          hostId,
        })
        this.sessionManager.closeSession(session.id)
      }

      this.availableHosts.delete(hostId)
      this.broadcastAvailableHosts()
    }
  }

  // 广播可用被控端列表
  broadcastAvailableHosts() {
    const list = Array.from(this.availableHosts.values()).map((host) => ({
      hostId: host.hostId,
      hostName: host.hostName,
      capabilities: host.capabilities,
      slaveId: host.slaveId,
      connectionStatus: host.connectionStatus,
    }))

    this.io.emit('available-hosts-list', list)
    console.log(`[被控端] 广播可用列表（共 ${list.length} 个）`)
  }
}

module.exports = HostHandler
