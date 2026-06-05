const { ipcRenderer } = require("electron");
const io = require("socket.io-client");
const log = require("electron-log");
const {
  SIGNALING_SERVER_URL,
  SYSTEM_NAME,
  HOST_IP,
  HOST_IP_INTERFACE_NAME,
} = require("./signaling-config");
const { resolveHostIp } = require("./host-network");

const PEERCONFIG = {
  iceServers: [
    {
      urls: ["turn:10.10.10.130:3478?transport=tcp"],
      username: "user",
      credential: "password",
    },
  ],
};

let conversationId = "";
let currentPeer = null;
let currentChannel = null;
let currentStream = null;
let currentParams = null;
let socketHandlers = null;
let isInSession = false;
let currentSessionId = null;
let currentClientId = null;

// 日志节流：避免 mousemove 高频刷屏
let lastRendererMouseMoveLogAt = 0;
const RENDERER_MOUSE_MOVE_LOG_THROTTLE_MS = 200;

const DEFAULT_SERVER_URL = SIGNALING_SERVER_URL;
let currentServerUrl = DEFAULT_SERVER_URL;
let socket = null;
let baseSocketHandlers = null;

// ── DOM ──────────────────────────────────────────────────────

function setTip(text) {
  const el = document.getElementById("tip");
  if (el) el.innerText = text;
}

function getServerUrlInputEl() {
  return document.getElementById("server-url");
}

function getConnectServerBtnEl() {
  return document.getElementById("connect-server");
}

function getHostName() {
  try {
    const os = require("os");
    return os.hostname() || "electron-host";
  } catch (_) {
    return "electron-host";
  }
}

function getSystemName() {
  const configured = (SYSTEM_NAME || "").trim();
  if (configured) return configured;
  return getHostName();
}

function getHostRegistrationPayload() {
  const hostName = getHostName();
  const hostIp = resolveHostIp({
    hostIp: HOST_IP,
    interfaceName: HOST_IP_INTERFACE_NAME,
  });
  const payload = {
    hostName,
    systemName: getSystemName(),
    capabilities: ["mouse", "keyboard", "screen"],
  };
  if (hostIp) payload.hostIp = hostIp;
  return payload;
}

function updateServerInputState() {
  const input = getServerUrlInputEl();
  const btn = getConnectServerBtnEl();
  if (input) input.disabled = !!isInSession;
  if (btn) btn.disabled = !!isInSession;
}

// ── URL 校验（支持 http / https，自动补全协议头）────────────

function normalizeServerUrl(raw) {
  let v = (raw || "").trim();
  if (!v) return null;
  // 自动补全协议头，方便用户直接输入 IP:PORT
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  return v.replace(/\/+$/, "");
}

// ── 通知主进程会话结束 ───────────────────────────────────────

function notifySessionEnded(reason) {
  try {
    ipcRenderer.send("session-ended", { reason, conversationId });
  } catch (e) {
    // ignore
  }
}

// ── Socket 处理器清理 ────────────────────────────────────────

function detachBaseSocketHandlers() {
  if (!socket || !baseSocketHandlers) return;
  try {
    socket.off("error", baseSocketHandlers.error);
    socket.off("connect", baseSocketHandlers.connect);
    socket.off("disconnect", baseSocketHandlers.disconnect);
    socket.off("connect_error", baseSocketHandlers.connect_error);
  } catch (e) {
    // ignore
  }
  baseSocketHandlers = null;
}

function detachSocketHandlers() {
  if (!socketHandlers) return;
  try {
    if (socket) {
      socket.off("connection-request", socketHandlers.connectionRequest);
      socket.off("offer", socketHandlers.offer);
      socket.off("ice-candidate", socketHandlers.iceCandidate);
      socket.off("session-closed", socketHandlers.sessionClosed);
      socket.off("client-disconnected", socketHandlers.clientDisconnected);
      socket.off("client-offline", socketHandlers.clientOffline);
    }
  } catch (e) {
    // ignore
  }
  socketHandlers = null;
}

// ── Socket 连接管理 ───────────────────────────────────────────

async function connectSocket(serverUrl) {
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized) {
    setTip("服务器地址无效");
    return false;
  }
  if (isInSession) {
    setTip("远程中不可切换服务器");
    updateServerInputState();
    return false;
  }

  // 先清理旧连接，避免重复监听器
  try {
    detachSocketHandlers();
    detachBaseSocketHandlers();
    if (socket) socket.disconnect();
  } catch (e) {
    // ignore
  }

  currentServerUrl = normalized;
  try {
    const host = new URL(normalized).hostname;
    await ipcRenderer.invoke("signaling-allow-host", host);
  } catch (e) {
    console.log("[socket] signaling-allow-host ipc failed", e);
  }

  // nodeIntegration 开启时，engine.io 的 polling/websocket 走 Node 的 https/tls，不走 Chromium；
  // 自签证书须 rejectUnauthorized: false（与主进程 setCertificateVerifyProc 无关）。生产环境请换正式证书并移除此项。
  socket = io(currentServerUrl, {
    transports: ["polling", "websocket"],
    upgrade: true,
    rememberUpgrade: false,
    timeout: 25_000,
    autoConnect: true,
    rejectUnauthorized: false,
  });

  baseSocketHandlers = {
    error: (err) => {
      console.log("[socket] error", err);
    },
    connect: () => {
      console.log("[socket] connected", currentServerUrl);
      if (!isInSession) setTip(`已连接：${currentServerUrl}`);
      try {
        socket.emit("register-host", getHostRegistrationPayload());
      } catch (e) {
        console.log("[socket] register-host failed", e);
      }
      // 注册被控端信令（connection-request 等），否则仅 register-host 上线无法控制端 accept
      attachHostSignalingHandlers();
    },
    disconnect: (reason) => {
      console.log("[socket] disconnect", reason);
      if (!isInSession) setTip(`已断开：${currentServerUrl}`);
    },
    connect_error: (err) => {
      const msg = err && err.message ? err.message : String(err);
      const extra =
        err && (err.description || err.context || err.data)
          ? ` ${JSON.stringify(err.description || err.context || err.data)}`
          : "";
      console.log("[socket] connect_error", msg, extra, err);
      if (!isInSession) {
        const hint =
          /xhr poll error|websocket/i.test(msg) && /^https:/i.test(currentServerUrl)
            ? "（请确认 https 地址正确；服务端若为 HTTP 请改用 http://）"
            : "";
        setTip(`连接失败：${currentServerUrl}（${msg}）${hint}`);
      }
    },
  };

  socket.on("error", baseSocketHandlers.error);
  socket.on("connect", baseSocketHandlers.connect);
  socket.on("disconnect", baseSocketHandlers.disconnect);
  socket.on("connect_error", baseSocketHandlers.connect_error);

  updateServerInputState();
  return true;
}

// ── 等待 socket 连接就绪 ──────────────────────────────────────

function ensureSocketConnected(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error("socket-not-initialized"));
    if (socket.connected) return resolve();

    let done = false;

    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.off("connect", onConnect); } catch (_) {}
      try { socket.off("connect_error", onError); } catch (_) {}
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("socket-connect-timeout")));
    }, timeoutMs);

    const onConnect = () => finish(() => resolve());
    const onError = (err) =>
      finish(() => reject(err || new Error("socket-connect-error")));

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);

    if (!socket.active) {
      try { socket.connect(); } catch (_) {}
    }
  });
}

// ── WebRTC Peer 管理 ──────────────────────────────────────────

function cleanup(reason) {
  detachSocketHandlers();

  try { if (currentChannel) currentChannel.close(); } catch (_) {}
  currentChannel = null;

  try { if (currentPeer) currentPeer.close(); } catch (_) {}
  currentPeer = null;

  try {
    if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  currentStream = null;
  currentParams = null;
  isInSession = false;
  currentSessionId = null;
  currentClientId = null;

  setTip("未进行远程");
  updateServerInputState();
  notifySessionEnded(reason);

  // 信令仍在线时重新挂上被控端监听，便于下一通远控（否则 cleanup 会 off 掉永无 accept）
  if (socket && socket.connected) {
    attachHostSignalingHandlers();
  }
}

function ensurePeer() {
  if (currentPeer) return currentPeer;
  const peer = new RTCPeerConnection(PEERCONFIG);
  currentPeer = peer;

  // 被控端接收控制端创建的数据通道
  peer.ondatachannel = (event) => {
    try {
      currentChannel = event.channel;
      currentChannel.onopen = () => console.log("[datachannel] open");
      currentChannel.onmessage = (e) => {
        const eventData = JSON.parse(e.data);
        const type = eventData.type;
        if (type === "scroll") {
          // 前端发送字段为 deltaX/deltaY，这里兼容 x/y（历史）
          const x = eventData.deltaX ?? eventData.x ?? 0;
          const y = eventData.deltaY ?? eventData.y ?? 0;
          ipcRenderer.send("scroll", { x, y });
        } else if (type === "mousemove") {
          const now = Date.now();
          if (now - lastRendererMouseMoveLogAt >= RENDERER_MOUSE_MOVE_LOG_THROTTLE_MS) {
            lastRendererMouseMoveLogAt = now;
            console.log('[mouse] renderer mousemove', {
              input: { x: eventData.x, y: eventData.y },
              normalizedGuess:
                Number(eventData.x) >= 0 &&
                Number(eventData.x) <= 1 &&
                Number(eventData.y) >= 0 &&
                Number(eventData.y) <= 1,
            });
          }
          ipcRenderer.send("mousemove", { x: eventData.x, y: eventData.y });
        } else if (type === "keydown") {
          ipcRenderer.send("keydown", { key: eventData.key });
        } else if (type === "mousedown") {
          console.log('[mouse] renderer mousedown', {
            raw: { button: eventData.button, key: eventData.key },
          });
          ipcRenderer.send("mousedown", {
            button: eventData.button ?? eventData.key ?? "left",
          });
        } else if (type === "mouseup") {
          console.log('[mouse] renderer mouseup', {
            raw: { button: eventData.button, key: eventData.key },
          });
          ipcRenderer.send("mouseup", {
            button: eventData.button ?? eventData.key ?? "left",
          });
        } else if (type === "copy") {
          ipcRenderer.send("copy", { key: eventData.key });
        } else if (type === "paste") {
          ipcRenderer.send("paste", { key: eventData.key });
        }
      };
    } catch (e) {
      console.log("[datachannel] error", e);
    }
  };

  peer.onconnectionstatechange = () => {
    console.log("[peer] connectionState:", peer.connectionState);
    if (
      peer.connectionState === "disconnected" ||
      peer.connectionState === "failed" ||
      peer.connectionState === "closed"
    ) {
      setTip("远程已断开");
      cleanup("webrtc-disconnected");
    }
  };

  peer.oniceconnectionstatechange = () => {
    console.log("[peer] iceConnectionState:", peer.iceConnectionState);
  };

  peer.onicecandidateerror = (e) => {
    console.log("[peer] icecandidateerror", {
      errorCode: e && e.errorCode,
      errorText: e && e.errorText,
      url: e && e.url,
    });
  };

  peer.onicecandidate = (event) => {
    if (!event.candidate) return;
    if (!socket || !currentClientId || !currentSessionId) return;
    socket.emit("ice-candidate", {
      targetId: currentClientId,
      candidate: event.candidate,
      sessionId: currentSessionId,
    });
  };

  // 如果 stream 已就绪则立即挂载
  try {
    if (currentStream) {
      currentStream
        .getTracks()
        .forEach((track) => peer.addTrack(track, currentStream));
    }
  } catch (e) {
    console.log("[peer] attach tracks failed", e);
  }

  return peer;
}

// ── 桌面采集 + 与 connection-request / offer 共用 ─────────────

async function acquireDesktopMediaStream(desktopSourceId) {
  const { width, height } = await ipcRenderer.invoke("get-screen-size");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: desktopSourceId,
        minWidth: width,
        maxWidth: width,
        minHeight: height,
        maxHeight: height,
        minFrameRate: 15,
        maxFrameRate: 15,
      },
    },
  });

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = "detail"
  }
  currentStream = stream;
  ensurePeer();
}

async function handleIncomingConnectionRequest(data) {
  console.log("[signal] connection-request", data);
  if (!socket) return;
  const requesterId = data && data.requesterId;
  const sid = data && data.sessionId;
  if (!requesterId || !sid) return;

  currentClientId = requesterId;
  currentSessionId = sid;
  isInSession = true;
  updateServerInputState();

  if (!currentStream) {
    setTip("正在获取屏幕...");
    try {
      const res = await ipcRenderer.invoke("get-default-desktop-source");
      await acquireDesktopMediaStream(res.id);
    } catch (e) {
      log.warn("[signal] desktop capture failed", e);
      setTip(`获取屏幕失败：${e.message || e}`);
      isInSession = false;
      updateServerInputState();
      currentClientId = null;
      currentSessionId = null;
      return;
    }
  }

  socket.emit("accept-connection", {
    targetId: currentClientId,
    sessionId: currentSessionId,
  });
  setTip("已接受连接，等待 offer...");
}

function attachHostSignalingHandlers() {
  if (!socket) return;
  detachSocketHandlers();

  socketHandlers = {
    connectionRequest: (data) => {
      void handleIncomingConnectionRequest(data).catch((e) => {
        log.warn("[signal] connection-request handler error", e);
      });
    },

    offer: async (data) => {
      if (!data || !data.offer) return;
      const peer = ensurePeer();
      currentClientId = data.sourceId || currentClientId;
      currentSessionId = data.sessionId || currentSessionId;
      if (!currentClientId || !currentSessionId) return;
    
      try {
        await peer.setRemoteDescription(data.offer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
    
        // ── 提高视频编码码率 ──────────────────────────────
        const senders = peer.getSenders();
        for (const sender of senders) {
          if (!sender.track || sender.track.kind !== "video") continue;
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          for (const enc of params.encodings) {
            enc.maxBitrate = 4_000_000;   // 8 Mbps，局域网足够
            enc.maxFramerate = 15;
            enc.priority = "high";
            enc.networkPriority = "high";
          }
          try {
            await sender.setParameters(params);
          } catch (e) {
            console.log("[peer] setParameters failed", e);
          }
        }
        // ─────────────────────────────────────────────────
    
        socket.emit("answer", {
          targetId: currentClientId,
          answer,
          sessionId: currentSessionId,
        });
        setTip("已发送 answer，建立中...");
      } catch (e) {
        log.warn("[signal] handle offer error", e);
      }
    },

    iceCandidate: async (data) => {
      if (!data || !data.candidate) return;
      const peer = currentPeer || ensurePeer();
      try {
        await peer.addIceCandidate(data.candidate);
      } catch (e) {
        log.warn("[signal] addIceCandidate error", e);
      }
    },

    sessionClosed: (data) => {
      console.log("[signal] session-closed", data);
      cleanup("session-closed");
    },

    clientDisconnected: (data) => {
      console.log("[signal] client-disconnected", data);
      cleanup("client-disconnected");
    },

    clientOffline: (data) => {
      console.log("[signal] client-offline", data);
      cleanup("client-offline");
    },
  };

  socket.on("connection-request", socketHandlers.connectionRequest);
  socket.on("offer", socketHandlers.offer);
  socket.on("ice-candidate", socketHandlers.iceCandidate);
  socket.on("session-closed", socketHandlers.sessionClosed);
  socket.on("client-disconnected", socketHandlers.clientDisconnected);
  socket.on("client-offline", socketHandlers.clientOffline);
}

// ── remote:// 等入口：与「仅连信令」共用同一套采集与信令逻辑 ───

ipcRenderer.on("SET_SOURCE", async (event, { id, ...params }) => {
  console.log("[SET_SOURCE]", params);
  try {
    cleanup("replaced-by-new-session");
    currentParams = params;
    conversationId = params.conversationId || "";
    isInSession = true;
    updateServerInputState();

    try {
      setTip("正在连接服务器...");
      await ensureSocketConnected(5000);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg === "socket-not-initialized") {
        setTip("❌ Socket 未初始化，请先点击「连接服务器」");
      } else if (msg === "socket-connect-timeout") {
        setTip(`❌ 连接超时：${currentServerUrl}，请检查服务器是否启动`);
      } else {
        setTip(`❌ 连接失败：${msg}`);
      }
      cleanup("socket-not-connected");
      return;
    }

    await acquireDesktopMediaStream(id);
    setTip("已就绪，等待控制端连接...");
  } catch (e) {
    console.log("[SET_SOURCE] error", e.message);
    cleanup("set-source-error");
  }
});

// ── DOMContentLoaded ──────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  const input = getServerUrlInputEl();
  const connectBtn = getConnectServerBtnEl();

  if (input) input.value = DEFAULT_SERVER_URL;
  void connectSocket(DEFAULT_SERVER_URL);

  const doConnectFromInput = async () => {
    if (isInSession) {
      setTip("远程中不可切换服务器");
      updateServerInputState();
      return;
    }
    const url = normalizeServerUrl(input ? input.value : "");
    if (!url) {
      setTip("服务器地址无效");
      return;
    }
    setTip("正在连接服务器...");
    await connectSocket(url);
  };

  if (connectBtn) {
    connectBtn.addEventListener("click", () => void doConnectFromInput());
  }

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void doConnectFromInput();
    });
  }

  document.getElementById("end-control").addEventListener("click", () => {
    if (conversationId && socket) {
      socket.emit("remoteClose", { conversationId });
    }
    cleanup("local-end");
    setTimeout(() => ipcRenderer.send("close"), 300);
  });
});

window.addEventListener("beforeunload", () => {
  cleanup("renderer-unload");
});