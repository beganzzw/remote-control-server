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

// Dev-only: ensure Chromium can connect to self-signed HTTPS/WSS signaling.
// Must be set BEFORE app is ready / windows are created.
// 信令 HTTPS 自签证书：渲染进程里 socket.io 走 Chromium，rejectUnauthorized 无效；
// 用 session 校验回调 + 连接前 IPC 登记 hostname（与输入框一致）。
const gotTheLock = app.requestSingleInstanceLock();
let mainWindow;
let isSet = false;

const scheme = "remote";
let screenWidth = 0;
let screenHeight = 0;

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
    // show: true, // 不显示窗口
    width: 300,
    height: 86,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    x: Math.round(width / 2 - 300 / 2),
    y: 0,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Electron 20+ 默认 sandbox + contextIsolation 会导致页面里无 require
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.loadFile("index.html");

  // DevTools: open automatically in dev to inspect renderer logs.
  if (process.env.NODE_ENV !== "production") {
    mainWindow.webContents.once("did-finish-load", () => {
      try {
        mainWindow.webContents.openDevTools({ mode: "detach" });
      } catch (_) {}
    });
  }
  // 关闭窗口时退出应用
  mainWindow.on("closed", () => {
    mainWindow = null;
    // 清理所有自动抬起定时器，避免应用退出后仍触发 robotjs
    for (const [, timer] of pendingMouseUpTimers.entries()) {
      try { clearTimeout(timer); } catch (_) {}
    }
    pendingMouseUpTimers.clear();
    app.quit();
  });

  // 控制端发送的鼠标坐标可能是两种形态：
  // 1) 归一化坐标（0~1）：来自 well-site-frontend 的 input-binder
  // 2) 像素参考坐标（假定基准 1280x720）：历史代码可能的做法
  // 这里根据范围自动适配，避免出现“移动几像素”的问题。
  function toScreenPoint(x, y) {
    const sx = Number(screenWidth) || 0;
    const sy = Number(screenHeight) || 0;
    const nx = Number(x);
    const ny = Number(y);
    if (!sx || !sy || !Number.isFinite(nx) || !Number.isFinite(ny)) {
      return null;
    }

    const isNormalized =
      nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 && nx !== 1 && ny !== 1
        ? true
        : nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;

    if (isNormalized) {
      return { x: Math.round(nx * sx), y: Math.round(ny * sy), isNormalized: true };
    }
    // 兼容旧的基准 1280x720 缩放
    return {
      x: Math.round(nx * (sx / 1280)),
      y: Math.round(ny * (sy / 720)),
      isNormalized: false,
    };
  }

  // 接收端节流：避免高频 moveMouse() 阻塞主线程导致点击卡顿。
  let lastMouseMoveAt = 0;
  const MOUSE_MOVE_THROTTLE_MS = 16;

  // 鼠标兜底：防止某些网络抖动/事件丢失导致 mouse down 后无法抬起
  const AUTO_MOUSEUP_MS = 800;
  const pendingMouseUpTimers = new Map(); // key: btn(left/middle/right), value: timeoutId

  // 记录节流：避免日志刷屏导致反向卡顿。
  let lastMouseMoveLogAt = 0;
  const MOUSE_MOVE_LOG_THROTTLE_MS = 200;
  let didLogScreenSize = false;

  function ensureScreenSizeLogged() {

  }

  ipcMain.on("scroll", (e, { x, y }) => {
    robot.scrollMouse(x, y);
  });

  ipcMain.on("click", (e, { x, y }) => {
    const p = toScreenPoint(x, y);
    if (!p) return;
    robot.moveMouse(p.x, p.y);
    robot.mouseClick();
    log.info("触发点击",p.x,p.y)
  });

  ipcMain.on("keydown", (e, { key }) => {
    try {
      robot.keyTap(key);
    } catch (error) {
      log.warn("keydown error", error);
    }
  });

  ipcMain.on("copy", (e, { key }) => {
    robot.keyTap("c", ["control"]);
  });

  ipcMain.on("paste", (e, { key }) => {
    robot.keyTap("v", ["control"]);
  });

  ipcMain.on("mousedown", (e, { button, key } = {}) => {
    log.info("主线程 mousedown", button, key)
    // 兼容旧字段：button 不存在时尝试使用 key
    let btn = (button ?? key ?? "left").toString();
    // 兼容数字编码：0/1/2 -> left/middle/right
    if (btn === "0") btn = "left";
    if (btn === "1") btn = "middle";
    if (btn === "2") btn = "right";
    try {
      // ensureScreenSizeLogged();
      log.info('[mouse] mousedown', { rawButton: button, rawKey: key, btn });
      // robotjs: mouseToggle(button, isDown)
      robot.mouseToggle(btn, true);

      // 启动兜底自动抬起：800ms 后如果还没收到 mouseup，就释放
      const oldTimer = pendingMouseUpTimers.get(btn);
      if (oldTimer) clearTimeout(oldTimer);

      const timer = setTimeout(() => {
        pendingMouseUpTimers.delete(btn);
        try {
          robot.mouseToggle(btn, false);
          log.info('[mouse] auto-mouseup', { btn });
        } catch (error) {
          // robotjs 异常需要在 console 可见，方便你排查
          console.error('[mouse] auto-mouseup failed', { btn, error });
        }
      }, AUTO_MOUSEUP_MS);

      pendingMouseUpTimers.set(btn, timer);
    } catch (error) {
      console.error('[mouse] mousedown failed', { btn, error });
      log.warn("mousedown error", error);
    }
  });

  ipcMain.on("mouseup", (e, { button, key } = {}) => {
    let btn = (button ?? key ?? "left").toString();
    if (btn === "0") btn = "left";
    if (btn === "1") btn = "middle";
    if (btn === "2") btn = "right";
    try {
      // ensureScreenSizeLogged();
      log.info('[mouse] mouseup', { rawButton: button, rawKey: key, btn });
      const oldTimer = pendingMouseUpTimers.get(btn);
      if (oldTimer) clearTimeout(oldTimer);
      pendingMouseUpTimers.delete(btn);
      robot.mouseToggle(btn, false);
    } catch (error) {
      console.error('[mouse] mouseup failed', { btn, error });
      log.warn("mouseup error", error);
    }
  });

  ipcMain.on("mousemove", (e, { x, y }) => {
    const now = Date.now();
    if (now - lastMouseMoveAt < MOUSE_MOVE_THROTTLE_MS) return;
    lastMouseMoveAt = now;

    const p = toScreenPoint(x, y);
    if (!p) return;
    ensureScreenSizeLogged();
    if (now - lastMouseMoveLogAt >= MOUSE_MOVE_LOG_THROTTLE_MS) {
      lastMouseMoveLogAt = now;
      console.log('[mouse] mousemove', {
        input: { x, y },
        mapped: { x: p.x, y: p.y },
        isNormalized: p.isNormalized,
      });
    }
    robot.moveMouse(p.x, p.y);
  });

  ipcMain.on("close", (e, key) => {
    app.quit();
  });

  ipcMain.on("session-ended", (e, { reason, conversationId } = {}) => {
    log.info("session-ended", { reason, conversationId });
    // 需要弹窗的话再打开；默认仅记录日志避免打扰/避免渲染侧直接调用 dialog
    // try { dialog.showErrorBox("远程桌面已结束！", ""); } catch (_) {}
  });
}

/** 渲染进程在收到 connection-request 且尚无桌面流时调用，与 getStream 一致取第一块屏幕 */
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
    // 当第二个实例尝试启动时，发送消息给第一个实例
    if (mainWindow) {
      if (process.platform === "win32") {
        // 在 Windows 上，处理命令行参数中的自定义协议启动
        openUrlWindow(commandLine);
      }
      // Bring the first instance's window to the front if it's minimized
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
  event.preventDefault(); // 防止应用程序重启
  try {
    const obj = parseURLParams(url); // 解析参数
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
      const obj = parseURLParams(arg); // 解析参数
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
    } catch (_) {
      // ignore
    }
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
  const primaryDisplay = screen.getPrimaryDisplay();
  screenWidth = primaryDisplay.size.width;
  screenHeight = primaryDisplay.size.height;
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
