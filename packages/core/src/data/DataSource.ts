/** Provides raw game files by their client path (e.g. `Character\Human\Male\HumanMale.m2`). */
export interface DataSource {
  /** Rejects with `FileNotFoundError` when the file does not exist. */
  readFile(path: string): Promise<ArrayBuffer>;
  /** Optional cheap existence check; callers fall back to `readFile` when absent. */
  exists?(path: string): Promise<boolean>;
}

export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = 'FileNotFoundError';
  }
}

/** Duck-typed check so data sources from other packages can signal missing files without importing this class. */
export function isFileNotFound(e: unknown): boolean {
  return e instanceof Error && e.name === 'FileNotFoundError';
}

/** Normalizes a client path: forward slashes, no leading slash, lower-case. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** Fetches files from an HTTP server exposing the extracted client (see @wotlk-viewer/server). */
export class HttpDataSource implements DataSource {
  constructor(private readonly baseUrl = '/data') {}

  private url(path: string): string {
    return `${this.baseUrl}/${normalizePath(path).split('/').map(encodeURIComponent).join('/')}`;
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const res = await fetch(this.url(path));
    if (res.status === 404) throw new FileNotFoundError(path);
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    return res.arrayBuffer();
  }

  /** The server answers `?exists` with 200 or 204, which keeps missing files out of the browser console. */
  async exists(path: string): Promise<boolean> {
    const res = await fetch(`${this.url(path)}?exists`);
    if (!res.ok) throw new Error(`Failed to probe ${path}: ${res.status}`);
    return res.status === 200;
  }
}
