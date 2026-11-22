// The child process of the tests (helpers.ts child()): one command from
// argv, run in the cwd it was started in, on its parent's place for B; the
// result printed as one JSON line. A command that holds what it made (its D
// and its lock, a listener) keeps the process alive until stdin ends.
//
// What changes the process's cwd, or binds a relative path in it, runs here,
// not in the test process.

import fs from "node:fs";
import net from "node:net";
import * as v from "valibot";
import { errnoCode } from "../src/errors.ts";
import { bindExIn, bindIn, connectAt, connectExIn, listenAt } from "../src/netapi.ts";
import { resolveForBindIn, resolveForConnectIn } from "../src/resolve.ts";
import { world } from "./helpers.ts";

const Command = v.variant("op", [
  v.object({ op: v.literal("hold-resolve"), path: v.string() }),
  v.object({ op: v.literal("connect-ex"), path: v.string(), noProc: v.optional(v.boolean()), noPlace: v.optional(v.boolean()) }),
  v.object({
    op: v.literal("connect-ex-chdir"),
    path: v.string(),
    chdirTo: v.string(),
    when: v.picklist(["before", "after"]),
    noProc: v.optional(v.boolean()),
  }),
  v.object({ op: v.literal("bind-ex-remove"), path: v.string(), look: v.array(v.string()) }),
  v.object({
    op: v.literal("bind-ex-chdir"),
    path: v.string(),
    chdirTo: v.string(),
    when: v.picklist(["before", "after"]),
    look: v.array(v.string()),
    bare: v.optional(v.boolean()),
  }),
  v.object({ op: v.literal("numeric"), name: v.string(), long: v.string(), bare: v.optional(v.boolean()) }),
  v.object({
    op: v.literal("bind-rel"),
    path: v.string(),
    pwd: v.optional(v.string()),
    bare: v.optional(v.boolean()),
    chdirTo: v.optional(v.string()),
    look: v.optional(v.array(v.string()), []),
  }),
  v.object({ op: v.literal("resolve-rel"), path: v.string(), pwd: v.optional(v.string()), bare: v.optional(v.boolean()) }),
  v.object({ op: v.literal("deep-cwd") }),
]);

/**
 * The tests' world, with $PWD as given (none when not) and, when bare, no
 * route that can be used: no place for B and no /proc (so no B in the
 * socket's directory can be spelt short either).
 */
function relWorld(pwd: string | undefined, bare: boolean | undefined): ReturnType<typeof world> {
  return world({
    getenv: (n) => (n === "PWD" ? pwd : undefined),
    ...(bare === true ? { tmp: "/nonexistent-stt-place", proc: "" } : {}),
  });
}

/** The names of the routes skipped, from a result or an error. */
function skippedOf(x: unknown): unknown[] {
  return typeof x === "object" && x !== null && "skipped" in x && Array.isArray(x.skipped)
    ? x.skipped.map((s: unknown) => (typeof s === "object" && s !== null && "name" in s ? s.name : null))
    : [];
}

/** The route of an error (null for none). */
function routeOf(x: unknown): unknown {
  return typeof x === "object" && x !== null && "route" in x ? x.route : null;
}

function print(out: unknown): void {
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function untilStdinEnds(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => resolve());
  });
}

function failure(e: unknown): { ok: false; code: string | null; message: string } {
  return { ok: false, code: errnoCode(e) ?? null, message: e instanceof Error ? e.message : String(e) };
}

/** What is at each path: socket, file, or nothing ("-"). */
function kinds(paths: string[]): string[] {
  return paths.map((p) => {
    try {
      return fs.lstatSync(p).isSocket() ? "socket" : "file";
    } catch {
      return "-";
    }
  });
}

/** Sends x on socket and resolves with what comes back. */
function reply(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (b) => {
      socket.destroy();
      resolve(b.toString());
    });
    socket.write("x");
  });
}

const cmd = v.parse(Command, JSON.parse(process.argv[2] ?? "null"));
switch (cmd.op) {
  case "hold-resolve": {
    const w = world();
    try {
      const f = resolveForBindIn(w, cmd.path, {});
      print({ ok: true, spelt: f.path, d: w.auto?.d?.name ?? null });
    } catch (e) {
      print(failure(e));
    }
    await untilStdinEnds();
    break;
  }
  case "connect-ex":
  case "connect-ex-chdir": {
    const noPlace = cmd.op === "connect-ex" && cmd.noPlace === true;
    const w = world({
      ...(cmd.noProc === true ? { proc: "" } : {}),
      // No place for B at all: /tmp, $XDG_RUNTIME_DIR and $TMPDIR are gone.
      ...(noPlace ? { tmp: "/nonexistent-stt-place" } : {}),
    });
    const to = cmd.op === "connect-ex-chdir" ? cmd.chdirTo : null;
    const after = cmd.op === "connect-ex-chdir" && cmd.when === "after";
    let connected = false;
    try {
      const c = await connectExIn(w, cmd.path, {}, async (spelling) => {
        if (to !== null && !after) {
          process.chdir(to);
        }
        const a = await connectAt(spelling);
        connected = a.ok;
        if (to !== null && after) {
          process.chdir(to);
        }
        return a;
      });
      c.socket.destroy();
      print({ ok: true, route: c.route, skipped: c.skipped.map((s) => s.name) });
    } catch (e) {
      print({ ...failure(e), connected, skipped: e instanceof Error && "skipped" in e && Array.isArray(e.skipped) ? e.skipped.map((s: unknown) => (typeof s === "object" && s !== null && "name" in s ? s.name : null)) : [] });
    }
    break;
  }
  case "bind-ex-remove": {
    // Binds the (relative) path in the cwd, then removes it: what is at each
    // path to look at after the bind and after the remove.
    try {
      const b = await bindExIn(world(), cmd.path, {});
      const bound = kinds(cmd.look);
      b.file.remove();
      const removed = kinds(cmd.look);
      b.socket.close();
      print({ ok: true, route: b.route, bound, removed });
    } catch (e) {
      print(failure(e));
    }
    break;
  }
  case "bind-ex-chdir": {
    // bindEx of a relative path whose cwd changes just before, or just
    // after, the bind: what is at each path to look at afterwards.
    try {
      const b = await bindExIn(relWorld(undefined, cmd.bare), cmd.path, {}, async (spelling) => {
        if (cmd.when === "before") {
          process.chdir(cmd.chdirTo);
        }
        const a = await listenAt(spelling);
        if (cmd.when === "after") {
          process.chdir(cmd.chdirTo);
        }
        return a;
      });
      b.socket.close();
      print({ ok: true, look: kinds(cmd.look) });
    } catch (e) {
      print({ ...failure(e), look: kinds(cmd.look) });
    }
    break;
  }
  case "numeric": {
    // A relative path that node:net would read as a TCP port (name), bound
    // and connected in the cwd through node:net; and long, a relative path
    // whose "./" spelling is over the standard length.
    const w = relWorld(undefined, cmd.bare);
    try {
      const b = await bindExIn(w, cmd.name, {});
      b.socket.on("connection", (s) => s.end("unix"));
      const c = await connectExIn(w, cmd.name, {});
      const got = await reply(c.socket);
      const out: Record<string, unknown> = {
        ok: true,
        route: b.route,
        spelling: b.spelling.kind,
        address: b.socket.address(),
        file: kinds([cmd.name])[0],
        connectRoute: c.route,
        got,
      };
      b.file.remove();
      b.socket.close();
      try {
        const l = await bindExIn(w, cmd.long, {});
        out["longRoute"] = l.route;
        out["longSkipped"] = l.skipped.map((s) => s.name);
        out["longFile"] = kinds([cmd.long])[0];
        l.file.remove();
        l.socket.close();
      } catch (e) {
        const skipped: unknown[] = e instanceof Error && "skipped" in e && Array.isArray(e.skipped) ? e.skipped : [];
        out["longRoute"] = null;
        out["longSkipped"] = skipped.map((s) => (typeof s === "object" && s !== null && "name" in s ? s.name : null));
        out["longFile"] = kinds([cmd.long])[0];
      }
      if (typeof Bun !== "undefined") {
        const bun = await import("../src/bunapi.ts");
        const bl = bun.listenIn(w, { unix: cmd.name, socket: { data() {}, open(s) { s.end("bun"); } } });
        out["bunUnix"] = bl.unix;
        out["bunFile"] = kinds([cmd.name])[0];
        out["bunGot"] = await new Promise<string>((resolve, reject) => {
          bun.connectIn(w, { unix: cmd.name, socket: { data: (_s, d) => resolve(Buffer.from(d).toString()) } }).catch(reject);
        });
        bl.stop(true);
      }
      print(out);
    } catch (e) {
      print(failure(e));
    }
    break;
  }
  case "bind-rel": {
    // bindEx of a (relative) path in the cwd, with $PWD as given: what the
    // standard was handed (in order), what the result says, and the
    // listener's address. Then, after an optional chdir, what is at each
    // path to look at after remove() and after closing the listener. On
    // Bun, listenEx of the same path in the same way afterwards.
    const w = relWorld(cmd.pwd, cmd.bare);
    const spellings: string[] = [];
    let out: Record<string, unknown>;
    try {
      const b = await bindExIn(w, cmd.path, {}, (spelling) => {
        spellings.push(spelling);
        return listenAt(spelling);
      });
      out = {
        ok: true,
        route: b.route,
        spelling: b.spelling,
        skipped: skippedOf(b),
        address: b.socket.address(),
        spellings,
        bound: kinds(cmd.look),
      };
      if (cmd.chdirTo !== undefined) {
        process.chdir(cmd.chdirTo);
      }
      b.file.remove();
      out["removed"] = kinds(cmd.look);
      await new Promise<void>((resolve) => b.socket.close(() => resolve()));
      out["closed"] = kinds(cmd.look);
    } catch (e) {
      out = { ...failure(e), route: routeOf(e), skipped: skippedOf(e), spellings, look: kinds(cmd.look) };
    }
    if (typeof Bun !== "undefined" && out["ok"] === true && cmd.chdirTo === undefined) {
      const bun = await import("../src/bunapi.ts");
      const l = bun.listenExIn(w, { unix: cmd.path, socket: { data() {} } }, {});
      out["bunUnix"] = l.socket.unix;
      out["bunSpelling"] = l.spelling;
      l.file.remove();
      l.socket.stop(true);
    }
    print(out);
    break;
  }
  case "resolve-rel": {
    // resolveForBind and resolveForConnect of a (relative) path in the cwd.
    const w = relWorld(cmd.pwd, cmd.bare);
    const one = (f: () => { path: string; spelling: unknown; route: string; skipped: unknown[]; cleanup: () => void }): unknown => {
      try {
        const r = f();
        r.cleanup();
        return { ok: true, path: r.path, spelling: r.spelling, route: r.route, skipped: skippedOf(r) };
      } catch (e) {
        return { ...failure(e), route: routeOf(e), skipped: skippedOf(e) };
      }
    };
    print({
      bind: one(() => resolveForBindIn(w, cmd.path, {})),
      connect: one(() => resolveForConnectIn(w, cmd.path, {})),
    });
    break;
  }
  case "deep-cwd": {
    // Started in a cwd deeper than PATH_MAX (made by a shell with relative
    // mkdir and cd: Bun's mkdirSync of a relative path fails there, ERANGE
    // from getcwd), $PWD its spelling: the default bind, bindEx and the
    // resolves of a short relative path, and of one over the standard
    // length. The shell removes what is left.
    const w = world({ getenv: (n) => (n === "PWD" ? process.env["PWD"] : undefined) });
    const out: Record<string, unknown> = {};
    try {
      const s = await bindIn(w, "s.sock");
      out["bind"] = { ok: true, address: s.address(), file: kinds(["s.sock"])[0] };
      await new Promise<void>((resolve) => s.close(() => resolve()));
    } catch (e) {
      out["bind"] = failure(e);
    }
    try {
      const b = await bindExIn(w, "x.sock", {});
      out["bindEx"] = { ok: true, route: b.route };
      b.socket.close();
    } catch (e) {
      out["bindEx"] = { ...failure(e), file: kinds(["x.sock"])[0] };
    }
    const resolved = (path: string): unknown => {
      try {
        const f = resolveForBindIn(w, path, {});
        return { ok: true, path: f.path, spelling: f.spelling, route: f.route, skipped: skippedOf(f) };
      } catch (e) {
        return { ...failure(e), route: routeOf(e), skipped: skippedOf(e) };
      }
    };
    out["resolve"] = resolved("r.sock");
    out["long"] = resolved("n".repeat(w.cfg.standardLength + 1));
    print(out);
    break;
  }
}
process.exit(0);
