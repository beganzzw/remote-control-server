# Remote Control - 部署文档

## 架构概览

```
Electron 客户端
    │
    ├── wss://10.10.10.130:8080  ──→  signaling（信令服务，Socket.IO）
    └── turn:10.10.10.130:3478  ──→  coturn（TURN 中继服务）
```

### 被控端（Electron）与信令时序

- 渲染进程在 **Socket 连接成功并 `register-host` 之后** 即挂上 `connection-request` / `offer` / `ice-candidate` 等监听，因此**仅点击「连接服务器」**也会响应控制端的 `connect-to-host`，不再依赖必须先走 `remote://`。
- 若此时还没有桌面流，收到 `connection-request` 时会通过主进程 IPC **`get-default-desktop-source`** 取默认屏幕（与 `remote://` 入口一致，取第一块屏），再 `getUserMedia` 并 `accept-connection`。
- `remote://` 仍通过 `SET_SOURCE` 进入，内部复用同一套采集与信令逻辑。
- 信令服务等待被控端 `accept-connection` 的超时默认 **30s**，可通过环境变量 **`CONNECT_HOST_TIMEOUT_MS`** 调整（见 `signaling-server/core/client-handler.js`）。

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

（Windows 使用 Git Bash 时，旧版脚本若用 `-subj "/CN=..."` 可能被 MSYS 转成错误路径并报 `subject name is expected`；当前脚本已改为通过 OpenSSL 配置文件生成，可避免该问题。）

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

## Windows 安装包（Electron）

被控端桌面应用在仓库子目录 **`electron/`**，使用 [electron-builder](https://www.electron.build/) 打出 **NSIS 安装程序**（`.exe`）。

### 构建要求

- **必须在 64 位 Windows 上执行打包**（依赖 `@jitsi/robotjs` 原生模块，与当前 Electron 版本绑定）。
- 本机需具备 **Node.js** 与 **C++ 生成工具**（用于编译原生依赖；若 `npm install` 已能完成 `electron-builder install-app-deps`，则环境已就绪）。

### 构建命令

```bash
cd electron
npm install
npm run dist-win
```

### 产出物

- 安装包默认输出到 **`electron/dist/`**，例如：`远程-Setup-1.0.1.exe`（名称随 `package.json` 的 `version` 与 `build.productName` 变化）。
- 将上述 **Setup `.exe`** 拷贝到目标 Windows x64 电脑安装即可；当前 NSIS 配置为 **`perMachine: true`**，安装时需要管理员权限。

### 目标机与网络

- 安装后客户端会连接 [electron/signaling-config.js](electron/signaling-config.js) 中的 **`SIGNALING_SERVER_URL`**；目标机必须能访问该地址（HTTPS 证书需与现场策略一致，自签证书需在应用白名单或系统信任中处理）。
- 未做 **代码签名** 的安装包在 Windows 上可能触发 **SmartScreen**「已阻止未知的应用启动」——可选择「仍要运行」或采购证书对安装包签名。

### 应用与安装包图标

- **Windows**：`package.json` 的 `build.win.icon` 指向 [electron/img/512x512px.png](electron/img/512x512px.png)；electron-builder 会据此生成安装包与快捷方式所需图标。
- **macOS**：`build.mac.icon` / `dmg.icon` 同样使用该 PNG。
- 目录下另有 `img/*.ico`（如 `256x256 ico.ico`）等素材；若希望安装包强制使用某 `.ico`，可把 `build.win.icon` 改为对应路径（尽量避免文件名中的空格）。

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
| TURN relay-ip 可能漂移 | `docker-compose.yml` | 固定容器 IP（当前 `172.30.42.2`，与 `turnserver.conf` 同步） |
| `no-stdout-log` 导致 docker logs 为空 | `turnserver.conf` | 移除该配置项 |
| 嵌套 volume 挂载冲突 | `docker-compose.yml` | PID 路径改为 `/var/run/coturn` 独立挂载 |
| `cli-password=$()` 不会执行 | `turnserver.conf` | 移除该行（CLI 管理非必须） |
| error 事件格式不统一 | 各 handler | 统一为 `{ message: string }` 对象格式 |
| 仅连信令无 `SET_SOURCE` 导致「被控端未响应」 | `electron/renderer.js` | 连接后即挂信令；无流时 IPC 取屏再 accept |
| 控制端连接超时过短 | `client-handler.js` | 默认 30s，支持 `CONNECT_HOST_TIMEOUT_MS` |
