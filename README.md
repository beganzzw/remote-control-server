# Remote Control - 部署文档

## 架构概览

```
Electron 客户端
    │
    ├── wss://10.10.10.130:8080  ──→  signaling（信令服务，Socket.IO）
    └── turn:10.10.10.130:3478  ──→  coturn（TURN 中继服务）
```

## 目录结构

```
remote-control/
├── docker-compose.yml          # 统一编排（coturn + signaling）
├── gen-cert.sh                 # 一键生成自签名证书
├── signaling-config.js         # Electron 端信令地址配置
├── electron-main-patch.js      # Electron 主进程证书信任补丁
├── coturn/
│   ├── config/turnserver.conf  # Coturn 配置
│   ├── turndb/                 # 数据库（自动创建）
│   ├── log/                    # 日志（自动创建）
│   └── run/                    # PID 文件（自动创建）
└── signaling-server/
    ├── Dockerfile
    ├── package.json
    ├── server.js
    ├── config.js
    ├── core/
    │   ├── host-handler.js
    │   ├── client-handler.js
    │   ├── session-manager.js
    │   └── signaling-handler.js
    └── path/to/                # SSL 证书（由 gen-cert.sh 生成）
        ├── 10.10.10.130.pem
        └── 10.10.10.130-key.pem
```

## 部署步骤

### 1. 生成 SSL 证书

```bash
bash gen-cert.sh
```

生成后确认文件存在：
```bash
ls signaling-server/path/to/
# 10.10.10.130.pem  10.10.10.130-key.pem
```

### 2. 创建必要目录

```bash
mkdir -p coturn/turndb coturn/log coturn/run
```

### 3. 启动所有服务

```bash
docker-compose up -d --build
```

### 4. 验证服务

```bash
# 验证信令服务（应返回"远程控制服务器运行中"）
curl -k https://10.10.10.130:8080

# 验证 TURN 服务
turnutils_uclient -u user -w password -p 3478 10.10.10.130

# 查看实时日志
docker-compose logs -f signaling
docker-compose logs -f coturn
```

### 5. Electron 端配置

将 `signaling-config.js` 放入 Electron 项目根目录，
并将 `electron-main-patch.js` 中的代码添加到主进程 `main.js`。

## 常用命令

```bash
# 重启信令服务
docker-compose restart signaling

# 重启 TURN 服务
docker-compose restart coturn

# 停止所有服务
docker-compose down

# 查看端口占用
docker-compose ps
```

## 修复记录

| 问题 | 位置 | 修复方式 |
|------|------|----------|
| `connectingClientId` 未初始化导致所有连接被拒 | `host-handler.js` | 在 `handleRegister` 中补全初始化 |
| 证书 IP 为 `.96` 与服务器 `.130` 不一致 | `config.js` | 更新默认路径并提供证书生成脚本 |
| 超时计时器未清理旧计时器 | `client-handler.js` | 注册新计时器前先清理同目标旧计时器 |
| 两个 compose 网络隔离 | `docker-compose.yml` | 合并为统一 compose，固定子网 |
| TURN relay-ip 可能漂移 | `docker-compose.yml` | 固定容器 IP `172.21.0.2` |
| `no-stdout-log` 导致 docker logs 为空 | `turnserver.conf` | 移除该配置项 |
| 嵌套 volume 挂载冲突 | `docker-compose.yml` | PID 路径改为 `/var/run/coturn` 独立挂载 |
| `cli-password=$()` 不会执行 | `turnserver.conf` | 移除该行（CLI 管理非必须） |
| error 事件格式不统一 | 各 handler | 统一为 `{ message: string }` 对象格式 |
