const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { PORT, SSL_KEY_PATH, SSL_CERT_PATH, CORS_OPTIONS } = require('./config');
const SessionManager = require('./core/session-manager');
const HostHandler = require('./core/host-handler');
const ClientHandler = require('./core/client-handler');
const SignalingHandler = require('./core/signaling-handler');

// 初始化服务器
const app = express();
app.use(express.json());

const keyPath = path.resolve(__dirname, SSL_KEY_PATH);
const certPath = path.resolve(__dirname, SSL_CERT_PATH);
const tlsReady = fs.existsSync(keyPath) && fs.existsSync(certPath);

// 证书存在则 HTTPS，否则 HTTP
const server = tlsReady
  ? https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      },
      app
    )
  : http.createServer(app);

if (!tlsReady) {
  console.warn(
    `[配置] 未找到 TLS 证书（${keyPath} / ${certPath}），已以 HTTP 启动。` +
      '生产环境请放置证书或设置 SSL_KEY_PATH、SSL_CERT_PATH。'
  );
}

const io = new Server(server, {
  cors: CORS_OPTIONS,
  pingTimeout: 30000
});

// 全局状态管理
const sessionManager = new SessionManager();
const availableHosts = new Map(); // hostId -> hostData

// 初始化处理器
const hostHandler = new HostHandler(io, sessionManager, availableHosts);
const clientHandler = new ClientHandler(io, sessionManager, availableHosts);
const signalingHandler = new SignalingHandler(io, sessionManager);

// 健康检查
app.get('/', (req, res) => {
  res.send('远程控制服务器运行中');
});

// 连接处理
io.on('connection', (socket) => {
  console.log(`[连接] 新客户端接入: ${socket.id}`);

  socket.on('error', (error) => {
    console.error(`[客户端错误] ${socket.id}: ${error.message}`);
  });

  hostHandler.registerEvents(socket);
  clientHandler.registerEvents(socket);
  signalingHandler.registerEvents(socket);
});

// 启动
const scheme = tlsReady ? 'https' : 'http';
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[启动] 服务运行于 ${scheme}://0.0.0.0:${PORT}`);
  console.log(`[启动] TLS 状态: ${tlsReady ? '已启用' : '未启用（HTTP 模式）'}`);
});

// 优雅关闭
const shutdown = () => {
  console.log('正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
