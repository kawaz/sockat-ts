# sockat-ts reference

> English | [日本語](./REFERENCE-ja.md)

The behaviour is set by [the sockat specification](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md), which holds in every language; sockat-ts is its TypeScript implementation (package `@kawaz/sockat`, Node.js 22 or later and Bun, no native code). This page gives the names and types in TypeScript, the forms in TypeScript and what is specific to sockat-ts, and links to the specification for what holds in every language. How to use it is in the [user manual](MANUAL.md).

## Relation to the standard library

- What you get back is the standard `net.Server` / `net.Socket` (node:net, on Node and Bun), and `Bun.UnixSocketListener` / `Bun.Socket` (`@kawaz/sockat/bun`, which throws at once without Bun)
- The standard length is 107 bytes on Linux and illumos and 103 elsewhere, for Node and Bun alike (`sun_path` less one; Node on Linux also takes 108 bytes without a NUL, which is not handed to it). An absolute path up to it goes to the standard library as it is
- A relative path is made absolute first by the binds (`bind`, `bindEx`, `listen`, `listenEx`) and the resolves, and left relative by the connects (`connect`, `connectEx`). See the specification's "[Making a relative path absolute](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#making-a-relative-path-absolute)" and [Relative paths](#relative-paths) below
- An empty path, and a path with a NUL other than a leading one, are a `TypeError` (`code` `ERR_INVALID_ARG_VALUE`). On Linux a path with a leading NUL (abstract) goes to the standard library as it is
- node:net reads a string that looks like a number (`"0"`, `"8080"`, `"1e3"`, blanks, ...) as a TCP port. When a spelling handed over relative (by the connects, and by the binds and the resolves when no candidate and no route can be used) has no `/` and reads so, sockat puts `./` in front (the same file; `Spelling` stays `CwdRelative`, `address()` is the path given). When `./` takes it over the standard length, it is a long path. A bind of `"0"` goes to the standard library as its absolute candidate (`Original`), so no `./` is needed, and `address()` is that absolute path
- An OS error has Node's shape (`code`, `errno`, `syscall`, `path`; `path` is the path given)
- No dependencies on other packages
- The bind of a long path or a relative path differs from the standard in places. See the specification's "[What differs from the standard for a long path](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#what-differs-from-the-standard-for-a-long-path)" and [Where it departs from SPEC](#where-it-departs-from-spec) below

## Functions

| function | returns | SPEC's function |
|---|---|---|
| `bind(path)` | `Promise<net.Server>` (once it is listening) | `bind` |
| `connect(path)` | `Promise<net.Socket>` (once it is connected) | `connect` |
| `bindEx(path, options?)` | `Promise<Bound<net.Server>>` | `bind_ex` |
| `connectEx(path, options?)` | `Promise<Connected<net.Socket>>` | `connect_ex` |
| `listen(options)` (`/bun`) | `Bun.UnixSocketListener` (sync) | `bind` |
| `connect(options)` (`/bun`) | `Promise<Bun.Socket>` | `connect` |
| `listenEx(options, sockatOptions?)` (`/bun`) | `Bound<Bun.UnixSocketListener>` (sync) | `bind_ex` |
| `connectEx(options, sockatOptions?)` (`/bun`) | `Promise<Connected<Bun.Socket>>` | `connect_ex` |
| `resolveForBind(path, options?)` | `ForBind` (sync) | `resolve_for_bind` |
| `resolveForConnect(path, options?)` | `ForConnect` (sync) | `resolve_for_connect` |
| `sweep()` | nothing | `sweep` |
| `sweepBase(path)` | nothing | `sweep_base` |

- The `/bun` functions take what `Bun.listen` / `Bun.connect` take, and `unix` may be long
- There is no `connect_nonblocking`, and no DGRAM or SEQPACKET ([Where it departs from SPEC](#where-it-departs-from-spec))

## Types

| SPEC's type | TypeScript's type |
|---|---|
| `Bound` | `Bound<S>` (`socket`, `file`, `spelling`, `route`, `base`, `skipped`) |
| `Connected` | `Connected<S>` (`socket`, `route`, `skipped`) |
| `ForBind` | `ForBind` (`path`, `spelling`, `route`, `base`, `skipped`, `cleanup()`, `socketFile()`) |
| `ForConnect` | `ForConnect` (`path`, `spelling`, `route`, `skipped`, `cleanup()`) |
| `SocketFile` | `SocketFile` (`remove()`, `cleanup()`) |
| diagnostics | `route` (a string), `base` (`proc`, `tmp`, `runtime`, `tmpdir`, `sockdir`, `given`; `null` when the spelling goes through no B), `skipped` (`Skip[]`) |
| a failure of `_ex` or a resolve | the OS error (`SystemError`) carrying `route` (the route that bound / connected and failed, or `null`) and `skipped` (`RouteDiagnostics`) |
| an argument error | `TypeError` (`code` `ERR_INVALID_ARG_VALUE`) |

What the diagnostics mean is in the specification's "[Diagnostics](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#diagnostics)". None of them is a promise: branch on `spelling`.

## `Options`

| field | meaning |
|---|---|
| `usableCrossUid` | ask for a spelling a peer of another uid can follow (binds only). sockat-ts makes no thread-cwd, so where there is none it is `ENAMETOOLONG` |
| `base` | the path of B itself (a place the application manages, such as `/tmp/app-1000/sockat`). `sweepBase(base)` removes its dead D |

The meaning and the errors are in the specification's "[`Options`](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#options)" and "[Errors](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#errors)".

## What a spelling is good for (`Spelling`)

The meaning is in the specification's "[Spelling properties](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#spelling-properties-spelling)". In TypeScript it is a discriminated union on `kind`.

| `kind` | spelling |
|---|---|
| `"Original"` | an absolute path: the absolute path given (an abstract name too), or an absolute path naming the same place (a relative path's absolute candidate, a long absolute path's real path) |
| `"CwdRelative"` | the relative path given (with `./` in front too). Only when no candidate and no route could be used and it went to the standard library relative, or when a resolve was given a relative path not ending with a name |
| `"Linked"` | through B, D and E in a base, naming the same place as the path |
| `"Dangling"` | names nothing (never made by sockat-ts) |

- `"Linked"`'s fields are `removable`, `until` (`"Process"` / `"Cleanup"`), `usableCrossUid` and `usableWithPrivateTmp`
- `ForConnect`'s `spelling` is one of `"Original"`, `"CwdRelative"` and `"Linked"`
- The listener's `address()` (node:net) and `unix` (`Bun.listen`) return, not the spelling, but the path given when it is absolute, and the absolute form of a relative one ([Relative paths](#relative-paths))

## Relative paths

The binds and the resolves make a relative path absolute first; the connects hand it over relative. The steps and what differs from the standard are in the specification's "[Making a relative path absolute](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#making-a-relative-path-absolute)". In TypeScript:

- When an absolute candidate goes to the standard library, `address()` and `unix` return that candidate
- When it takes a route, they return the form of the real candidate (the real path of the socket's directory and the file name)
- Only when no route can be used and it goes to the standard library relative (`CwdRelative`) do they return the relative path given
- `$PWD` is read from the environment at each call (`process.chdir` does not update `$PWD`, so a `$PWD` other than the cwd is no candidate)
- When the cwd is deeper than PATH_MAX (no real path can be had), the default `bind` of a short relative path goes to the standard library relative and binds; `bindEx` cannot record the socket file and fails
- The details are in [DR-0005](decisions/DR-0005-absolutize-relative-path-details.md) (Japanese)

## Removing the socket file (`file`)

What `file.remove()` and `file.cleanup()` promise is in the specification's "[Cleanup](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#cleanup)". How to use it is in the user manual's "[Remove the socket file when done](manual/bind.md#remove-the-socket-file-when-done)".

- `remove()` removes the file only and does not close the listener. Call it before closing the listener
- The listener of `bindEx` / `listenEx` too unlinks its spelling when closed ([Where it departs from SPEC](#where-it-departs-from-spec))
- When the file cannot be recorded, `bindEx` fails. For a route's spelling it removes the symlink before closing the listener (what replaced the file stays). For a spelling handed to the standard library (a short absolute path, an absolute candidate, a spelling handed over relative) it closes the listener only where that is known to unlink the socket bound alone, and otherwise leaves it open and `unref()`'d ([Where it departs from SPEC](#where-it-departs-from-spec))

## resolve (`ForBind`, `ForConnect`)

What spelling is returned, and when none can be, is in the specification's "[resolve](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#resolve)" and "[`SocketFile` of `ForBind`](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#socketfile-of-forbind)". How to use them is in the user manual's "[Resolve a path only](manual/resolve.md)".

- Hand the spelling to the standard (`net.Server.listen`, `net.connect`, `Bun.serve({ unix })`, `fetch(url, { unix })`, node:http's `socketPath`, ...). A spelling that reads as a number comes with `./` in front for node:net
- Call `ForBind.socketFile()` after it listens and before the listener is closed
- Where nothing reaches, `ENAMETOOLONG`

## What stays in the base, and `sweep`

What stays and when it goes is in the specification's "[What stays in the base](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#what-stays-in-the-base)" and "[`sweep`](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#sweep)". The forms in TypeScript:

- The default `bind` / `listen` gives no `file`. A long-lived process that binds long paths again and again uses `bindEx` / `listenEx` and cleans up with `file.remove()` or `file.cleanup()`
- Where tests run again and again, call `sweep()`, and `sweepBase(base)` for the B of `options.base`. Neither is called for you

## Patterns not to use

The list and why each is wrong are in the specification's "[Patterns not to use](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#patterns-not-to-use)". The forms in TypeScript and how to avoid them (the code below runs in [test/manual.test.ts](../test/manual.test.ts)):

| the form in TypeScript | instead |
|---|---|
| `fs.unlinkSync` / `fs.statSync` of the spelling the kernel gives (a peer's `getpeername` in another language, `lsof`'s output, ...) without looking at `spelling` | keep the path given and use it; `b.file.remove()` |
| use `f.path` after `cleanup()` or after the process has ended | use a spelling only within its `until` |
| bind a relative path, `process.chdir`, then `fs.unlinkSync` the relative path's string | `b.file.remove()` |
| close a listener whose `spelling` is `CwdRelative` after a `process.chdir` (the standard library unlinks the relative path against the cwd at the close) | call `b.file.remove()` and close it before changing the cwd |
| count on `server.close()` / `listener.stop()` to remove the socket file (for a link-file spelling only the symlink goes) | `b.file.remove()`, or remove the path given |
| count on `b.file.remove()` to close the listener | close the listener yourself |
| call `b.file.remove()` after `server.close()` | call it before closing |
| hand a `/proc` spelling, or one whose `usableCrossUid` is false, to a peer of another uid | pass `{ usableCrossUid: true }` (where it cannot be met, `ENAMETOOLONG` rather than a spelling they cannot follow) |
| branch on `route`, `base` or `skipped` | branch on `spelling` |

```ts
// keep the path given, and remove before closing
const b = await bindEx(path);
try {
  // ...
} finally {
  b.file.remove();
  b.socket.close();
}
// ENAMETOOLONG where no spelling another uid can follow can be had
const f = resolveForBind(path, { usableCrossUid: true });
```

## How a long path is reached

A path over the standard length tries the routes of the specification's "[Routes for long paths and their order](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#routes-for-long-paths-and-their-order)" in turn. Before the routes, the binds and the resolves see whether an absolute candidate fits (for a relative path the real and the `$PWD` candidates, for a long absolute path its real path), and hand it to the standard library when it does (making nothing in the bases). A relative path, however short, takes the routes when its absolute form is long.

A route that needs native code is not made: it is passed over as unusable and named in `skipped` (reason `no native code in sockat-ts`).

| system | bind | connect |
|---|---|---|
| Linux / Android | link-dir (through `/proc`, then B's real path), thread-cwd (not made) | proc-direct (relative without `/proc`), thread-cwd-direct (not made), link-file |
| macOS | link-dir, link-file, thread-cwd (not made) | relative, widened (not made), thread-cwd-direct (not made), link-file |
| FreeBSD | link-dir, at (not made) | at-direct (not made), link-file |
| NetBSD | link-dir, link-file | relative, link-file |
| OpenBSD, illumos | link-dir | relative, link-file |

- What each route does is in the specification's "[Route names](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md#route-names)", and how B is made in [SPEC-routes](https://github.com/kawaz/sockat/blob/main/docs/SPEC-routes.md)
- D is locked by opening it `O_SHLOCK` on macOS and the BSDs, and by `flock(1)` (util-linux / busybox) on an fd handed to it on Linux. **On a Linux without `flock(1)`, the bind of a long path and the resolves are `ENAMETOOLONG`** (the default connect still reaches it); so on illumos, which has no way to lock

### Where it stops reaching

The longest file name sockat-ts reaches (bytes) when the directory alone is over the standard length, the bases as the system has them. Without the routes it does not make, some are shorter than the other languages in the hub's [reach](https://github.com/kawaz/sockat/blob/main/pages/reach/README.md):

| system | bind (`bind`, `bindEx`, `listen`, `resolveForBind`) | `connect`, `connectEx` | `resolveForConnect` |
|---|---|---|---|
| Linux / Android | about 76 (about 70 through `/proc`) | 255 | 255 |
| macOS | 255 (link-file) | 255 | 255 |
| FreeBSD, OpenBSD | about 72 | 255 | 255 |
| NetBSD | 255 (link-file) | 255 | 255 |
| illumos | none (D cannot be locked) | 255 (no D) | none (D cannot be locked) |

Where no B can be made (no base can be written to), the routes through B cannot be used, and a connect reaches only what proc-direct and relative reach.

On a Linux where `/proc` is not visible (an empty tmpfs mounted over it, for example), Bun itself aborts at startup (seen with Bun 1.4.4 and 1.4.5; a plain `bun -e 'console.log(1)'` without sockat does the same). Node runs, and its connect uses relative.

## Where it departs from SPEC

- What only the routes not made (the table in [How a long path is reached](#how-a-long-path-is-reached)) reach is not reached
- **The listener of `bindEx` / `listenEx` too unlinks its spelling when closed** (SPEC: "the listener of `_ex` removes nothing when closed"; the runtimes give no way to stop it). Call `file.remove()` before closing it
- When `bindEx` / `listenEx` cannot record the file of a spelling handed to the standard library (the socket was replaced right after the bind, the cwd changed during the bind of a `CwdRelative` one, or the cwd is deeper than PATH_MAX), the listener is closed only where that is known to unlink the socket bound and nothing else; otherwise it is left open and `unref()`'d, and what replaced the socket, and the socket file bound, stay ([DR-0004](decisions/DR-0004-close-relative-listener-only-when-ours.md), Japanese). The standard library unlinks the spelling given when it closes (a relative one against the cwd at the close), so applying SPEC's "close" as it is would remove them
- The listener of a spelling handed to the standard library relative (`CwdRelative`) is unlinked by the standard library against the cwd at the close. Closed after the cwd has changed, it removes the file of the same name in the new cwd
- No DGRAM and no SEQPACKET (the standard libraries of Node and Bun have none)
- The errors of a spelling handed to the standard library (a short absolute path, an absolute candidate, a spelling handed over relative) are the standard library's (Node's listen says `EACCES` for a missing directory). A short relative path whose directory is missing has no candidate and is `ENOENT` as SPEC says (`route` is `null`). A long path's errors are SPEC's errno too (`ENOENT`)

## Specification and design

- [The sockat specification](https://github.com/kawaz/sockat/blob/main/docs/SPEC.md): the behaviour in every language (the operations, resolve, spelling properties, cleanup, what stays in the bases, the routes, what differs from the standard, patterns not to use, errors)
- [Notes per language](https://github.com/kawaz/sockat/blob/main/pages/langs.md): what is specific to each language's implementation
- [docs/decisions/](decisions/INDEX.md): the design decisions of the TypeScript version (DR, Japanese)
