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
      // Coturn in D:\work\turnserver\config\turnserver.conf
      // - listening-port=3478
      // - user=user:password (lt-cred-mech)
      // - external-ip=10.10.10.130
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
let didEmitRemoteClose = false;
let isInSession = false;
let currentSessionId = null;
let currentClientId = null;

// 默认信令地址见 signaling-config.js
const DEFAULT_SERVER_URL = SIGNALING_SERVER_URL;
let currentServerUrl = DEFAULT_SERVER_URL;
let socket = null;
let baseSocketHandlers = null;

function getHostName() {
  try {
    // Works because nodeIntegration is enabled in BrowserWindow.
    // eslint-disable-next-line global-require
    const os = require("os");
    return os.hostname() || "electron-host";
  } catch (_) {
    return "electron-host";
  }
}

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

function updateServerInputState() {
  const input = getServerUrlInputEl();
  const btn = getConnectServerBtnEl();
  if (input) input.disabled = !!isInSession;
  if (btn) btn.disabled = !!isInSession;
}

function normalizeServerUrl(raw) {
  const v = (raw || "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) return null;
  return v.replace(/\/+$/, "");
}

function notifySessionEnded(reason) {
  try {
    ipcRenderer.send("session-ended", { reason, conversationId });
  } catch (e) {
    // ignore
  }
}

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
    }
  } catch (e) {
    // ignore
  }
  socketHandlers = null;
}

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

  // Tear down old socket cleanly to avoid duplicated listeners.
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
  });

  baseSocketHandlers = {
    error: (err) => {
      console.log("socket error", err);
    },
    connect: () => {
      console.log("connect", currentServerUrl);
      if (!isInSession) setTip(`已连接：${currentServerUrl}`);

      // Register as Host (被控端) for signaling-server.
      try {
        socket.emit("register-host", { hostName: getHostName() });
      } catch (e) {
        console.log("register-host failed", e);
      }
    },
    disconnect: (reason) => {
      console.log("disconnect", reason);
      if (!isInSession) setTip(`已断开：${currentServerUrl}`);
    },
    connect_error: (err) => {
      console.log("connect_error", err && err.message ? err.message : err);
      if (!isInSession) setTip(`连接失败：${currentServerUrl}`);
    },
  };

  socket.on("error", baseSocketHandlers.error);
  socket.on("connect", baseSocketHandlers.connect);
  socket.on("disconnect", baseSocketHandlers.disconnect);
  socket.on("connect_error", baseSocketHandlers.connect_error);

  updateServerInputState();
  return true;
}

function ensureSocketConnected(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error("socket-not-initialized"));
    if (socket.connected) return resolve();

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
      } catch (e) {
        // ignore
      }
      reject(new Error("socket-connect-timeout"));
    }, timeoutMs);

    const onConnect = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.off("connect_error", onError);
      } catch (e) {
        // ignore
      }
      resolve();
    };
    const onError = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.off("connect", onConnect);
      } catch (e) {
        // ignore
      }
      reject(err || new Error("socket-connect-error"));
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    try {
      socket.connect();
    } catch (e) {
      // ignore
    }
  });
}

function cleanup(reason) {
  detachSocketHandlers();

  try {
    if (currentChannel) currentChannel.close();
  } catch (e) {
    // ignore
  }
  currentChannel = null;

  try {
    if (currentPeer) currentPeer.close();
  } catch (e) {
    // ignore
  }
  currentPeer = null;

  try {
    if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    // ignore
  }
  currentStream = null;
  currentParams = null;
  isInSession = false;
  currentSessionId = null;
  currentClientId = null;

  didEmitRemoteClose = false;
  setTip("未进行远程");
  updateServerInputState();
  notifySessionEnded(reason);
}

function ensurePeer() {
  if (currentPeer) return currentPeer;
  const peer = new RTCPeerConnection(PEERCONFIG);
  currentPeer = peer;

  // 被控端一般接收控制端创建的数据通道
  peer.ondatachannel = (event) => {
    try {
      currentChannel = event.channel;
      currentChannel.onopen = (e) => console.log("datachannel onopen", e);
      currentChannel.onmessage = (e) => {
        const eventData = JSON.parse(e.data);
        if (eventData.type === "scroll") {
          ipcRenderer.send("scroll", { x: eventData.x, y: eventData.y });
        } else if (eventData.type === "mousemove") {
          ipcRenderer.send("mousemove", { x: eventData.x, y: eventData.y });
        } else if (eventData.type === "keydown") {
          ipcRenderer.send("keydown", { key: eventData.key });
        } else if (eventData.type === "mousedown") {
          ipcRenderer.send("mousedown", { key: eventData.key });
        } else if (eventData.type === "mouseup") {
          ipcRenderer.send("mouseup", { key: eventData.key });
        } else if (eventData.type === "copy") {
          ipcRenderer.send("copy", { key: eventData.key });
        } else if (eventData.type === "paste") {
          ipcRenderer.send("paste", { key: eventData.key });
        }
      };
    } catch (e) {
      console.log("ondatachannel error", e);
    }
  };

  peer.onconnectionstatechange = () => {
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
    try {
      console.log("iceConnectionState", peer.iceConnectionState);
    } catch (_) {}
  };

  peer.onicecandidateerror = (e) => {
    try {
      console.log("icecandidateerror", {
        errorCode: e && e.errorCode,
        errorText: e && e.errorText,
        url: e && e.url,
        address: e && e.address,
        port: e && e.port,
      });
    } catch (_) {}
  };

  peer.onicecandidate = (event) => {
    console.log("localPc:", event.candidate, event);
    if (!event.candidate) return;
    if (!socket || !currentClientId || !currentSessionId) return;
    socket.emit("ice-candidate", {
      targetId: currentClientId,
      candidate: event.candidate,
      sessionId: currentSessionId,
    });
  };

  // Attach stream tracks if already captured.
  try {
    if (currentStream) {
      currentStream.getTracks().forEach((track) => peer.addTrack(track, currentStream));
    }
  } catch (e) {
    console.log("attach tracks failed", e);
  }

  return peer;
}

ipcRenderer.on("SET_SOURCE", async (event, { id, ...params }) => {
  console.log("SET_SOURCE", params);
  try {
    // Replace any existing session first to avoid stacked handlers/peers.
    cleanup("replaced-by-new-session");
    currentParams = params;
    conversationId = params.conversationId;
    isInSession = true;
    updateServerInputState();

    try {
      setTip("正在连接服务器...");
      await ensureSocketConnected(5000);
    } catch (e) {
      console.log("socket connect failed", e);
      setTip("服务器未连接");
      cleanup("socket-not-connected");
      return;
    }

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
    console.log("stream", stream);
    currentStream = stream;
    // Create peer now so it can accept an incoming offer.
    ensurePeer();

    // Register socket handlers for host-side signaling.
    socketHandlers = {
      connectionRequest: (data) => {
        // { requesterId, sessionId, clientInfo }
        console.log("connection-request", data);
        if (!socket) return;
        currentClientId = data && data.requesterId ? data.requesterId : null;
        currentSessionId = data && data.sessionId ? data.sessionId : null;
        if (!currentClientId || !currentSessionId) return;

        // Auto accept connection in this demo.
        socket.emit("accept-connection", {
          targetId: currentClientId,
          sessionId: currentSessionId,
        });
        setTip("已接受连接，等待 offer...");
      },
      offer: async (data) => {
        // { sourceId, offer, sessionId }
        console.log("offer received", data && data.sessionId);
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
          log.warn("handle offer error", e);
        }
      },
      iceCandidate: async (data) => {
        // { sourceId, candidate, sessionId }
        if (!data || !data.candidate) return;
        if (!currentPeer) ensurePeer();
        try {
          await currentPeer.addIceCandidate(data.candidate);
        } catch (e) {
          log.warn("addIceCandidate error", e);
        }
      },
      sessionClosed: (data) => {
        console.log("session-closed", data);
        cleanup("session-closed");
      },
      clientDisconnected: (data) => {
        console.log("client-disconnected", data);
        cleanup("client-disconnected");
      },
    };

    if (socket) {
      socket.on("connection-request", socketHandlers.connectionRequest);
      socket.on("offer", socketHandlers.offer);
      socket.on("ice-candidate", socketHandlers.iceCandidate);
      socket.on("session-closed", socketHandlers.sessionClosed);
      socket.on("client-disconnected", socketHandlers.clientDisconnected);
    }

    setTip("已就绪，等待控制端连接...");
  } catch (e) {
    console.log("error111", JSON.stringify(e.message));
    cleanup("set-source-error");
  }
});

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

  // 获取按钮元素
  document.getElementById("end-control").addEventListener("click", (event) => {
    if (conversationId) {
      if (socket) socket.emit("remoteClose", { conversationId });
    }
    cleanup("local-end");
    setTimeout(() => ipcRenderer.send("close"), 300);
  });
});

window.addEventListener("beforeunload", () => {
  cleanup("renderer-unload");
});
