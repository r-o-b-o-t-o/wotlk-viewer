import type { DbOptions } from './db';

/** Parses `mysql://user:password@host:port/database`; undefined input yields undefined. */
export function dbOptionsFromUrl(url: string | undefined): DbOptions | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}
