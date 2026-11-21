/// <reference types="bun" preserve="true" />
/**
 * sockat for Bun's own sockets: `Bun.listen` / `Bun.connect` with a `unix`
 * path longer than sun_path. Takes the options `Bun.listen` / `Bun.connect`
 * take; `unix` may be long.
 *
 * The behaviour is the language-independent specification's:
 * https://github.com/kawaz/sockat/blob/main/docs/SPEC.md
 *
 * @module
 */
import { connectExIn, connectIn, listenExIn, listenIn } from "./bunapi.ts";
import type { Bound, Connected, Options } from "./types.ts";
import { defaultWorld } from "./world.ts";

export type { Bound, Connected, Options, Skip, SocketFile, Spelling } from "./types.ts";
export type { RouteDiagnostics, SystemError } from "./errors.ts";

/**
 * `Bun.listen(options)` for a `unix` path of any length: synchronous, as
 * Bun.listen is. The listener's `unix` is the path given. Stopping it
 * unlinks the spelling the kernel keeps: for a long path through a symlink
 * to the socket file (Spelling `Linked` with `removable: false`), that
 * removes the symlink and leaves the socket file.
 */
export function listen<Data = undefined>(options: Bun.UnixSocketOptions<Data>): Bun.UnixSocketListener<Data> {
  return listenIn(defaultWorld(), options);
}

/** `Bun.connect(options)` for a `unix` path of any length. */
export function connect<Data = undefined>(options: Bun.UnixSocketOptions<Data>): Promise<Bun.Socket<Data>> {
  return connectIn(defaultWorld(), options);
}

/**
 * listen, with what the spelling is good for, how to remove the socket file
 * (`file.remove()`), and diagnostics. The error carries `route` and
 * `skipped`.
 *
 * Unlike the specification, stopping the listener unlinks the spelling (Bun
 * gives no way to stop it): call `file.remove()` before stopping it.
 */
export function listenEx<Data = undefined>(
  options: Bun.UnixSocketOptions<Data>,
  sockatOptions: Options = {},
): Bound<Bun.UnixSocketListener<Data>> {
  return listenExIn(defaultWorld(), options, sockatOptions);
}

/** connect, with diagnostics. The error carries `route` and `skipped`. */
export function connectEx<Data = undefined>(
  options: Bun.UnixSocketOptions<Data>,
  sockatOptions: Options = {},
): Promise<Connected<Bun.Socket<Data>>> {
  return connectExIn(defaultWorld(), options, sockatOptions);
}
