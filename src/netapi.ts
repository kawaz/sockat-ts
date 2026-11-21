import net from "node:net";
import { bindSteps } from "./bind.ts";
import { connectSteps } from "./connect.ts";
import { type Attempted, beforeBind, boundOf, diagnosed, driveAsync } from "./drive.ts";
import { Trace } from "./errors.ts";
import type { Bound, Connected, Options } from "./types.ts";
import type { World } from "./world.ts";

// The node:net side of the public API, on a given world (the tests hand
// their own to force each route).

/** Listens on spelling with a new net.Server, once it is listening or has failed. */
export function listenAt(spelling: string): Promise<Attempted<net.Server>> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const onError = (error: Error): void => resolve({ ok: false, error });
    server.once("error", onError);
    server.listen(spelling, () => {
      server.off("error", onError);
      resolve({ ok: true, socket: server, close: () => server.close() });
    });
  });
}

/** Connects to spelling with a new net.Socket, once it is connected or has failed. */
export function connectAt(spelling: string): Promise<Attempted<net.Socket>> {
  return new Promise((resolve) => {
    const socket = net.connect(spelling);
    const onError = (error: Error): void => resolve({ ok: false, error });
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve({ ok: true, socket, close: () => socket.destroy() });
    });
  });
}

/**
 * The listener's address() returns the caller's path, not the spelling the
 * kernel keeps (DR-0002), when they differ.
 */
function showPath(server: net.Server, path: string, spelt: string): void {
  if (spelt !== path) {
    server.address = () => path;
  }
}

export async function bindIn(w: World, path: string): Promise<net.Server> {
  const { result, socket } = await driveAsync(bindSteps(w, path, {}, new Trace(), "listen"), listenAt);
  showPath(socket, path, result.spelt);
  return socket;
}

export async function connectIn(w: World, path: string): Promise<net.Socket> {
  const { socket } = await driveAsync(connectSteps(w, path, {}, new Trace(), "connect"), connectAt);
  return socket;
}

export async function bindExIn(
  w: World,
  path: string,
  options: Options,
  at: (spelling: string) => Promise<Attempted<net.Server>> = listenAt,
): Promise<Bound<net.Server>> {
  const trace = new Trace();
  try {
    const before = beforeBind(path);
    const { result, socket } = await driveAsync(bindSteps(w, path, options, trace, "listen"), at);
    showPath(socket, path, result.spelt);
    return boundOf(path, before, result, socket, () => socket.close(), trace);
  } catch (e) {
    throw diagnosed(e, trace);
  }
}

export async function connectExIn(
  w: World,
  path: string,
  options: Options,
  at: (spelling: string) => Promise<Attempted<net.Socket>> = connectAt,
): Promise<Connected<net.Socket>> {
  const trace = new Trace();
  try {
    const { result, socket } = await driveAsync(connectSteps(w, path, options, trace, "connect"), at);
    return { socket, route: result.route, skipped: [...trace.skipped] };
  } catch (e) {
    throw diagnosed(e, trace);
  }
}
