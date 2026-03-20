// ============================================================
// 将以下代码添加到 Electron 主进程 main.js 中
// 用途：信任内网自签名证书（仅限局域网 10.10.10.130）
// ============================================================

// 在 app.whenReady() 之前添加：
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // 仅信任内网信令服务器的自签名证书
  if (url.startsWith('https://10.10.10.130:8080')) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})
