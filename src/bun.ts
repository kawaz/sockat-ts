/// <reference types="bun" />
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
import { bindSteps } from "./bind.ts";
import { connectSteps } from "./connect.ts";
import { type Attempted, beforeBind, boundOf, diagnosed, driveAsync, driveSync } from "./drive.ts";
import { asError, Trace } from "./errors.ts";
import type { Bound, Connected, Options } from "./types.ts";
import { defaultWorld, type World } from "./world.ts";

export type { Bound, Connected, Options, Skip, SocketFile, Spelling } from "./types.ts";
export type { RouteDiagnostics, SystemError } from "./errors.ts";

/** Bun.listen with options at spelling. */
function listenAt<Data>(options: Bun.UnixSocketOptions<Data>): (spelling: string) => Attempted<Bun.UnixSocketListener<Data>> {
  return (spelling) => {
    try {
      const listener = Bun.listen({ ...options, unix: spelling });
      return { ok: true, socket: listener, close: () => listener.stop(true) };
    } catch (e) {
      return { ok: false, error: asError(e) };
    }
  };
}

/** Bun.connect with options to spelling. */
function connectAt<Data>(options: Bun.UnixSocketOptions<Data>): (spelling: string) => Promise<Attempted<Bun.Socket<Data>>> {
  return (spelling) =>
    Bun.connect({ ...options, unix: spelling }).then(
      (socket): Attempted<Bun.Socket<Data>> => ({ ok: true, socket, close: () => socket.terminate() }),
      (e: unknown): Attempted<Bun.Socket<Data>> => ({ ok: false, error: asError(e) }),
    );
}

/**
 * The listener's `unix` is the caller's path, not the spelling the kernel
 * keeps (DR-0002), when they differ. Bun's stop() still unlinks the spelling.
 */
function showPath<Data>(listener: Bun.UnixSocketListener<Data>, path: string, spelt: string): void {
  if (spelt !== path) {
    Object.defineProperty(listener, "unix", { value: path, configurable: true, enumerable: true });
  }
}

export function listenIn<Data>(w: World, options: Bun.UnixSocketOptions<Data>): Bun.UnixSocketListener<Data> {
  const { result, socket } = driveSync(bindSteps(w, options.unix, {}, new Trace(), "listen"), listenAt(options));
  showPath(socket, options.unix, result.spelt);
  return socket;
}

export function listenExIn<Data>(w: World, options: Bun.UnixSocketOptions<Data>, sockatOptions: Options): Bound<Bun.UnixSocketListener<Data>> {
  const trace = new Trace();
  const path = options.unix;
  try {
    const before = beforeBind(path, w.cfg.os === "linux" && path.startsWith("\0"));
    const { result, socket } = driveSync(bindSteps(w, path, sockatOptions, trace, "listen"), listenAt(options));
    showPath(socket, path, result.spelt);
    return boundOf(path, before, result, socket, () => socket.stop(true), trace);
  } catch (e) {
    throw diagnosed(e, trace);
  }
}

export async function connectIn<Data>(w: World, options: Bun.UnixSocketOptions<Data>): Promise<Bun.Socket<Data>> {
  const { socket } = await driveAsync(connectSteps(w, options.unix, {}, new Trace(), "connect"), connectAt(options));
  return socket;
}

export async function connectExIn<Data>(
  w: World,
  options: Bun.UnixSocketOptions<Data>,
  sockatOptions: Options,
): Promise<Connected<Bun.Socket<Data>>> {
  const trace = new Trace();
  try {
    const { result, socket } = await driveAsync(connectSteps(w, options.unix, sockatOptions, trace, "connect"), connectAt(options));
    return { socket, route: result.route, skipped: [...trace.skipped] };
  } catch (e) {
    throw diagnosed(e, trace);
  }
}

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
