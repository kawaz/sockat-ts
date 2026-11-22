/// <reference types="bun" preserve="true" />
import { bindSteps } from "./bind.ts";
import { connectSteps } from "./connect.ts";
import { type Attempted, beforeBind, boundOf, diagnosed, driveAsync, driveSync } from "./drive.ts";
import { asError, Trace } from "./errors.ts";
import { sameId } from "./fsx.ts";
import { asItIs, cwdId } from "./route.ts";
import type { Bound, Connected, Options } from "./types.ts";
import type { World } from "./world.ts";

// The Bun.listen / Bun.connect side of the public API, on a given world (the
// tests hand their own to force each route).

/** Bun.listen with options at spelling. */
function listenAt<Data>(options: Bun.UnixSocketOptions<Data>): (spelling: string) => Attempted<Bun.UnixSocketListener<Data>> {
  return (spelling) => {
    try {
      // Bun.listen binds before it returns: the cwd the same before and
      // after it is the cwd the bind went to.
      const cwd = cwdId();
      const listener = Bun.listen({ ...options, unix: spelling });
      const after = cwdId();
      const bindCwd = cwd !== null && after !== null && sameId(cwd, after) ? cwd : null;
      return { ok: true, socket: listener, close: () => listener.stop(true), bindCwd };
    } catch (e) {
      return { ok: false, error: asError(e) };
    }
  };
}

/** Bun.connect with options to spelling. */
function connectAt<Data>(options: Bun.UnixSocketOptions<Data>): (spelling: string) => Promise<Attempted<Bun.Socket<Data>>> {
  return (spelling) =>
    Bun.connect({ ...options, unix: spelling }).then(
      (socket): Attempted<Bun.Socket<Data>> => ({ ok: true, socket, close: () => socket.terminate(), bindCwd: null }),
      (e: unknown): Attempted<Bun.Socket<Data>> => ({ ok: false, error: asError(e) }),
    );
}

/**
 * The listener's `unix` is shown (the path given when absolute, the
 * absolute form of a relative one; SPEC "相対パスを絶対パスにする"), not the
 * spelling the kernel keeps (DR-0002), when they differ. Bun's own listener
 * keeps returning the path it was given after stop(), and so does this one.
 * Bun's stop() still unlinks the spelling.
 */
function showPath<Data>(listener: Bun.UnixSocketListener<Data>, shown: string, spelt: string): void {
  if (spelt !== shown) {
    Object.defineProperty(listener, "unix", { value: shown, configurable: true, enumerable: true });
  }
}

/**
 * Throws at once where `@kawaz/sockat/bun` is used without Bun, before
 * anything is made in the places.
 */
export function requireBun(): void {
  if (typeof Bun === "undefined") {
    throw new Error("@kawaz/sockat/bun needs Bun (Bun.listen / Bun.connect); with Node, use @kawaz/sockat");
  }
}

export function listenIn<Data>(w: World, options: Bun.UnixSocketOptions<Data>): Bun.UnixSocketListener<Data> {
  const { result, socket } = driveSync(bindSteps(w, options.unix, {}, new Trace(), "listen", asItIs, true), listenAt(options));
  showPath(socket, result.shown, result.spelt);
  return socket;
}

export function listenExIn<Data>(w: World, options: Bun.UnixSocketOptions<Data>, sockatOptions: Options): Bound<Bun.UnixSocketListener<Data>> {
  const trace = new Trace();
  const path = options.unix;
  try {
    const before = beforeBind(path);
    const { result, socket, bindCwd } = driveSync(bindSteps(w, path, sockatOptions, trace, "listen", asItIs, false), listenAt(options));
    showPath(socket, result.shown, result.spelt);
    return boundOf(path, before, result, socket, bindCwd, { close: () => socket.stop(true), unref: () => socket.unref() }, trace);
  } catch (e) {
    throw diagnosed(e, trace);
  }
}

export async function connectIn<Data>(w: World, options: Bun.UnixSocketOptions<Data>): Promise<Bun.Socket<Data>> {
  const { socket } = await driveAsync(connectSteps(w, options.unix, {}, new Trace(), "connect", asItIs), connectAt(options));
  return socket;
}

export async function connectExIn<Data>(
  w: World,
  options: Bun.UnixSocketOptions<Data>,
  sockatOptions: Options,
): Promise<Connected<Bun.Socket<Data>>> {
  const trace = new Trace();
  try {
    const { result, socket } = await driveAsync(connectSteps(w, options.unix, sockatOptions, trace, "connect", asItIs), connectAt(options));
    return { socket, route: result.route, skipped: [...trace.skipped] };
  } catch (e) {
    throw diagnosed(e, trace);
  }
}
