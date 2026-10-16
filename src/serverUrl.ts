/** `serverUrl` plus `pathname`, keeping any path prefix of `serverUrl`
 * (`https://h/backend/a` + `/v2/ws` -> `https://h/backend/a/v2/ws`), so a
 * backend can sit behind a reverse proxy at a sub-path. */
export function joinServerPath(serverUrl: string, pathname: string): string {
  return new URL(pathname.replace(/^\/+/, ''), `${serverUrl.replace(/\/+$/, '')}/`).toString();
}
