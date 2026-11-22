import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { type Config, envConfig } from "../src/config.ts";
import { setDefaultWorld, World } from "../src/world.ts";

// What the tests share: a place of their own for B instead of the real /tmp
// (so the tests never use nor remove the B other processes of the user share
// there, /tmp/sockat-<uid>), worlds on it, temporary directories, and a
// child process to run what changes the process's cwd.
//
// Temporary directories are named stt-*, never sockat*: the hub's
// conformance script and other tools take a sockat* directory in /tmp for a
// B and may remove what is in it.

const made: string[] = [];

process.on("exit", () => {
  for (const d of made.toReversed()) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A fresh directory in prefixDir, removed with everything in it when the process exits. */
function freshDir(prefixDir: string): string {
  const d = fs.mkdtempSync(nodePath.join(prefixDir, "stt-"));
  made.push(d);
  return d;
}

/**
 * A fresh directory under $TMPDIR (the session's), for the long paths: its
 * real path, so that a path in it is not shorter as a real path (the binds
 * try the real path before the routes) than it looks.
 */
export function tempDir(): string {
  return fs.realpathSync(freshDir(process.env["TMPDIR"] ?? os.tmpdir()));
}

/** A fresh directory under /tmp, for a path that must be short. */
export function shortDir(): string {
  return freshDir("/tmp");
}

/**
 * The place the tests make B in, standing in for /tmp: a fresh directory
 * under /tmp of mode 1777, as /tmp is. One per process; a child process of
 * the tests is handed its parent's (STT_PLACE) so they share one B, as the
 * processes of a user do.
 */
export const place: string = (() => {
  const inherited = process.env["STT_PLACE"];
  if (inherited !== undefined && inherited !== "") {
    return inherited;
  }
  const d = shortDir();
  fs.chmodSync(d, 0o1777);
  process.env["STT_PLACE"] = d;
  return d;
})();

/** The process's configuration with the tests' place as /tmp and no $XDG_RUNTIME_DIR or $TMPDIR. */
export function testConfig(over: Partial<Config> = {}): Config {
  return { ...envConfig(), tmp: place, getenv: () => undefined, ...over };
}

/** A world of its own on the tests' place (its own B fds and D). */
export function world(over: Partial<Config> = {}): World {
  return new World(testConfig(over));
}

// The public API's calls go to the tests' place.
setDefaultWorld(world());

/**
 * A directory under root whose path is at least min bytes long: deep enough
 * for the path of a socket in it to be over every standard length, with
 * components short enough for every system.
 */
export function deepDir(root: string, min = 150): string {
  let d = root;
  let i = 0;
  while (Buffer.byteLength(d) < min) {
    d = nodePath.join(d, `d${i++}${"x".repeat(40)}`);
  }
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A path of exactly len bytes: a socket name in a directory under root (whose path is shorter). */
export function pathOfLength(root: string, len: number): string {
  let dir = root;
  let i = 0;
  while (len - Buffer.byteLength(dir) - 1 > 60) {
    dir = nodePath.join(dir, `e${i++}${"y".repeat(30)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const name = "s".repeat(len - Buffer.byteLength(dir) - 1);
  return `${dir}/${name}`;
}

/** Echoes back what each connection sends. */
export function echo(server: net.Server): void {
  server.on("connection", (s) => {
    s.on("data", (b) => s.write(b));
    s.on("error", () => {});
  });
}

/** Writes x to socket and resolves with what comes back. */
export function roundTrip(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("data", (b) => {
      socket.destroy();
      resolve(b.toString());
    });
    socket.once("error", reject);
    socket.write("x");
  });
}

/** What a socket reports of its addresses (none of which may throw). */
export function addressesOf(s: net.Socket): unknown[] {
  return [s.address(), s.remoteAddress, s.localAddress];
}

/** Closes a server and waits for it. */
export function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Listens on path with the standard itself (for the peer of a connect test). */
export function standardListen(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    echo(s);
    s.once("error", reject);
    s.listen(path, () => resolve(s));
  });
}

/** What is in dir (not following symlinks), as "name" / "name/" / "name -> target", sorted. */
export function listing(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .map((n) => {
      const p = nodePath.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        return `${n} -> ${fs.readlinkSync(p)}`;
      }
      return st.isDirectory() ? `${n}/` : n;
    })
    .toSorted();
}

/** The B of the tests' place (its real path), where the auto B is made. */
export function placeB(): string {
  return nodePath.join(fs.realpathSync(place), `sockat-${process.geteuid?.() ?? 0}`);
}

/** The symlinks in every D of the B at b. */
export function linksInB(b: string): string[] {
  return listing(b)
    .filter((e) => e.endsWith("/"))
    .flatMap((d) => listing(nodePath.join(b, d)).map((e) => `${d}${e}`));
}

/** A caught error, with its own fields (code, route, skipped, ...) to look at. */
export interface Caught {
  readonly error: Error;
  readonly [field: string]: unknown;
}

function caught(e: unknown): Caught {
  if (!(e instanceof Error)) {
    throw new Error(`caught a non-Error: ${String(e)}`);
  }
  return { ...Object.fromEntries(Object.entries(e)), error: e };
}

/** The error a promise rejected with (failing when it resolved). */
export async function rejection(p: Promise<unknown>): Promise<Caught> {
  try {
    await p;
  } catch (e) {
    return caught(e);
  }
  throw new Error("expected a rejection, but it resolved");
}

/** The error f throws (failing when it returns). */
export function thrown(f: () => unknown): Caught {
  try {
    f();
  } catch (e) {
    return caught(e);
  }
  throw new Error("expected a throw, but it returned");
}

/** The names of the skipped routes in a caught error. */
export function skippedNames(c: Caught): unknown {
  const s = c["skipped"];
  return Array.isArray(s) ? s.map((x: unknown) => (typeof x === "object" && x !== null && "name" in x ? x.name : x)) : s;
}

/** The runtime running the tests: a child process runs on the same one. */
export const runtime = process.execPath;

/** The path of the child process's script. */
const childScript = nodePath.join(import.meta.dirname, "child.ts");

/**
 * Runs test/child.ts with the command given, in cwd, on the tests' place.
 * Resolves with the JSON line it prints; a long-lived command (hold) is
 * resolved once its first line is out, with a function that ends it.
 */
export function child(command: Record<string, unknown>, cwd: string): Promise<{ out: unknown; end: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const p = spawn(runtime, [childScript, JSON.stringify(command)], {
      cwd,
      env: { ...process.env, STT_PLACE: place },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    let done = false;
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    p.stdout.on("data", (b: Buffer) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (!done && nl >= 0) {
        done = true;
        const line = buf.slice(0, nl);
        resolve({
          out: JSON.parse(line),
          end: async () => {
            p.stdin.end();
            await exited;
          },
        });
      }
    });
    p.once("exit", (code) => {
      if (!done) {
        reject(new Error(`child exited ${code} without output`));
      }
    });
  });
}
