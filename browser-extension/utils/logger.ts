type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
    private static instance: Logger;
    private readonly DEBUG_MODE = true; // Set to false in production

    private constructor() {}

    static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private log(level: LogLevel, context: string, message: string, ...args: any[]) {
        if (!this.DEBUG_MODE && level === 'debug') return;

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}] [${context}]`;

        switch (level) {
            case 'debug':
                console.debug(prefix, message, ...args);
                break;
            case 'info':
                console.info(prefix, message, ...args);
                break;
            case 'warn':
                console.warn(prefix, message, ...args);
                break;
            case 'error':
                console.error(prefix, message, ...args);
                break;
            default:
                console.log(prefix, message, ...args);
                break;
        }
    }

    debug(context: string, message: string, ...args: any[]) {
        this.log('debug', context, message, ...args);
    }

    info(context: string, message: string, ...args: any[]) {
        this.log('info', context, message, ...args);
    }

    warn(context: string, message: string, ...args: any[]) {
        this.log('warn', context, message, ...args);
    }

    error(context: string, message: string, ...args: any[]) {
        this.log('error', context, message, ...args);
    }
}

export const logger = Logger.getInstance();