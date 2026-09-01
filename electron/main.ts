// Entry point. Two modes, decided before anything else loads.
//
// The browser starts this same binary as a native messaging host for the
// KeePassXC-Browser integration. In that mode the process owns a stdio pipe
// the browser reads as pure framed protocol, and it must not become the app:
// app-main.ts takes the single-instance lock at import time, which would hand
// the launch to the running Vigil and quit, and requiring electron at all puts
// a dock icon up for something the user never asked to see.
//
// So the check is inline, dependency free, and ahead of every import: whichever
// branch is taken, the other one's module body never runs. Both are marked
// external in electron/build.mjs so they stay separate files to require rather
// than being bundled in here.
if (process.argv.includes('--browser-proxy')) {
    require('./browser-proxy').run();
} else {
    require('./app-main');
}
