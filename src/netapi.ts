import net from "node:net";
import { bindSteps } from "./bind.ts";
import { connectSteps } from "./connect.ts";
import { type Attempted, beforeBind, boundOf, diagnosed, driveAsync } from "./drive.ts";
import { Trace } from "./errors.ts";
import { type FileId, sameId } from "./fsx.ts";
import { cwdId, forNodeNet } from "./route.ts";
import type { Bound, Connected, Options } from "./types.ts";
import type { World } from "./world.ts";

// The node:net side of the public API, on a given world (the tests hand
// their own to force each route). Every spelling node:net is handed went
// through forNodeNet, so none is read as a TCP port.

/** Listens on spelling with a new net.Server, once it is listening or has failed. */
export function listenAt(spelling: string): Promise<Attempted<net.Server>> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const onError = (error: Error): void => resolve({ ok: false, error });
    server.once("error", onError);
    // node:net binds within listen() (the server listens when it returns);
    // the cwd the same before and after it is the cwd the bind went to.
    const cwd = cwdId();
    let bindCwd: FileId | null = null;
    server.listen(spelling, () => {
      server.off("error", onError);
      resolve({ ok: true, socket: server, close: () => server.close(), bindCwd });
    });
    const after = cwdId();
    bindCwd = server.listening && cwd !== null && after !== null && sameId(cwd, after) ? cwd : null;
  });
}

/** Connects to spelling with a new net.Socket (as a path, never a port), once it is connected or has failed. */
export function connectAt(spelling: string): Promise<Attempted<net.Socket>> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: spelling });
    const onError = (error: Error): void => resolve({ ok: false, error });
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve({ ok: true, socket, close: () => socket.destroy(), bindCwd: null });
    });
  });
}

/**
 * The listener's address() returns what the standard's returns, with shown
 * in place of the spelling the kernel keeps (DR-0002) when they differ:
 * shown while it listens (the path given when absolute, the absolute form
 * of a relative one; SPEC "相対パスを絶対パスにする"); once closed, whatever
 * the standard gives then (Node keeps the name it listened on, Bun's
 * node:net gives null), never the spelling.
 */
function showPath(server: net.Server, shown: string, spelt: string): void {
  if (spelt !== shown) {
    const standard = server.address.bind(server);
    server.address = () => {
      const a = standard();
      return a === spelt ? shown : a;
    };
  }
}

export async function bindIn(w: World, path: string): Promise<net.Server> {
  const { result, socket } = await driveAsync(bindSteps(w, path, {}, new Trace(), "listen", forNodeNet, true), listenAt);
  showPath(socket, result.shown, result.spelt);
  return socket;
}

export async function connectIn(w: World, path: string): Promise<net.Socket> {
  const { socket } = await driveAsync(connectSteps(w, path, {}, new Trace(), "connect", forNodeNet), connectAt);
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
    const { result, socket, bindCwd } = await driveAsync(bindSteps(w, path, options, trace, "listen", forNodeNet, false), at);
    showPath(socket, result.shown, result.spelt);
    return boundOf(path, before, result, socket, bindCwd, { close: () => socket.close(), unref: () => socket.unref() }, trace);
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
    const { result, socket } = await driveAsync(connectSteps(w, path, options, trace, "connect", forNodeNet), at);
    return { socket, route: result.route, skipped: [...trace.skipped] };
  } catch (e) {
    throw diagnosed(e, trace);
  }
}
