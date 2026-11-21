/// <reference types="bun" preserve="true" />
import { bindSteps } from "./bind.ts";
import { connectSteps } from "./connect.ts";
import { type Attempted, beforeBind, boundOf, diagnosed, driveAsync, driveSync } from "./drive.ts";
import { asError, Trace } from "./errors.ts";
import type { Bound, Connected, Options } from "./types.ts";
import type { World } from "./world.ts";

// The Bun.listen / Bun.connect side of the public API, on a given world (the
// tests hand their own to force each route).

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
    const before = beforeBind(path);
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
