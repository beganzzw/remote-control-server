# WebRTC 信令服务器 - Claude Code 协作指南

> 本文件为 Claude Code AI 助手提供项目规范和工作流程指导

## 项目概述

这是一个基于 Node.js 和 Socket.io 的 WebRTC 信令服务器，用于建立和管理实时音视频通信会话。服务器实现了 WebRTC 通信所需的信令交换机制，支持多客户端连接管理、会话状态跟踪和安全的 HTTPS 通信。

**主要应用场景**：
- 实时音视频会议
- 远程控制系统
- P2P 数据传输

## 技术栈

- **运行时**：Node.js v18.12+
- **核心框架**：Express.js v5+, Socket.io v4+
- **包管理器**：pnpm（必须使用 pnpm，不要使用 npm 或 yarn）
- **容器化**：Docker + Docker Compose
- **安全协议**：HTTPS (TLS/SSL)
- **模块系统**：CommonJS (使用 `require`/`module.exports`)

## 项目架构

### 目录结构

```
remote-control/
├── docker-compose.yml             # 统一编排（coturn + signaling）
├── gen-cert.sh                    # 自签证书生成脚本
├── verify.sh                      # 服务健康检查脚本
├── signaling-config.js            # Electron 端信令地址配置
├── electron-main-patch.js         # Electron 主进程自签证书信任补丁
├── .gitignore
├── coturn/
│   ├── config/turnserver.conf     # Coturn 配置
│   ├── turndb/                    # 数据库（运行时自动创建）
│   ├── log/                       # 日志（运行时自动创建）
│   └── run/                       # PID 文件（运行时自动创建）
└── signaling-server/
    ├── Dockerfile
    ├── package.json
    ├── server.js                  # 应用入口
    ├── config.js                  # 服务器配置
    ├── core/
    │   ├── host-handler.js        # 被控端事件处理
    │   ├── client-handler.js      # 控制端事件处理
    │   ├── session-manager.js     # 会话生命周期管理
    │   └── signaling-handler.js   # WebRTC 信令转发
    └── path/to/                   # SSL 证书（由 gen-cert.sh 生成，不提交 git）
        ├── 10.10.10.130.pem
        └── 10.10.10.130-key.pem
```

### 核心模块说明

1. **SessionManager** (`core/session-manager.js`)
   - 管理所有活动会话的生命周期
   - 维护控制端与被控端的映射关系
   - 会话状态：active, closed, paused

2. **HostHandler** (`core/host-handler.js`)
   - 处理被控端注册、注销
   - 管理被控端连接状态（available / connecting / connected）
   - 处理连接请求的接受/拒绝
   - ⚠️ 注意：`hostData` 必须包含 `connectingClientId: null` 初始字段，否则 `accept-connection` 校验永远失败

3. **ClientHandler** (`core/client-handler.js`)
   - 处理控制端连接请求
   - 提供可用被控端列表查询
   - 管理 10 秒连接超时（注意每次请求前清理旧计时器）

4. **SignalingHandler** (`core/signaling-handler.js`)
   - 转发 WebRTC offer/answer/ice-candidate
   - 转发控制指令
   - 所有转发前必须通过 `validateSession` 验证会话合法性

## 开发工作流

### 启动开发环境

```bash
# 1. 生成 SSL 证书（首次部署必须执行）
bash gen-cert.sh

# 2. 创建运行时目录
mkdir -p coturn/turndb coturn/log coturn/run

# 3. 启动所有服务
docker-compose up -d --build

# 4. 验证服务
bash verify.sh
```

### 配置管理

修改 `config.js` 时注意：
- `PORT`：默认 8080，可通过环境变量覆盖
- `SSL_KEY_PATH` / `SSL_CERT_PATH`：证书路径必须与 `gen-cert.sh` 生成的文件名一致
- `CORS_OPTIONS`：生产环境应限制 `origin`，不要使用 `'*'`
- `SESSION_STATES`：不要修改现有状态值，添加新状态需同步更新所有引用

## 重要注意事项

### ⚠️ 证书生成方式（常见误区）

**coturn 配置文件不是 Shell 脚本**，不会展开 `$()` 语法。  
如需生成随机密码，必须在宿主机 Shell 中执行，再将结果写入配置文件：

```bash
# ✅ 正确：先在 Shell 里生成，再写入配置
CLI_PWD=$(openssl rand -hex 16)
echo "cli-password=${CLI_PWD}" >> coturn/config/turnserver.conf

# ❌ 错误：直接写入配置文件（会被当作字面字符串）
# cli-password=$(openssl rand -hex 16)
```

### ⚠️ Docker 日志

`coturn` 配置**不含** `no-stdout-log`，日志同时输出到文件和 stdout，`docker-compose logs` 可正常使用。

### ⚠️ 证书 IP 必须与服务器 IP 一致

SSL 证书的 CN 和 SAN 必须与信令服务器实际 IP 一致，否则客户端连接会报证书错误。  
`gen-cert.sh` 已将 IP 固定为 `10.10.10.130`，如 IP 变更需重新生成。

### ⚠️ error 事件格式

所有 handler 的 `socket.emit('error', ...)` 必须使用对象格式：

```javascript
// ✅ 正确
socket.emit('error', { message: '错误描述' })

// ❌ 错误（字符串格式，部分客户端无法正确解析）
socket.emit('error', '错误描述')
```

## 代码规范

### 通用规范

- **语言特性**：使用 ES6+ 语法，但保持 CommonJS 模块系统
- **缩进**：2 空格缩进
- **命名约定**：
  - 变量/函数：camelCase
  - 类：PascalCase
  - 常量：UPPER_SNAKE_CASE
  - 文件：kebab-case.js
- **注释**：使用中文注释，重要逻辑必须添加说明

### Socket.io 事件规范

- 事件名使用 kebab-case（如 `register-host`, `ice-candidate`）
- 所有事件必须包含错误处理
- 错误响应统一格式：`{ message: string }`
- 日志格式：`[类型] 详细信息`

### 错误处理

```javascript
socket.on('event-name', (data) => {
  try {
    if (!data.requiredField) {
      socket.emit('error', { message: '缺少必要参数' })
      return
    }
    // 业务逻辑
  } catch (error) {
    console.error(`[错误] 事件处理失败:`, error)
    socket.emit('error', { message: error.message })
  }
})
```

### 日志规范

- 连接事件：`[连接]`
- 断开事件：`[断开]`
- 错误信息：`[错误]`
- 会话操作：`[会话]`
- 信令转发：`[信令]`
- 被控端操作：`[被控端]`
- 控制端操作：`[控制端]`

## 安全规范

### 证书管理

- **证书文件不提交 git**（已在 `.gitignore` 中排除）
- **开发/内网环境**：使用 `gen-cert.sh` 生成自签证书
- **生产环境**：使用 Let's Encrypt 或商业证书，移除 Electron 端的 `certificate-error` 绕过代码
- Electron 端的 `certificate-error` 处理仅限内网 IP，不可扩大到 `*`

### CORS 配置

- 开发环境可使用 `origin: '*'`
- 生产环境必须明确指定允许的域名列表

### 输入验证

- 所有来自客户端的数据必须验证
- 验证 `targetId`、`sessionId` 等关键参数的存在性
- 信令转发前必须通过 `validateSession` 校验

## 部署说明

### Docker 部署（推荐）

```bash
# 首次部署
bash gen-cert.sh
mkdir -p coturn/turndb coturn/log coturn/run
docker-compose up -d --build

# 验证
bash verify.sh

# 日常运维
docker-compose logs -f signaling     # 查看信令日志
docker-compose logs -f coturn        # 查看 TURN 日志
docker-compose restart signaling     # 重启信令服务
docker-compose down                  # 停止所有服务
```

### 生产环境检查清单

- [ ] 运行 `gen-cert.sh` 生成证书（或替换为正式证书）
- [ ] 修改 coturn `user=` 为强密码
- [ ] 配置正确的 `external-ip`
- [ ] 限制 CORS `origin` 为具体域名
- [ ] 移除 Electron 主进程中的 `certificate-error` 绕过（使用正式证书后）
- [ ] 配置防火墙：开放 8080(TCP)、3478(TCP/UDP)、50000-50100(UDP)
- [ ] 设置日志轮转

## 常见任务

### 修改服务器 IP

1. 重新生成证书：修改 `gen-cert.sh` 中的 `IP=` 变量，重新执行
2. 更新 `coturn/config/turnserver.conf` 中的 `external-ip`
3. 更新 `signaling-config.js` 中的 `SIGNALING_SERVER_URL`
4. 更新 `electron-main-patch.js` 中的 IP 白名单
5. 重新部署：`docker-compose down && docker-compose up -d --build`

### 添加新的 Socket 事件

1. 在对应的 handler 文件中添加事件处理
2. 遵循现有错误处理模式（try/catch + emit error 对象）
3. 添加中文日志输出
4. 更新 `README.md` 的 API 参考

### 调试连接问题

1. `bash verify.sh` 快速检查所有服务状态
2. `docker-compose logs -f` 查看实时日志
3. 检查证书 IP 是否与服务器 IP 一致
4. 用 trickle-ice 测试 TURN：https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

## 禁止操作

- ❌ 不要修改 `package.json` 中的包管理器为 npm 或 yarn
- ❌ 不要在 coturn 配置文件中使用 `$()` shell 展开语法
- ❌ 不要将证书文件（`.pem`）提交到版本控制
- ❌ 不要将 `socket.emit('error', '字符串')` 改回字符串格式
- ❌ 不要移除 `host-handler.js` 中 `connectingClientId: null` 的初始化
- ❌ 不要在生产环境使用 `origin: '*'`

## 获取帮助

- **项目文档**：参考 [README.md](README.md)
- **Socket.io 文档**：https://socket.io/docs/v4/
- **WebRTC 规范**：https://webrtc.org/getting-started/overview
- **Coturn 文档**：https://github.com/coturn/coturn

---

*最后更新：2026-03-20*
