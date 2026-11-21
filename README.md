# sockat (TypeScript)

> English | [日本語](./README-ja.md)

`@kawaz/sockat` lets TypeScript (Node.js 22 or later, and Bun) bind and connect Unix domain sockets at paths longer than `sun_path` (104 bytes on macOS, 108 on Linux). A path the standard library takes goes to it as it is; only a longer one is spelt shorter, naming the same place, and handed to the standard library. No native code.

- The behaviour (the language-independent specification): [kawaz/sockat's SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md)
- The implementations in other languages: [kawaz/sockat](https://github.com/kawaz/sockat)

## Usage

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

- `b.file` records the socket file's real path and `(st_dev, st_ino)` right after the bind; `remove()` removes it only while the path still names that file. When it cannot be recorded, `bindEx` fails (it removes the spelling's symlink before closing the listener, so what replaced the file stays; for a short path the standard library unlinks the path on close)
- When the last component is a symlink (bind follows it on macOS and NetBSD), the socket it leads to is recorded and removed; the symlink stays
- `remove()` also does `cleanup()`, which removes only the symlink (E) the spelling goes through. After a success, calls do nothing; after a failure, the next call tries again
- A replacement is told apart only while the listener is open: a file removed and made again after the close may get the same `(st_dev, st_ino)`

### What a spelling is good for (`Spelling`)

For a long path, the address the kernel keeps (a peer's `getpeername` in another language, `ss -x`, `lsof`, ...) is the spelling bound, not the path given. `spelling` says what it is good for afterwards. Branch on it.

| `kind` | spelling |
|---|---|
| `Original` | the absolute path itself (an abstract name too) |
| `CwdRelative` | the relative path itself (with `./` in front too); another place once the cwd changes |
| `Linked` | through B, D and E in a place, naming the same place as the path |
| `Dangling` | names nothing (never made by sockat-ts) |

`Linked`'s fields:

| field | meaning |
|---|---|
| `removable` | unlinking the spelling removes the file: true for link-dir, false for link-file (only the symlink goes) |
| `until` | `Process` (through `/proc/<pid>/fd/…`: until the process ends), `Cleanup` (through B's real path: until `cleanup()`) |
| `usableCrossUid` | a peer of another uid can follow it |
| `usableWithPrivateTmp` | a peer can follow it even when either side has a /tmp of its own (systemd's `PrivateTmp`): true through `/proc`, false through `/tmp` or `/var/tmp` |

The listener's `address()` (node:net) and `unix` (`Bun.listen`) return the path given, not the spelling.

### `Options`

| field | meaning |
|---|---|
| `usableCrossUid` | ask for a spelling a peer of another uid can follow (binds only). Where there is none, it does not fall back to one they cannot follow (sockat-ts may then be `ENAMETOOLONG`) |
| `base` | the path of B itself (a place the application manages, such as `/tmp/app-1000/sockat`). A check that fails is an error, with no fall back to the automatic places. B is sockat's alone: put nothing else in it |

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

### What is left in the places, and `sweep`

The spelling of a long path goes through a directory of the user's, B, a directory of the process in it, D, and a symlink, E. **B, D and E grow outside the application's own places.**

| | B | D | E |
|---|---|---|---|
| where | the first of `/tmp/sockat-<uid>`, `$XDG_RUNTIME_DIR/sockat`, `$TMPDIR/sockat-<uid>`, `.sockat.<random>` in the socket's directory where it can be made; `options.base` when given | 10 random characters in B | in D for resolves and binds; right in B for the default connect, removed right after the connect |
| while alive | stays | the process holds it with a shared lock | stays until `cleanup()` |
| cleaned by | not sockat | the system's cleaning of temporary directories once the process has ended; `sweep()` removes unlocked D when called | `cleanup()` / `remove()` |

- What is in `/tmp/sockat-<uid>` and the like: one D (10 random characters) per process, and the spellings' symlinks in it. Removing a live D only makes its spellings name nothing; they never reach an unrelated file
- The default `bind` / `listen` gives no `file`, so its E stays until the process ends. **A long-lived process that binds long paths again and again (a daemon making a socket per session) uses `bindEx` and `remove()` or `cleanup()` once a socket is no longer needed**
- **Where tests run again and again (CI), call `sweep()`** so dead D do not pile up. `sweepBase(base)` does it for `options.base`'s B. Neither is called for you
- **A B in the socket's directory (`.sockat.<random>`) and a B fallen back to (`sockat-<uid>.<random>`) may stay, through `sweep` and the system's cleaning alike**
- **Where a live D may be removed**: Linux with systemd older than v242 (RHEL 8: `/tmp` after 10 days) and a B in macOS's `$TMPDIR` (dirhelper, after 3 days). Its spellings then name nothing
- **A peer with `PrivateTmp`**: a peer whose `/tmp` is its own cannot follow a spelling through `/tmp`. `usableWithPrivateTmp` tells
- **Do not use a spelling after its cleanup**: a B in `/tmp` may be made again by someone else once gone

## Ways not to use it

Ways that remove an unrelated file or fail to remove one ([SPEC's "使ってはいけない書き方"](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md)). The code that avoids them runs in [test/readme.test.ts](./test/readme.test.ts).

| way | why not | instead |
|---|---|---|
| `fs.unlinkSync` / `fs.statSync` of the spelling the kernel gives (a peer's `getpeername`, `lsof`'s output, ...) without looking at `spelling` | for a link-file spelling only the symlink goes and the file stays | keep the path given and use it; `b.file.remove()` |
| use an old spelling (`f.path`) after `cleanup()` or after the process has ended | a B in `/tmp` may be made again by someone else; an `until: "Process"` spelling ends with the process | use a spelling only within its `until` |
| bind a relative path, `process.chdir`, then `fs.unlinkSync` the relative path | it names a file elsewhere (`CwdRelative`) | make it absolute with `path.resolve` before the bind; `b.file.remove()` |
| count on `server.close()` / `listener.stop()` to remove the socket file | closing unlinks the spelling: for a link-file spelling only the symlink goes | `b.file.remove()`, or remove the path given |
| count on `b.file.remove()` to close the listener | it only removes the file | close the listener yourself |
| call `b.file.remove()` after `server.close()` | a file made again after the close may not be told apart | call it before closing |
| hand a `/proc` spelling, or one whose `usableCrossUid` is false, to a peer of another uid | it cannot follow it | pass `{ usableCrossUid: true }` and check the resulting `spelling` |
| branch on `route`, `base` or `skipped` | for diagnostics; not a promise | branch on `spelling` |

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

The standard length is 108 bytes for Node and 107 for Bun on Linux, 103 elsewhere (107 on illumos). A longer path first has its directory looked up (`ENOENT` when missing, `ENOTDIR` when not a directory; `..` and `.` are never folded as a string, the system looks them up), then the routes are tried from the left. A route that binds / connects and fails returns its error; no later route is tried.

A route that needs native code is not made: it is passed over as unusable and named in `skipped` (reason `no native code in sockat-ts`).

| system | bind | connect |
|---|---|---|
| Linux / Android | link-dir (through `/proc`, then B's real path), thread-cwd (not made) | proc-direct (relative without `/proc`), thread-cwd-direct (not made), link-file |
| macOS | link-dir, link-file, thread-cwd (not made) | relative, widened (not made), thread-cwd-direct (not made), link-file |
| FreeBSD | link-dir, at (not made) | at-direct (not made), link-file |
| NetBSD | link-dir, link-file | relative, link-file |
| OpenBSD, illumos | link-dir | relative, link-file |

- **link-dir**: an E in D pointing to the socket's directory; binds `B/D/E/<name>`. `removable`
- **link-file**: an E in D pointing to the socket file; binds `B/D/E` (only where bind follows a symlink). The default connect goes through an E right in B and removes it right after. Reaches any file name length
- **proc-direct**: connects `/proc/self/fd/<the directory's fd>/<name>`
- **relative**: connects the path relative to the cwd (the cwd is not changed)
- D is locked by opening it `O_SHLOCK` on macOS and the BSDs, and by `flock(1)` (util-linux / busybox) on an fd handed to it on Linux. **On a Linux without `flock(1)`, the bind of a long path and the resolves are `ENAMETOOLONG`** (the default connect still reaches it); so on illumos, which has no way to lock

### Where it stops reaching

The longest file name reached (bytes) when the directory alone is over the standard length, the places as the system has them:

| system | bind (`bind`, `bindEx`, `listen`, `resolveForBind`) | connect (`connect`, `resolveForConnect`) |
|---|---|---|
| Linux / Android | about 76 (about 70 through `/proc`) | 255 |
| macOS | 255 (link-file) | 255 |
| FreeBSD, OpenBSD | about 72 | 255 |
| NetBSD | 255 (link-file) | 255 |
| illumos | none (D cannot be locked) | 255 |

Where no B can be made (no place can be written to), the routes through B cannot be used, and a connect reaches only what proc-direct and relative reach.

On a Linux where `/proc` is not visible (an empty tmpfs mounted over it, for example), Bun itself aborts at startup (seen with Bun 1.4.4 and 1.4.5; a plain `bun -e 'console.log(1)'` without sockat does the same). Node runs, and its connect uses relative.

## Where it departs from SPEC

- What only the routes not made (above) reach is not reached
- **The listener of `bindEx` / `listenEx` too unlinks its spelling when closed** (SPEC: "the listener of `_ex` removes nothing when closed"; the runtimes give no way to stop it). Call `file.remove()` before closing it
- When `bindEx` / `listenEx` cannot record the file of a short path, the standard library unlinks the path as the listener is closed, so whatever replaced the socket goes too
- No DGRAM and no SEQPACKET (the standard libraries of Node and Bun have none)
- The errors of a short path are the standard library's (Node's listen says `EACCES` for a missing directory); a long path's are SPEC's errno (`ENOENT`)

## License

MIT
