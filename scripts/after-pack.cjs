// node-pty's spawn-helper must be executable in the packed app, or every local shell fails to spawn.
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

// chmod 755 every node-pty spawn-helper (one per prebuilds directory) under an app.asar.unpacked directory.
function fixSpawnHelpers(unpackedDir) {
  const prebuilds = join(unpackedDir, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) return []
  const fixed = []
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (!existsSync(helper)) continue
    chmodSync(helper, 0o755)
    fixed.push(helper)
  }
  return fixed
}

/** electron-builder afterPack hook. */
async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  fixSpawnHelpers(join(resources, 'app.asar.unpacked'))
}

module.exports = afterPack
module.exports.fixSpawnHelpers = fixSpawnHelpers
