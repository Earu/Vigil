import { join } from 'path';

// Import keytar dynamically based on environment
let keytar: typeof import('keytar') | undefined = undefined;

try {
	if (process.env.NODE_ENV === 'development') {
		keytar = require('keytar');
	} else {
		const keytarPath = join(__dirname, 'native_modules', 'keytar.node');
		keytar = require(keytarPath);
	}
} catch (error) {
	console.error('Failed to load native modules:', error);
}

export default keytar;