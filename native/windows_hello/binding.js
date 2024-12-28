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
    register: () => Promise.reject(new Error('Windows Hello is only available on Windows platforms')),
    authenticate: () => Promise.reject(new Error('Windows Hello is only available on Windows platforms'))
  };
}

// Wrap the native functions in promises
const wrappedModule = {
  isAvailable: windowsHello.isAvailable,
  register: (message) => {
    return new Promise((resolve, reject) => {
      try {
        windowsHello.register(message, (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  },
  authenticate: (message) => {
    return new Promise((resolve, reject) => {
      try {
        windowsHello.authenticate(message, (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }
};

module.exports = wrappedModule;