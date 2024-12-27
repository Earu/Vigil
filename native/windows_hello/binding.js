const path = require('path');

let windowsHello;

// Only attempt to load the native module on Windows
if (process.platform === 'win32') {
  try {
    if (process.env.NODE_ENV === 'development') {
      windowsHello = require('./build/Release/windows_hello.node');
    } else {
      windowsHello = require(path.join(__dirname, 'windows_hello.node'));
    }
  } catch (err) {
    console.error('Failed to load windows_hello module:', err);
    windowsHello = createFallbackModule();
  }
} else {
  windowsHello = createFallbackModule();
}

function createFallbackModule() {
  return {
    isAvailable: () => false,
    authenticate: () => Promise.reject(new Error('Windows Hello is only available on Windows platforms'))
  };
}

module.exports = windowsHello;