export class DatabasePathService {
    private static currentPath: string | undefined;

    static setPath(path: string | undefined) {
        this.currentPath = path;
    }

    static getPath(): string | undefined {
        return this.currentPath;
    }
}