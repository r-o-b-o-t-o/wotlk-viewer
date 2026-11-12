# @roboto_/wotlk-viewer-server

Node middleware and standalone server for
[`@roboto_/wotlk-viewer-core`](https://www.npmjs.com/package/@roboto_/wotlk-viewer-core): it serves an extracted
World of Warcraft 3.3.5a client with case-insensitive paths and exposes AzerothCore characters over a small JSON API.
It also extracts a client's MPQ archives in the order the client reads them.

```bash
npm install @roboto_/wotlk-viewer-server
```

Two commands come with it; both read `WOW_CLIENT_DIR`, and the server also `WOW_DB_URL` and `PORT`:

```bash
npx wotlk-viewer-extract --client /path/to/wow --out /path/to/extract
npx wotlk-viewer-server
```

See the [repository README](https://github.com/r-o-b-o-t-o/wotlk-viewer#readme) for the middleware and the API.
