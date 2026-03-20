// 服务器配置（可通过环境变量覆盖）
module.exports = {
  PORT: Number(process.env.PORT) || 8080,
  // 证书路径：与宿主机 ./signaling-server/path/to/ 挂载一致
  SSL_KEY_PATH: process.env.SSL_KEY_PATH || './path/to/10.10.10.130-key.pem',
  SSL_CERT_PATH: process.env.SSL_CERT_PATH || './path/to/10.10.10.130.pem',
  CORS_OPTIONS: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  SESSION_STATES: {
    ACTIVE: 'active',
    CLOSED: 'closed',
    PAUSED: 'paused'
  }
}
