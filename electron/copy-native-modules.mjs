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

// Copy node native modules
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

// Copy Windows Hello files if on Windows
if (process.platform === 'win32') {
    // Create windows_hello directory
    const windowsHelloDir = path.join(destDir, 'windows_hello')
    if (!fs.existsSync(windowsHelloDir)) {
        fs.mkdirSync(windowsHelloDir, { recursive: true })
    }

    // Copy Windows Hello files
    const windowsHelloSrcDir = path.join(process.cwd(), 'native', 'windows_hello')
    const files = [
        ['build/Release/windows_hello.node', 'windows_hello.node'],
        ['binding.js', 'binding.js']
    ]

    files.forEach(([src, dest]) => {
        const srcPath = path.join(windowsHelloSrcDir, src)
        const destPath = path.join(windowsHelloDir, dest)

        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath)
            console.log(`Copied ${srcPath} to ${destPath}`)
        } else {
            console.error(`Source file not found: ${srcPath}`)
            process.exit(1)
        }
    })
}