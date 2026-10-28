// One-off helper: extract the cached Electron zip into node_modules/electron/dist
// (npm 11 blocked the postinstall script, and extract-zip needs an absolute dir).
const path = require('path')
const fs = require('fs')
const extract = require('extract-zip')
const pkgRoot = path.resolve(__dirname, '..')
const electronDir = path.join(pkgRoot, 'node_modules', 'electron')
const distDir = path.join(electronDir, 'dist')
const { version } = require(path.join(electronDir, 'package.json'))

const cacheDir = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache')
const zips = []
for (const entry of fs.readdirSync(cacheDir)) {
  const sub = path.join(cacheDir, entry)
  if (fs.statSync(sub).isDirectory()) {
    for (const f of fs.readdirSync(sub)) if (f.endsWith('.zip')) zips.push(path.join(sub, f))
  }
}
if (zips.length === 0) {
  console.error('NO_CACHED_ZIP')
  process.exit(1)
}
const zip = zips[0]
console.log('extracting', zip)
extract(zip, { dir: distDir })
  .then(() => {
    fs.writeFileSync(path.join(distDir, 'version'), 'v' + version)
    fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe')
    console.log('EXTRACT_OK')
  })
  .catch((e) => {
    console.error('EXTRACT_FAIL', e.message)
    process.exit(1)
  })
