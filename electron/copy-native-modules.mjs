import fs from 'fs'
import path from 'path'

const modulesToCopy = ['keytar']

// Get the platform-specific path for node native modules
function getModulePath(moduleName) {
    const basePath = path.join(process.cwd(), 'node_modules', moduleName)
    const buildPath = path.join(basePath, 'build', 'Release')
    const files = fs.readdirSync(buildPath)
    const nativeFile = files.find(file => file.endsWith('.node'))
    return path.join(buildPath, nativeFile)
}

// Create the destination directory if it doesn't exist
const destDir = path.join(process.cwd(), 'dist-electron', 'native_modules')
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
}

// Copy each module
for (const module of modulesToCopy) {
    try {
        const sourcePath = getModulePath(module)
        const destPath = path.join(destDir, path.basename(sourcePath))
        fs.copyFileSync(sourcePath, destPath)
        console.log(`Copied ${module} native module to ${destPath}`)
    } catch (err) {
        console.error(`Failed to copy ${module}:`, err)
        process.exit(1)
    }
} 