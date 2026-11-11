// Electron main process: starts the API + client server in this process and shows it in a window.
const path = require('node:path')
const { app, BrowserWindow, Menu, dialog, shell } = require('electron')

const PREFERRED_PORT = 47300

// One window for the whole app; a second launch brings it to front instead.
if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    let win = null
    let host = null

    app.on('second-instance', () => {
        if (!win) return
        if (win.isMinimized()) win.restore()
        win.focus()
    })

    async function start() {
        // Uploaded tables are kept per user (the server reads this when it loads).
        process.env.DBF_SESSION_DIR ??= path.join(app.getPath('userData'), 'sessions')
        const { startApp } = require('./app/server.cjs')
        host = await startApp({ clientDir: path.join(__dirname, 'app', 'client'), preferredPort: PREFERRED_PORT })

        Menu.setApplicationMenu(null)
        win = new BrowserWindow({
            width: 1440,
            height: 920,
            minWidth: 900,
            minHeight: 600,
            title: 'dbf inspector',
            icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
            show: false,
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        })
        win.once('ready-to-show', () => win.show())
        win.on('closed', () => { win = null })

        const isAppUrl = (url) => url === host.url || url.startsWith(host.url + '/')
        // Links to other sites open in the browser; the window only ever shows the app.
        win.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/.test(url)) void shell.openExternal(url)
            return { action: 'deny' }
        })
        win.webContents.on('will-navigate', (event, url) => {
            if (isAppUrl(url)) return
            event.preventDefault()
            if (/^https?:/.test(url)) void shell.openExternal(url)
        })
        // Without a menu: F5 / Ctrl+R reload, F12 / Ctrl+Shift+I developer tools, Ctrl +/-/0 zoom.
        win.webContents.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown') return
            const ctrl = input.control || input.meta
            const key = input.key.toLowerCase()
            const wc = win.webContents
            if (input.key === 'F5' || (ctrl && key === 'r')) wc.reload()
            else if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) wc.toggleDevTools()
            else if (ctrl && (key === '=' || key === '+')) wc.setZoomLevel(wc.getZoomLevel() + 0.5)
            else if (ctrl && key === '-') wc.setZoomLevel(wc.getZoomLevel() - 0.5)
            else if (ctrl && key === '0') wc.setZoomLevel(0)
            else return
            event.preventDefault()
        })

        await win.loadURL(host.url)
    }

    app.whenReady()
        .then(start)
        .catch((err) => {
            dialog.showErrorBox('Не вдалося запустити dbf inspector', err instanceof Error ? err.stack ?? err.message : String(err))
            app.exit(1)
        })

    app.on('window-all-closed', () => app.quit())
    app.on('will-quit', () => { void host?.close() })
}
