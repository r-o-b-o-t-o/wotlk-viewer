/** Provides raw game files by their client path (e.g. `Character\Human\Male\HumanMale.m2`). */
export interface DataSource {
  /** Rejects with `FileNotFoundError` when the file does not exist. */
  readFile(path: string): Promise<ArrayBuffer>;
}

export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = 'FileNotFoundError';
  }
}

/** Normalizes a client path: forward slashes, no leading slash, lower-case. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** Fetches files from an HTTP server exposing the extracted client (see @wotlk-viewer/server). */
export class HttpDataSource implements DataSource {
  constructor(private readonly baseUrl = '/data') {}

  async readFile(path: string): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}/${normalizePath(path).split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (res.status === 404) throw new FileNotFoundError(path);
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    return res.arrayBuffer();
  }
}
