// 控制端（Client）处理模块
const { v4: uuidv4 } = require('uuid')

class ClientHandler {
  constructor(io, sessionManager, availableHosts) {
    this.io = io
    this.sessionManager = sessionManager
    this.availableHosts = availableHosts
  }

  registerEvents(socket) {
    socket.on('request-available-hosts', () =>
      this.sendAvailableHosts(socket)
    )
    socket.on('connect-to-host', (hostId) =>
      this.requestConnectHost(socket, hostId)
    )
    socket.on('disconnect-from-host', () =>
      this.disconnectFromHost(socket)
    )
    socket.on('disconnect', () => this.handleDisconnect(socket))
  }

  // 向控制端发送可用被控端列表
  sendAvailableHosts(socket) {
    const availableList = Array.from(this.availableHosts.values())
      .filter((host) => host.isAvailable)
      .map((host) => ({
        hostId: host.hostId,
        hostName: host.hostName,
        capabilities: host.capabilities,
        slaveId: host.slaveId,
      }))

    socket.emit('available-hosts-list', availableList)
    console.log(`[控制端] 向 ${socket.id} 发送可用被控端列表（共 ${availableList.length} 个）`)
  }

  // 处理控制端连接被控端请求
  requestConnectHost(socket, hostId) {
    try {
      const host = this.availableHosts.get(hostId)
      if (!host || host.connectionStatus !== 'available') {
        return socket.emit('error', {
          message: `被控端不可用（当前状态：${host?.connectionStatus || '未注册'}）`,
        })
      }

      // 标记为连接中
      host.connectionStatus = 'connecting'
      host.connectingClientId = socket.id
      this.availableHosts.set(hostId, host)
      this.broadcastAvailableHosts()

      // 生成会话 ID 并通知被控端
      const sessionId = uuidv4()
      this.io.to(hostId).emit('connection-request', {
        requesterId: socket.id,
        sessionId,
        clientInfo: { clientId: socket.id },
      })

      console.log(`[控制端] ${socket.id} 请求连接被控端 ${hostId}（sessionId: ${sessionId}）`)

      // 10 秒超时未响应则重置
      const timeoutTimer = setTimeout(() => {
        const currentHost = this.availableHosts.get(hostId)
        if (
          currentHost &&
          currentHost.connectionStatus === 'connecting' &&
          currentHost.connectingClientId === socket.id
        ) {
          currentHost.connectionStatus = 'available'
          currentHost.connectingClientId = null
          this.availableHosts.set(hostId, currentHost)
          this.broadcastAvailableHosts()
          socket.emit('error', { message: '连接超时，被控端未响应' })
          console.log(`[控制端] 连接 ${hostId} 超时（10秒）`)
        }
      }, 10000)

      socket._connectTimeoutTimers = socket._connectTimeoutTimers || new Map()
      // 清理旧的同目标计时器
      const oldTimer = socket._connectTimeoutTimers.get(hostId)
      if (oldTimer) clearTimeout(oldTimer)
      socket._connectTimeoutTimers.set(hostId, timeoutTimer)
    } catch (error) {
      console.error(`[控制端] 连接请求失败: ${error.message}`)
      socket.emit('error', { message: `连接请求失败: ${error.message}` })
    }
  }

  // 处理控制端主动断开
  disconnectFromHost(socket) {
    try {
      const session = this.sessionManager.getSessionByClient(socket.id)
      if (!session) return

      const { hostId } = session
      const host = this.availableHosts.get(hostId)

      if (host) {
        host.connectionStatus = 'available'
        host.connectingClientId = null
        host.isAvailable = true
        this.availableHosts.set(hostId, host)
        this.broadcastAvailableHosts()
      }

      this.io.to(hostId).emit('client-disconnected', {
        clientId: socket.id,
        sessionId: session.id,
      })

      this.sessionManager.closeSession(session.id)
      console.log(`[控制端] ${socket.id} 已主动断开与被控端 ${hostId} 的连接`)
    } catch (error) {
      console.error(`[控制端] 断开连接失败: ${error.message}`)
    }
  }

  // 处理控制端掉线
  handleDisconnect(socket) {
    try {
      // 清理所有超时计时器
      if (socket._connectTimeoutTimers) {
        socket._connectTimeoutTimers.forEach((timer) => clearTimeout(timer))
        socket._connectTimeoutTimers.clear()
      }

      const session = this.sessionManager.getSessionByClient(socket.id)
      if (!session) return

      this.io.to(session.hostId).emit('client-offline', {
        clientId: socket.id,
        sessionId: session.id,
      })

      this.sessionManager.closeSession(session.id)

      const host = this.availableHosts.get(session.hostId)
      if (host) {
        host.connectionStatus = 'available'
        host.connectingClientId = null
        host.isAvailable = true
        this.availableHosts.set(session.hostId, host)
        this.broadcastAvailableHosts()
      }

      console.log(`[控制端] ${socket.id} 已离线（会话: ${session.id}）`)
    } catch (error) {
      console.error(`[控制端] 处理离线失败: ${error.message}`)
    }
  }

  // 广播可用被控端列表
  broadcastAvailableHosts() {
    const list = Array.from(this.availableHosts.values())
      .filter((host) => host.isAvailable)
      .map((host) => ({
        hostId: host.hostId,
        hostName: host.hostName,
        capabilities: host.capabilities,
        slaveId: host.slaveId,
      }))

    this.io.emit('available-hosts-list', list)
  }
}

module.exports = ClientHandler
