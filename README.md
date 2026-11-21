# sockat (TypeScript)

> English | [日本語](./README-ja.md)

Work in progress. `@kawaz/sockat` lets TypeScript (Node.js 22 or later, and Bun) bind and connect Unix domain sockets at paths longer than `sun_path`. A path the standard library takes goes to it as it is; only a longer one is spelt shorter and handed to the standard library. No native code.

- The behaviour (the language-independent specification): [kawaz/sockat's SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md)
- The implementations in other languages: [kawaz/sockat](https://github.com/kawaz/sockat)

## Usage

node:net (Node and Bun):

```ts
import { bind, connect, bindEx } from "@kawaz/sockat";

const server = await bind(longPath); // a net.Server, once it is listening
server.on("connection", (s) => s.end("hi"));
const socket = await connect(longPath); // a net.Socket, once it is connected

const b = await bindEx(longPath); // b.socket, b.file, b.spelling, b.route, b.base, b.skipped
b.file.remove(); // before closing the listener
b.socket.close();
```

Bun's `Bun.listen` / `Bun.connect`:

```ts
import { listen, connect } from "@kawaz/sockat/bun";

const listener = listen({ unix: longPath, socket: { data(s, d) { s.write(d); } } });
const socket = await connect({ unix: longPath, socket: { data() {} } });
```

There are also `connectEx`, `listenEx`, `resolveForBind`, `resolveForConnect`, `sweep` and `sweepBase` (SPEC's "公開する操作").

## Routes made (system × route)

A route that needs native code is not made: it is passed over as unusable and named in `skipped` (reason `no native code in sockat-ts`).

| system | bind | connect |
|---|---|---|
| Linux / Android | link-dir (procB, then the real path). No thread-cwd | proc-direct (relative without `/proc`), then link-file. No thread-cwd-direct |
| macOS | link-dir, then link-file. No thread-cwd | relative, then link-file. No widened, no thread-cwd-direct |
| FreeBSD | link-dir. No at | link-file. No at-direct |
| NetBSD | link-dir, then link-file | relative, then link-file |
| OpenBSD, illumos | link-dir | relative, then link-file |

## Not implemented, and where it departs from SPEC

- What only the routes not made (above) reach is not reached. On Linux a bind of a long path whose file name is over about 70 bytes is `ENAMETOOLONG` (macOS reaches it by link-file)
- The listener of `bindEx` / `listenEx` too unlinks its spelling when closed (`close()` / `stop()`) (SPEC: "the listener of `_ex` removes nothing when closed"; the runtimes give no way to stop it). Call `file.remove()` before closing it
- Closing the listener of the default `bind` / `listen` unlinks its spelling: for a link-file spelling only the symlink goes, and the socket file stays
- D is locked by `O_SHLOCK` on macOS and the BSDs, and by `flock(1)` (util-linux / busybox) on Linux. On a Linux without `flock(1)`, the bind of a long path and `resolveForBind` / `resolveForConnect` are `ENAMETOOLONG` (the default connect still reaches it); so on illumos and others, which have no way to lock
- No DGRAM and no SEQPACKET (the standard libraries of Node and Bun have none)
- The listener of a long path returns the original path from `address()` (node:net) and `unix` (`Bun.listen`). Peers in other languages and operational tools see the spelling
- The errors of a short path are the standard's (Node's listen says `EACCES` for a missing directory); a long path's are SPEC's errno (`ENOENT`)

## License

MIT
