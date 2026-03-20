const { app, BrowserWindow, protocol, screen, dialog } = require("electron");
const { desktopCapturer, ipcMain } = require("electron");
const path = require("path");
const robot = require("@jitsi/robotjs");
const log = require("electron-log");
const { getDevAllowInsecureSignalingHosts } = require("./signaling-config");

// Dev-only: ensure Chromium can connect to self-signed HTTPS/WSS signaling.
// Must be set BEFORE app is ready / windows are created.
const DEV_ALLOW_INSECURE_SIGNALING_HOSTS = getDevAllowInsecureSignalingHosts();
if (process.env.NODE_ENV !== "production") {
  try {
    app.commandLine.appendSwitch("ignore-certificate-errors");
  } catch (_) {}
  app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
    try {
      const host = new URL(url).hostname;
      if (DEV_ALLOW_INSECURE_SIGNALING_HOSTS.has(host)) {
        event.preventDefault();
        return callback(true);
      }
    } catch (_) {
      // ignore
    }
    callback(false);
  });
}
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
      // contextIsolation: true, // 开启上下文隔离
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
    app.quit();
  });

  ipcMain.on("scroll", (e, { x, y }) => {
    robot.scrollMouse(x, y);
  });

  ipcMain.on("click", (e, { x, y }) => {
    robot.moveMouse(x * (screenWidth / 1280), y * (screenHeight / 720));
    robot.mouseClick();
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

  ipcMain.on("mousedown", (e, { key }) => {
    robot.mouseToggle("down");
  });

  ipcMain.on("mouseup", (e, { key }) => {
    robot.mouseToggle("up");
  });

  ipcMain.on("mousemove", (e, { x, y }) => {
    robot.moveMouse(x * (screenWidth / 1280), y * (screenHeight / 720));
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

function getStream(params) {
  desktopCapturer.getSources({ types: ["screen"] }).then(async (sources) => {
    try {
      mainWindow.webContents.send("SET_SOURCE", {
        id: sources[0].id,
        ...params,
      });
    } catch (e) {
      console.error(e);
    }
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
