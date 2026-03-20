// 会话管理核心（独立模块，不依赖具体角色）
const { SESSION_STATES } = require('../config')

class Session {
  constructor(id, hostId) {
    this.id = id
    this.hostId = hostId
    this.clientId = null
    this.state = SESSION_STATES.ACTIVE
    this.createdAt = new Date()
    this.updatedAt = new Date()
  }

  setClient(clientId) {
    this.clientId = clientId
    this.updatedAt = new Date()
  }

  close() {
    this.state = SESSION_STATES.CLOSED
    this.updatedAt = new Date()
  }

  isActive() {
    return this.state === SESSION_STATES.ACTIVE
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map()       // sessionId -> Session
    this.clientSessions = new Map() // clientId  -> sessionId
    this.hostSessions = new Map()   // hostId    -> sessionId
  }

  createSession(hostId, sessionId) {
    if (this.sessions.has(sessionId)) {
      throw new Error(`会话ID已存在: ${sessionId}`)
    }
    const session = new Session(sessionId, hostId)
    this.sessions.set(sessionId, session)
    this.hostSessions.set(hostId, sessionId)
    return session
  }

  bindClientToSession(sessionId, clientId) {
    const session = this.sessions.get(sessionId)
    if (!session || !session.isActive()) {
      throw new Error(`会话不存在或已关闭: ${sessionId}`)
    }
    session.setClient(clientId)
    this.clientSessions.set(clientId, sessionId)
    return session
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId)
  }

  getSessionByClient(clientId) {
    const sessionId = this.clientSessions.get(clientId)
    return sessionId ? this.sessions.get(sessionId) : null
  }

  getSessionByHost(hostId) {
    const sessionId = this.hostSessions.get(hostId)
    return sessionId ? this.sessions.get(sessionId) : null
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.close()
    this.sessions.delete(sessionId)
    if (session.clientId) this.clientSessions.delete(session.clientId)
    this.hostSessions.delete(session.hostId)
  }

  closeClientSession(clientId) {
    const sessionId = this.clientSessions.get(clientId)
    if (sessionId) this.closeSession(sessionId)
  }

  closeHostSession(hostId) {
    const sessionId = this.hostSessions.get(hostId)
    if (sessionId) this.closeSession(sessionId)
  }
}

module.exports = SessionManager
