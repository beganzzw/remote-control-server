# Remote Desktop Control - Electron Application

## Project Overview

This is a remote desktop control application built with Electron that enables real-time screen sharing and remote control capabilities through WebRTC and Socket.IO.

**Product Name**: 远程 (Remote)
**App ID**: remote
**Custom Protocol**: `remote://`

## Core Technologies

- **Electron**: 29.1.0 - Desktop application framework
- **WebRTC**: Peer-to-peer screen sharing and data channel communication
- **Socket.IO Client**: Real-time bidirectional communication with server (http://localhost:3000)
- **@jitsi/robotjs**: 0.6.13 - Native robot control for mouse/keyboard automation
- **electron-log**: 4.4.7 - Application logging

## Architecture

### Main Process ([main.js](main.js))
- Creates a transparent, always-on-top floating window (300x40px) at screen top center
- Registers custom protocol `remote://` for deep linking
- Enforces single-instance application
- Handles IPC events for robot control (mouse, keyboard, scroll)
- Manages desktop capture source acquisition
- Handles URL parameter parsing for remote sessions

### Renderer Process ([preload.js](preload.js))
- Establishes WebRTC peer connections with STUN/TURN servers
- Creates RTCDataChannel for remote control commands
- Handles Socket.IO events for signaling (offer/answer/ICE candidates)
- Processes remote control events and forwards to main process via IPC
- Manages connection lifecycle and cleanup

### UI ([index.html](index.html))
- Minimal draggable window interface
- Status indicator showing connection state
- "关闭远程" button to terminate remote session

## Key Features

### Remote Control Capabilities
- **Mouse Control**: Click, move, drag (mousedown/mouseup/mousemove)
- **Keyboard Input**: Key press simulation
- **Scroll**: Mouse wheel events
- **Clipboard**: Copy/paste operations (Ctrl+C, Ctrl+V)

### Screen Capture
- Fixed resolution: **1280x720** (captured from primary display)
- Coordinate mapping: Remote coordinates scaled to actual screen size
- Formula: `actualX = remoteX * (screenWidth / 1280)`, `actualY = remoteY * (screenHeight / 720)`

### Deep Linking
- Custom protocol: `remote://conversationId?userId=XXX&staffId=XXX`
- Launches application with session parameters
- Supports both macOS (`open-url` event) and Windows (command line args)

## WebRTC Configuration

与 [preload.js](preload.js) 中 `PEERCONFIG` 一致（本地 Coturn 见 `D:\work\turnserver\config\turnserver.conf`）。生产环境可改为域名 TURN 与独立凭据。

```javascript
const PEERCONFIG = {
  iceServers: [
    { urls: ["stun:stun1.l.google.com:19302"] },
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
```

## Socket.IO Events

### Emitted Events
- `remoteJoin(conversationId, callback)` - Join remote session
- `offer({ offer, conversationId, userId, staffId })` - Send WebRTC offer
- `toStaffCandidate({ candidate, conversationId, userId, staffId })` - Send ICE candidate
- `remoteClose({ conversationId })` - Close remote session

### Received Events
- `toUserCandidate(candidate)` - Receive ICE candidate from remote peer
- `answer(answer)` - Receive WebRTC answer
- `remoteClose()` - Remote session terminated by peer

## Build Configuration

### Development
```bash
npm run dev  # or yarn dev
```

### Production Build
- **macOS**: `npm run dist-mac` - Creates DMG and ZIP in `outMac/`
- **Windows**: `npm run dist-win` - Creates installer for x64

### Build Options
- ASAR: Disabled (`asar: false`)
- Compression: Store mode (no compression)
- NSIS (Windows): Multi-user installation with elevation

## Project Conventions

### Code Style
- **Language**: JavaScript (CommonJS modules)
- **Comments**: Chinese (中文)
- **IPC Event Names**: lowercase (e.g., `scroll`, `click`, `keydown`)
- **Logging**: Use `electron-log` for main process, `console.log` for renderer

### File Structure
```
├── main.js          # Main process entry point
├── preload.js       # Preload script for renderer
├── index.html       # UI window
├── package.json     # Project configuration
├── img/             # Application icons
└── .gitignore       # Git ignore rules
```

### Important Constants
- **Window Size**: 300x40 (transparent, frameless)
- **Screen Capture Resolution**: 1280x720 (fixed)
- **Socket Server**: http://localhost:3000
- **Custom Scheme**: `remote`

## Security Considerations

- `nodeIntegration: true` - Node.js APIs available in renderer (security risk if loading remote content)
- `contextIsolation: false` (commented out) - Context isolation disabled
- Custom protocol registered with privileges (`bypassCSP: true`)
- TURN server credentials hardcoded

## Development Notes

### Single Instance Lock
- Application requests single instance lock on startup
- Second instance sends parameters to first instance via `second-instance` event
- Prevents multiple simultaneous remote sessions

### Screen Coordinate Mapping
Always use the formula when processing remote mouse events:
```javascript
const actualX = remoteX * (screenWidth / 1280);
const actualY = remoteY * (screenHeight / 720);
```

### Error Handling
- Keyboard input errors are caught and logged (some keys may not be supported by robotjs)
- WebRTC errors are logged but not shown to user
- Connection state changes trigger cleanup

## Future Considerations

- [ ] Consider enabling context isolation for better security
- [ ] Move TURN credentials to environment variables
- [ ] Add error reporting/monitoring
- [ ] Support dynamic screen resolution
- [ ] Add session encryption for sensitive data
- [ ] Implement user authentication before allowing remote control
