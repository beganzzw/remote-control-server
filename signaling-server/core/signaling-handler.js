// WebRTC 信令转发模块
class SignalingHandler {
  constructor(io, sessionManager) {
    this.io = io
    this.sessionManager = sessionManager
  }

  registerEvents(socket) {
    socket.on('offer', (data) => this.forwardOffer(socket, data))
    socket.on('answer', (data) => this.forwardAnswer(socket, data))
    socket.on('ice-candidate', (data) => this.forwardIceCandidate(socket, data))
    socket.on('control', (data) => this.forwardControlMessage(socket, data))
  }

  validateSession(senderId, sessionId) {
    const session = this.sessionManager.getSession(sessionId)
    if (!session || !session.isActive()) return false
    return session.hostId === senderId || session.clientId === senderId
  }

  forwardOffer(socket, data) {
    try {
      const { targetId: hostId, offer, sessionId } = data

      if (!this.validateSession(socket.id, sessionId)) {
        return socket.emit('error', { message: '无效的会话或无权限' })
      }

      this.io.to(hostId).emit('offer', {
        sourceId: socket.id,
        offer,
        sessionId,
      })
      console.log(`[信令] 转发 Offer（会话: ${sessionId}）`)
    } catch (error) {
      console.error(`[信令] 转发 Offer 失败: ${error.message}`)
    }
  }

  forwardAnswer(socket, data) {
    try {
      const { targetId: clientId, answer, sessionId } = data

      if (!this.validateSession(socket.id, sessionId)) {
        return socket.emit('error', { message: '无效的会话或无权限' })
      }

      this.io.to(clientId).emit('answer', {
        sourceId: socket.id,
        answer,
        sessionId,
      })
      console.log(`[信令] 转发 Answer（会话: ${sessionId}）`)
    } catch (error) {
      console.error(`[信令] 转发 Answer 失败: ${error.message}`)
    }
  }

  forwardIceCandidate(socket, data) {
    try {
      const { targetId, candidate, sessionId } = data

      if (!this.validateSession(socket.id, sessionId)) {
        return socket.emit('error', { message: '无效的会话或无权限' })
      }

      this.io.to(targetId).emit('ice-candidate', {
        sourceId: socket.id,
        candidate,
        sessionId,
      })
      console.log(`[信令] 转发 ICE 候选者（会话: ${sessionId}）`)
    } catch (error) {
      console.error(`[信令] 转发 ICE 候选者失败: ${error.message}`)
    }
  }

  forwardControlMessage(socket, data) {
    try {
      const { targetId: hostId, message, sessionId } = data

      if (!this.validateSession(socket.id, sessionId)) {
        return socket.emit('error', { message: '无效的会话或无权限' })
      }

      this.io.to(hostId).emit('control-message', {
        sourceId: socket.id,
        message,
        sessionId,
      })
    } catch (error) {
      console.error(`[信令] 转发控制指令失败: ${error.message}`)
    }
  }
}

module.exports = SignalingHandler
