const path = require('path');

let windowsHello;
try {
  if (process.env.NODE_ENV === 'development') {
    windowsHello = require('./build/Release/windows_hello.node');
  } else {
    windowsHello = require(path.join(__dirname, 'windows_hello.node'));
  }
} catch (err) {
  console.error('Failed to load windows_hello module:', err);
  windowsHello = {
    isAvailable: () => false,
    authenticate: () => Promise.reject(new Error('Windows Hello module not available'))
  };
}

module.exports = windowsHello;