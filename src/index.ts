/**
 * sockat: bind and connect Unix domain sockets at paths longer than
 * sun_path, with node:net (Node and Bun). A path the standard takes as it is
 * goes to it unchanged; a longer one is spelt shorter through a directory
 * this user's processes share, or relative to the socket's directory, and
 * that spelling goes to the standard.
 *
 * The behaviour is the language-independent specification's:
 * https://github.com/kawaz/sockat/blob/main/docs/SPEC.md
 *
 * @module
 */
import type net from "node:net";
import { bindExIn, bindIn, connectExIn, connectIn } from "./netapi.ts";
import { resolveForBindIn, resolveForConnectIn } from "./resolve.ts";
import { sweepBaseIn, sweepIn } from "./sweep.ts";
import type { Bound, Connected, ForBind, ForConnect, Options } from "./types.ts";
import { defaultWorld } from "./world.ts";

export type { Bound, Connected, ForBind, ForConnect, Options, Skip, SocketFile, Spelling } from "./types.ts";
export type { RouteDiagnostics, SystemError } from "./errors.ts";

/**
 * Binds and listens at path, as `net.createServer().listen(path)` does,
 * and resolves once it is listening. A path the standard takes (at most
 * sun_path less one byte; 108 bytes for Node on Linux) goes to it as it is.
 *
 * The listener's `address()` returns `path`. Closing it unlinks the spelling
 * the kernel keeps: for a long path through a symlink to the socket file
 * (Spelling `Linked` with `removable: false`), that removes the symlink and
 * leaves the socket file.
 */
export function bind(path: string): Promise<net.Server> {
  return bindIn(defaultWorld(), path);
}

/**
 * Connects to path, as `net.connect(path)` does, and resolves once it is
 * connected.
 */
export function connect(path: string): Promise<net.Socket> {
  return connectIn(defaultWorld(), path);
}

/**
 * bind, with what the spelling is good for, how to remove the socket file
 * (`file.remove()`), and diagnostics. The error carries `route` and
 * `skipped`.
 *
 * Unlike the specification, closing the listener unlinks the spelling (the
 * runtimes give no way to stop it): call `file.remove()` before closing it.
 */
export function bindEx(path: string, options: Options = {}): Promise<Bound<net.Server>> {
  return bindExIn(defaultWorld(), path, options);
}

/** connect, with diagnostics. The error carries `route` and `skipped`. */
export function connectEx(path: string, options: Options = {}): Promise<Connected<net.Socket>> {
  return connectExIn(defaultWorld(), path, options);
}

/**
 * Spells path so that the standard can bind it (`net.Server.listen`,
 * `Bun.listen`, `Bun.serve({ unix })`, ...): path itself where the standard
 * takes it, otherwise a spelling naming the same place for as long as its
 * `spelling` says. Nothing is bound. ENAMETOOLONG where no spelling fits.
 */
export function resolveForBind(path: string, options: Options = {}): ForBind {
  return resolveForBindIn(defaultWorld(), path, options);
}

/**
 * Spells path so that the standard can connect to it (`net.connect`,
 * `fetch(url, { unix })`, ...), as many times as you like until `cleanup()`.
 * `usableCrossUid` is not looked at.
 */
export function resolveForConnect(path: string, options: Options = {}): ForConnect {
  return resolveForConnectIn(defaultWorld(), path, options);
}

/**
 * Removes the directories that processes which have ended left in this
 * user's sockat directories of /tmp, $XDG_RUNTIME_DIR and $TMPDIR. Never
 * called for you.
 */
export function sweep(): void {
  sweepIn(defaultWorld());
}

/** sweep for the directory given as `Options.base`, which the application that manages it sweeps. */
export function sweepBase(path: string): void {
  sweepBaseIn(defaultWorld(), path);
}
