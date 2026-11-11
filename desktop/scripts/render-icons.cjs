// Electron script (run by make-icons.mjs): draws assets/icon.svg and assets/icon-small.svg with Chromium
// and writes assets/icon.ico (16..256 px), assets/icon.png (512 px) and the client's favicon.svg.
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const desktop = path.resolve(__dirname, '..')
const assets = path.join(desktop, 'assets')
const full = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8')
const small = fs.readFileSync(path.join(assets, 'icon-small.svg'), 'utf8')

// The small drawing has thicker lines and fewer details, so it stays readable in the taskbar and title bar.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const SMALL_UP_TO = 32

/** In the page: each size drawn straight from the vector, as raw RGBA and as PNG. */
function renderInPage(jobs) {
    const load = (svg) => new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = reject
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    })
    return Promise.all(jobs.map(async ({ svg, size }) => {
        const img = await load(svg)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, size, size)
        const rgba = Array.from(ctx.getImageData(0, 0, size, size).data)
        return { size, rgba, png: canvas.toDataURL('image/png').split(',')[1] }
    }))
}

/** 32-bit BMP icon image: BITMAPINFOHEADER, BGRA rows bottom-up, an empty AND mask (alpha is used). */
function bmpEntry(size, rgba) {
    const maskRow = Math.ceil(size / 32) * 4
    const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size)
    buf.writeUInt32LE(40, 0)
    buf.writeInt32LE(size, 4)
    buf.writeInt32LE(size * 2, 8) // image + mask
    buf.writeUInt16LE(1, 12)
    buf.writeUInt16LE(32, 14)
    buf.writeUInt32LE(size * size * 4 + maskRow * size, 20)
    let o = 40
    for (let y = size - 1; y >= 0; y--) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4
            buf[o++] = rgba[i + 2]
            buf[o++] = rgba[i + 1]
            buf[o++] = rgba[i]
            buf[o++] = rgba[i + 3]
        }
    }
    return buf
}

/** ICO with BMP images, except 256 px as PNG (what Windows and NSIS both read). */
function ico(images) {
    const header = Buffer.alloc(6 + 16 * images.length)
    header.writeUInt16LE(0, 0)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(images.length, 4)
    let offset = header.length
    const bodies = images.map(({ size, rgba, png }, n) => {
        const body = size >= 256 ? Buffer.from(png, 'base64') : bmpEntry(size, rgba)
        const e = 6 + 16 * n
        header.writeUInt8(size >= 256 ? 0 : size, e)
        header.writeUInt8(size >= 256 ? 0 : size, e + 1)
        header.writeUInt16LE(1, e + 4)
        header.writeUInt16LE(32, e + 6)
        header.writeUInt32LE(body.length, e + 8)
        header.writeUInt32LE(offset, e + 12)
        offset += body.length
        return body
    })
    return Buffer.concat([header, ...bodies])
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('about:blank')
    const jobs = [
        ...ICO_SIZES.map((size) => ({ svg: size <= SMALL_UP_TO ? small : full, size })),
        { svg: full, size: 512 },
    ]
    const images = await win.webContents.executeJavaScript(`(${renderInPage})(${JSON.stringify(jobs)})`)

    fs.writeFileSync(path.join(assets, 'icon.ico'), ico(images.filter((i) => ICO_SIZES.includes(i.size))))
    fs.writeFileSync(path.join(assets, 'icon.png'), Buffer.from(images.find((i) => i.size === 512).png, 'base64'))
    // Browser tab icon and the logo in the client's header: the small drawing, they are shown at 16-24 px.
    fs.writeFileSync(path.join(desktop, '..', 'client', 'public', 'favicon.svg'), small)
    console.log(`assets/icon.ico (${ICO_SIZES.join(', ')} px), assets/icon.png (512 px), client/public/favicon.svg`)
    app.quit()
}).catch((err) => {
    console.error(err)
    app.exit(1)
})
