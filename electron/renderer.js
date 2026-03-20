const { ipcRenderer } = require("electron");
const io = require("socket.io-client");
const log = require("electron-log");
const { SIGNALING_SERVER_URL } = require("./signaling-config");

const PEERCONFIG = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302"],
    },
    {
      urls: [
        "turn:10.10.10.130:3478",
        "turn:10.10.10.130:3478?transport=tcp",
      ],
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

function updateServerInputState() {
  const input = getServerUrlInputEl();
  const btn = getConnectServerBtnEl();
  if (input) input.disabled = !!isInSession;
  if (btn) btn.disabled = !!isInSession;
}

// ── URL 校验（支持 http / https）────────────────────────────

function normalizeServerUrl(raw) {
  let v = (raw || "").trim();
  if (!v) return null;
  // 自动补全协议头
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

function connectSocket(serverUrl) {
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

  // 先清理旧连接
  try {
    detachSocketHandlers();
    detachBaseSocketHandlers();
    if (socket) socket.disconnect();
  } catch (e) {
    // ignore
  }

  currentServerUrl = normalized;
  socket = io(currentServerUrl, {
    transports: ["websocket", "polling"],
    autoConnect: true,
    // 内网自签证书时需跳过验证（生产环境使用正式证书后移除）
    rejectUnauthorized: false,
  });

  baseSocketHandlers = {
    error: (err) => {
      console.log("socket error", err);
    },
    connect: () => {
      console.log("[socket] connected", currentServerUrl);
      if (!isInSession) setTip(`已连接：${currentServerUrl}`);
      try {
        socket.emit("register-host", { hostName: getHostName() });
      } catch (e) {
        console.log("register-host failed", e);
      }
    },
    disconnect: (reason) => {
      console.log("[socket] disconnect", reason);
      if (!isInSession) setTip(`已断开：${currentServerUrl}`);
    },
    connect_error: (err) => {
      const msg = err && err.message ? err.message : String(err);
      console.log("[socket] connect_error", msg);
      if (!isInSession) setTip(`连接失败：${currentServerUrl}（${msg}）`);
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
      // 摘除临时监听器
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

    // 若 socket 处于非活跃状态则主动触发
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
          ipcRenderer.send("scroll", { x: eventData.x, y: eventData.y });
        } else if (type === "mousemove") {
          ipcRenderer.send("mousemove", { x: eventData.x, y: eventData.y });
        } else if (type === "keydown") {
          ipcRenderer.send("keydown", { key: eventData.key });
        } else if (type === "mousedown") {
          ipcRenderer.send("mousedown", { key: eventData.key });
        } else if (type === "mouseup") {
          ipcRenderer.send("mouseup", { key: eventData.key });
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

// ── 主流程：接收屏幕源并建立会话 ────────────────────────────

ipcRenderer.on("SET_SOURCE", async (event, { id, ...params }) => {
  console.log("[SET_SOURCE]", params);
  try {
    cleanup("replaced-by-new-session");
    currentParams = params;
    conversationId = params.conversationId;
    isInSession = true;
    updateServerInputState();

    // 等待 socket 就绪
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

    // 捕获屏幕
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: id,
          minWidth: 1280,
          maxWidth: 1280,
          minHeight: 720,
          maxHeight: 720,
        },
      },
    });
    currentStream = stream;
    ensurePeer();

    // 注册信令事件
    socketHandlers = {
      connectionRequest: (data) => {
        console.log("[signal] connection-request", data);
        if (!socket) return;
        currentClientId = data && data.requesterId ? data.requesterId : null;
        currentSessionId = data && data.sessionId ? data.sessionId : null;
        if (!currentClientId || !currentSessionId) return;

        socket.emit("accept-connection", {
          targetId: currentClientId,
          sessionId: currentSessionId,
        });
        setTip("已接受连接，等待 offer...");
      },

      offer: async (data) => {
        console.log("[signal] offer received", data && data.sessionId);
        if (!data || !data.offer) return;
        const peer = ensurePeer();
        currentClientId = data.sourceId || currentClientId;
        currentSessionId = data.sessionId || currentSessionId;
        if (!currentClientId || !currentSessionId) return;

        try {
          await peer.setRemoteDescription(data.offer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          if (!socket) return;
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

      // 修复：新增 client-offline 事件处理（与 client-disconnected 语义一致）
      clientOffline: (data) => {
        console.log("[signal] client-offline", data);
        cleanup("client-offline");
      },
    };

    if (socket) {
      socket.on("connection-request", socketHandlers.connectionRequest);
      socket.on("offer", socketHandlers.offer);
      socket.on("ice-candidate", socketHandlers.iceCandidate);
      socket.on("session-closed", socketHandlers.sessionClosed);
      socket.on("client-disconnected", socketHandlers.clientDisconnected);
      socket.on("client-offline", socketHandlers.clientOffline);
    }

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
  connectSocket(DEFAULT_SERVER_URL);

  const doConnectFromInput = () => {
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
    connectSocket(url);
  };

  if (connectBtn) {
    connectBtn.addEventListener("click", () => doConnectFromInput());
  }

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doConnectFromInput();
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
