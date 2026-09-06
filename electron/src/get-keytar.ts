import fs from 'fs';
import { join } from 'path';

// The OS keychain binding, which holds the biometric blobs and the HIBP API
// key. Keyed on the pinned binary being there rather than on NODE_ENV, like
// crypto.ts and get-passport.ts: an environment variable must not be able to
// choose which native module a packaged build loads, which is the same reason
// isDevBuild() in utils.ts checks isPackaged as well. A packaged build always
// has the pinned copy (copy-native-modules.mjs writes it, the afterPack hook
// checks it again) and never the npm package, so the pin is on the bytes that
// actually run; tests and plain Node have no dist-electron and get the wrapper
let keytar: typeof import('keytar') | undefined = undefined;

try {
	const pinned = join(__dirname, 'keytar.node');
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	keytar = fs.existsSync(pinned) ? require(pinned) : require('keytar');
} catch (error) {
	console.error('Failed to load native modules:', error);
}

export default keytar;
