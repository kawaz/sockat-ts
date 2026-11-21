# sockat (TypeScript)

> English | [日本語](./README-ja.md)

`@kawaz/sockat` lets TypeScript (Node.js 22 or later, and Bun) bind and connect Unix domain sockets at paths longer than `sun_path` (104 bytes on macOS, 108 on Linux). A path the standard library takes goes to it as it is; only a longer one is spelt shorter, naming the same place, and handed to the standard library. No native code.

- The behaviour (the language-independent specification): [kawaz/sockat's SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md)
- The implementations in other languages: [kawaz/sockat](https://github.com/kawaz/sockat)

What holds in every language is explained in the hub. This README gives only the names and forms in TypeScript and the caveats specific to sockat-ts.

- [What differs from the standard for a long path](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#what-differs-from-the-standard-for-a-long-path) (the address the kernel returns, closing the listener, a peer with `PrivateTmp`, ...)
- [Patterns not to use](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#patterns-not-to-use)
- [What stays in the base](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#what-stays-in-the-base) and [`sweep`](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#sweep)
- [Q&A](https://github.com/kawaz/sockat/blob/main/pages/faq.md) (long-lived daemons, tests run over and over, `PrivateTmp`, ...)

## Usage

```sh
npm install @kawaz/sockat
bun add @kawaz/sockat
```

node:net (Node and Bun):

```ts
import { bind, bindEx, connect } from "@kawaz/sockat";

const server = await bind(path); // a net.Server, once it is listening
server.on("connection", (s) => s.end("hi"));
const socket = await connect(path); // a net.Socket, once it is connected
```

Bun's `Bun.listen` / `Bun.connect` (throws at once without Bun):

```ts
import { connect, listen } from "@kawaz/sockat/bun";

const listener = listen({ unix: path, socket: { data(s, d) { s.write(d); } } });
const socket = await connect({ unix: path, socket: { data() {} } });
```

| function | returns |
|---|---|
| `bind(path)` / `connect(path)` | `net.Server` / `net.Socket` (Promise) |
| `bindEx(path, options?)` / `connectEx(path, options?)` | `Bound<net.Server>` / `Connected<net.Socket>` |
| `listen(options)` / `connect(options)` (`/bun`) | `Bun.UnixSocketListener` (sync) / `Bun.Socket` (Promise) |
| `listenEx(options, sockatOptions?)` / `connectEx(options, sockatOptions?)` (`/bun`) | `Bound<…>` / `Connected<…>` |
| `resolveForBind(path, options?)` / `resolveForConnect(path, options?)` | `ForBind` / `ForConnect` (sync) |
| `sweep()` / `sweepBase(path)` | nothing |

- An empty path, and a path with a NUL other than a leading one, are a `TypeError` (`code` `ERR_INVALID_ARG_VALUE`). On Linux a path with a leading NUL (abstract) goes to the standard library as it is
- node:net reads a string that looks like a number (`"0"`, `"8080"`, `"1e3"`, blanks, ...) as a TCP port. sockat puts `./` in front of such a spelling without a `/` (the same file; `Spelling` stays `CwdRelative`, `address()` is the path given). When `./` takes it over the standard length, it is a long path
- An OS error has Node's shape (`code`, `errno`, `syscall`, `path`; `path` is the path given). The errors of `*Ex` and the resolves also carry `route` (the route that bound / connected and failed, or `null`) and `skipped`

### Removing the socket file (`bindEx` and `file`)

```ts
const b = await bindEx(path); // b.socket, b.file, b.spelling, b.route, b.base, b.skipped
// ...
b.file.remove(); // removes the socket file (does not close the listener); call it before closing
b.socket.close();
```

What `file.remove()` and `file.cleanup()` promise is in [SPEC's "Cleanup"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#cleanup). Specific to sockat-ts:

- When the file cannot be recorded, `bindEx` removes the spelling's symlink before closing the listener and fails (what replaced the file stays). For a short path the standard library unlinks the path on close
- The listener of `bindEx` / `listenEx` too unlinks its spelling when closed ([Where it departs from SPEC](#where-it-departs-from-spec)). Call `remove()` before closing it

### What a spelling is good for (`Spelling`)

The meaning is in [SPEC's "Spelling properties"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#spelling-properties-spelling). In TypeScript it is a discriminated union on `kind`.

| `kind` | spelling |
|---|---|
| `"Original"` | the absolute path itself (an abstract name too) |
| `"CwdRelative"` | the relative path itself (with `./` in front too) |
| `"Linked"` | through B, D and E in a base, naming the same place as the path |
| `"Dangling"` | names nothing (never made by sockat-ts) |

`"Linked"`'s fields are `removable`, `until` (`"Process"` / `"Cleanup"`), `usableCrossUid` and `usableWithPrivateTmp`.

The listener's `address()` (node:net) and `unix` (`Bun.listen`) return the path given, not the spelling.

### `Options`

| field | meaning |
|---|---|
| `usableCrossUid` | ask for a spelling a peer of another uid can follow (binds only). sockat-ts makes no thread-cwd, so where there is none it is `ENAMETOOLONG` |
| `base` | the path of B itself (a place the application manages, such as `/tmp/app-1000/sockat`). `sweepBase(base)` removes its dead D |

The meaning is in [SPEC's "`Options`"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#options).

### resolve

To hand the spelling to a standard library yourself (`net.Server.listen`, `Bun.serve({ unix })`, `fetch(url, { unix })`, ...):

```ts
const f = resolveForBind(path); // a Linked spelling for a long path; ENAMETOOLONG where none fits
const server = net.createServer().listen(f.path);
// after it listens, before it is closed
const file = f.socketFile();
// ...
file.remove();
```

```ts
const f = resolveForConnect(path);
const socket = net.connect({ path: f.path }); // as many times as you like
f.cleanup(); // once done
```

### Cleaning up the base

What stays and when it goes is in [SPEC's "What stays in the base"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#what-stays-in-the-base). The forms in TypeScript:

- The default `bind` / `listen` gives no `file`. A long-lived process that binds long paths again and again uses `bindEx` / `listenEx` and cleans up with `file.remove()` or `file.cleanup()`
- Where tests run again and again, call `sweep()`, and `sweepBase(base)` for the B of `options.base` ([SPEC's "`sweep`"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#sweep))

## Patterns not to use

The list and why each is wrong are in [SPEC's "Patterns not to use"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#patterns-not-to-use). The forms in TypeScript and how to avoid them (the code below runs in [test/readme.test.ts](./test/readme.test.ts)):

| the form in TypeScript | instead |
|---|---|
| `fs.unlinkSync` / `fs.statSync` of the spelling the kernel gives (a peer's `getpeername` in another language, `lsof`'s output, ...) without looking at `spelling` | keep the path given and use it; `b.file.remove()` |
| use `f.path` after `cleanup()` or after the process has ended | use a spelling only within its `until` |
| bind a relative path, `process.chdir`, then `fs.unlinkSync` the relative path | make it absolute with `path.resolve` before the bind; `b.file.remove()` |
| count on `server.close()` / `listener.stop()` to remove the socket file (for a link-file spelling only the symlink goes) | `b.file.remove()`, or remove the path given |
| count on `b.file.remove()` to close the listener | close the listener yourself |
| call `b.file.remove()` after `server.close()` | call it before closing |
| hand a `/proc` spelling, or one whose `usableCrossUid` is false, to a peer of another uid | pass `{ usableCrossUid: true }` and check the resulting `spelling` |
| branch on `route`, `base` or `skipped` | branch on `spelling` |

```ts
// bind an absolute path, and remove before closing
const b = await bindEx(nodePath.resolve(relative));
try {
  // ...
} finally {
  b.file.remove();
  b.socket.close();
}

// check that a spelling for a peer of another uid was met
const f = resolveForBind(path, { usableCrossUid: true });
if (f.spelling.kind === "Linked" && !f.spelling.usableCrossUid) {
  throw new Error("no spelling another uid can follow");
}
```

## How a long path is reached

The standard length is 108 bytes for Node and 107 for Bun on Linux, 103 elsewhere (107 on illumos). A longer path follows SPEC's [routes and their order](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#routes-for-long-paths-and-their-order).

A route that needs native code is not made: it is passed over as unusable and named in `skipped` (reason `no native code in sockat-ts`).

| system | bind | connect |
|---|---|---|
| Linux / Android | link-dir (through `/proc`, then B's real path), thread-cwd (not made) | proc-direct (relative without `/proc`), thread-cwd-direct (not made), link-file |
| macOS | link-dir, link-file, thread-cwd (not made) | relative, widened (not made), thread-cwd-direct (not made), link-file |
| FreeBSD | link-dir, at (not made) | at-direct (not made), link-file |
| NetBSD | link-dir, link-file | relative, link-file |
| OpenBSD, illumos | link-dir | relative, link-file |

- What each route does is in [SPEC's "Route names"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#route-names)
- D is locked by opening it `O_SHLOCK` on macOS and the BSDs, and by `flock(1)` (util-linux / busybox) on an fd handed to it on Linux. **On a Linux without `flock(1)`, the bind of a long path and the resolves are `ENAMETOOLONG`** (the default connect still reaches it); so on illumos, which has no way to lock

### Where it stops reaching

The longest file name sockat-ts reaches (bytes) when the directory alone is over the standard length, the bases as the system has them. Without the routes it does not make, some are shorter than in the hub's [reach](https://github.com/kawaz/sockat/blob/main/pages/reach/README.md):

| system | bind (`bind`, `bindEx`, `listen`, `resolveForBind`) | connect (`connect`, `resolveForConnect`) |
|---|---|---|
| Linux / Android | about 76 (about 70 through `/proc`) | 255 |
| macOS | 255 (link-file) | 255 |
| FreeBSD, OpenBSD | about 72 | 255 |
| NetBSD | 255 (link-file) | 255 |
| illumos | none (D cannot be locked) | 255 |

Where no B can be made (no base can be written to), the routes through B cannot be used, and a connect reaches only what proc-direct and relative reach.

On a Linux where `/proc` is not visible (an empty tmpfs mounted over it, for example), Bun itself aborts at startup (seen with Bun 1.4.4 and 1.4.5; a plain `bun -e 'console.log(1)'` without sockat does the same). Node runs, and its connect uses relative.

## Where it departs from SPEC

- What only the routes not made (above) reach is not reached
- **The listener of `bindEx` / `listenEx` too unlinks its spelling when closed** (SPEC: "the listener of `_ex` removes nothing when closed"; the runtimes give no way to stop it). Call `file.remove()` before closing it
- When `bindEx` / `listenEx` cannot record the file of a short path, the standard library unlinks the path as the listener is closed, so whatever replaced the socket goes too
- No DGRAM and no SEQPACKET (the standard libraries of Node and Bun have none)
- The errors of a short path are the standard library's (Node's listen says `EACCES` for a missing directory); a long path's are SPEC's errno (`ENOENT`)

## License

MIT
