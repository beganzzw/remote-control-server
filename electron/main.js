const {
  app,
  BrowserWindow,
  protocol,
  screen,
  dialog,
  session,
  desktopCapturer,
  ipcMain,
} = require("electron");
const path = require("path");
const robot = require("@jitsi/robotjs");
const log = require("electron-log");
const { getDevAllowInsecureSignalingHosts } = require("./signaling-config");

const gotTheLock = app.requestSingleInstanceLock();
let mainWindow;
let isSet = false;

const scheme = "remote";

protocol.registerSchemesAsPrivileged([
  {
    scheme: scheme,
    privileges: {
      bypassCSP: true,
    },
  },
]);

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 300,
    height: 86,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    x: Math.round(width / 2 - 300 / 2),
    y: 0,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.loadFile("index.html");

  if (process.env.NODE_ENV !== "production") {
    mainWindow.webContents.once("did-finish-load", () => {
      try {
        mainWindow.webContents.openDevTools({ mode: "detach" });
      } catch (_) {}
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    for (const [, timer] of pendingMouseUpTimers.entries()) {
      try { clearTimeout(timer); } catch (_) {}
    }
    pendingMouseUpTimers.clear();
    app.quit();
  });

  // 发送端固定使用归一化坐标（0~1），直接映射到 robotjs 实际屏幕尺寸
  function toScreenPoint(x, y) {
    const { width: sx, height: sy } = robot.getScreenSize();
    const nx = Number(x);
    const ny = Number(y);

    if (!sx || !sy || !Number.isFinite(nx) || !Number.isFinite(ny)) {
      return null;
    }

    return {
      x: Math.round(nx * sx),
      y: Math.round(ny * sy),
    };
  }

  // mousemove 节流：16ms ≈ 60fps，避免高频阻塞主线程
  let lastMouseMoveAt = 0;
  const MOUSE_MOVE_THROTTLE_MS = 16;

  // 鼠标兜底：防止网络抖动导致 mousedown 后无法抬起
  const AUTO_MOUSEUP_MS = 800;
  const pendingMouseUpTimers = new Map();

  // mousemove 日志节流
  let lastMouseMoveLogAt = 0;
  const MOUSE_MOVE_LOG_THROTTLE_MS = 200;

  ipcMain.on("scroll", (e, { x, y }) => {
    robot.scrollMouse(x, y);
  });

  ipcMain.on("click", (e, { x, y }) => {
    const p = toScreenPoint(x, y);
    if (!p) return;
    robot.moveMouse(p.x, p.y);
    robot.mouseClick();
    log.info("触发点击", p.x, p.y);
  });

  ipcMain.on("keydown", (e, { key }) => {
    try {
      robot.keyTap(key);
    } catch (error) {
      log.warn("keydown error", error);
    }
  });

  ipcMain.on("copy", () => {
    robot.keyTap("c", ["control"]);
  });

  ipcMain.on("paste", () => {
    robot.keyTap("v", ["control"]);
  });

  ipcMain.on("mousedown", (e, { button, key } = {}) => {
    console.log("★ 主线程 mousedown", button, key);
    let btn = (button ?? key ?? "left").toString();
    if (btn === "0") btn = "left";
    if (btn === "1") btn = "middle";
    if (btn === "2") btn = "right";
    try {
      robot.mouseToggle("down", btn);

      const oldTimer = pendingMouseUpTimers.get(btn);
      if (oldTimer) clearTimeout(oldTimer);

      const timer = setTimeout(() => {
        pendingMouseUpTimers.delete(btn);
        try {
          robot.mouseToggle("up", btn);
          console.log("[mouse] auto-mouseup", btn);
        } catch (error) {
          console.error("[mouse] auto-mouseup failed", { btn, error });
        }
      }, AUTO_MOUSEUP_MS);

      pendingMouseUpTimers.set(btn, timer);
    } catch (error) {
      console.error("[mouse] mousedown failed", { btn, error });
      log.warn("mousedown error", error);
    }
  });

  ipcMain.on("mouseup", (e, { button, key } = {}) => {
    console.log("★ 主线程 mouseup", button, key);
    let btn = (button ?? key ?? "left").toString();
    if (btn === "0") btn = "left";
    if (btn === "1") btn = "middle";
    if (btn === "2") btn = "right";
    try {
      const oldTimer = pendingMouseUpTimers.get(btn);
      if (oldTimer) clearTimeout(oldTimer);
      pendingMouseUpTimers.delete(btn);
      robot.mouseToggle("up", btn);
    } catch (error) {
      console.error("[mouse] mouseup failed", { btn, error });
      log.warn("mouseup error", error);
    }
  });

  ipcMain.on("mousemove", (e, { x, y }) => {
    const now = Date.now();
    if (now - lastMouseMoveAt < MOUSE_MOVE_THROTTLE_MS) return;
    lastMouseMoveAt = now;

    const p = toScreenPoint(x, y);
    if (!p) return;

    if (now - lastMouseMoveLogAt >= MOUSE_MOVE_LOG_THROTTLE_MS) {
      lastMouseMoveLogAt = now;
      const { width, height } = robot.getScreenSize();
      console.log("[mouse] mousemove", {
        input: { x, y },
        mapped: { x: p.x, y: p.y },
        screenSize: { width, height },
      });
    }

    robot.moveMouse(p.x, p.y);
  });

  ipcMain.on("close", () => {
    app.quit();
  });

  ipcMain.on("session-ended", (e, { reason, conversationId } = {}) => {
    log.info("session-ended", { reason, conversationId });
  });
}

async function getDefaultDesktopSourceId() {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  if (!sources.length) {
    throw new Error("no-desktop-sources");
  }
  return { id: sources[0].id };
}

function getStream(params) {
  getDefaultDesktopSourceId()
    .then(({ id }) => {
      try {
        mainWindow.webContents.send("SET_SOURCE", {
          id,
          ...params,
        });
      } catch (e) {
        console.error(e);
      }
    })
    .catch((e) => {
      log.warn("getStream getSources failed", e);
    });
}

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (process.platform === "win32") {
        openUrlWindow(commandLine);
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  try {
    const obj = parseURLParams(url);
    if (obj && obj.pathname) {
      getStream({
        conversationId: obj.pathname,
        userId: obj.params?.userId,
        staffId: obj.params?.staffId,
      });
    }
  } catch (e) {
    log.warn("open-url parse error", e);
  }
});

function openUrlWindow(argv) {
  for (const arg of argv) {
    if (!arg || typeof arg !== "string") continue;
    if (!arg.startsWith("remote://")) continue;
    try {
      const obj = parseURLParams(arg);
      if (!obj || !obj.pathname) continue;
      getStream({
        conversationId: obj.pathname.replace("/", "").trim(),
        userId: obj.params?.userId,
        staffId: obj.params?.staffId,
      });
    } catch (e) {
      log.warn("openUrlWindow parse error", e);
    }
  }
}

function parseURLParams(url) {
  const match = url.match(/^remote:\/\/([^?]+)(\?.+)?$/);
  if (!match) {
    return null;
  }

  const pathname = match[1];
  const searchParams = match[2] ? match[2].substring(1) : "";

  const params = {};
  if (searchParams) {
    searchParams.split("&").forEach((param) => {
      const [key, value] = param.split("=");
      if (!key) return;
      params[key] = value == null ? "" : decodeURIComponent(value);
    });
  }

  return {
    pathname: pathname,
    params: params,
  };
}

app.on("ready", () => {
  const allowedSignalingHosts = new Set(getDevAllowInsecureSignalingHosts());

  ipcMain.handle("get-screen-size", () => {
    return robot.getScreenSize();
  });

  ipcMain.handle("signaling-allow-host", (_event, hostname) => {
    if (typeof hostname === "string" && hostname.length > 0) {
      allowedSignalingHosts.add(hostname);
    }
    return true;
  });

  ipcMain.handle("get-default-desktop-source", async () =>
    getDefaultDesktopSourceId()
  );

  try {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      if (allowedSignalingHosts.has(request.hostname)) {
        callback(0);
        return;
      }
      callback(-2);
    });
  } catch (e) {
    log.warn("setCertificateVerifyProc failed", e);
  }

  app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
    try {
      const host = new URL(url).hostname;
      if (allowedSignalingHosts.has(host)) {
        event.preventDefault();
        return callback(true);
      }
    } catch (_) {}
    callback(false);
  });

  createWindow();
  app.removeAsDefaultProtocolClient(scheme);

  if (process.env.NODE_ENV === "development" && process.platform === "win32") {
    isSet = app.setAsDefaultProtocolClient(scheme, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    isSet = app.setAsDefaultProtocolClient(scheme);
  }

  if (process.platform !== "darwin") {
    openUrlWindow(process.argv);
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});