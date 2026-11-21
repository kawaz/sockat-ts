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
import { bindExIn, connectAt, connectExIn } from "../src/netapi.ts";
import { resolveForBindIn } from "../src/resolve.ts";
import { world } from "./helpers.ts";

const Command = v.variant("op", [
  v.object({ op: v.literal("hold-resolve"), path: v.string() }),
  v.object({ op: v.literal("connect-ex"), path: v.string(), noProc: v.optional(v.boolean()) }),
  v.object({
    op: v.literal("connect-ex-chdir"),
    path: v.string(),
    chdirTo: v.string(),
    when: v.picklist(["before", "after"]),
    noProc: v.optional(v.boolean()),
  }),
  v.object({ op: v.literal("bind-ex-remove"), path: v.string(), look: v.array(v.string()) }),
  v.object({ op: v.literal("numeric"), name: v.string(), long: v.string() }),
]);

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
    const w = world(cmd.noProc === true ? { proc: "" } : {});
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
      print({ ...failure(e), connected });
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
  case "numeric": {
    // A relative path that node:net would read as a TCP port (name), bound
    // and connected in the cwd through node:net; and long, a relative path
    // whose "./" spelling is over the standard length.
    const w = world();
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
        const bun = await import("../src/bun.ts");
        const bl = bun.listen({ unix: cmd.name, socket: { data() {}, open(s) { s.end("bun"); } } });
        out["bunUnix"] = bl.unix;
        out["bunFile"] = kinds([cmd.name])[0];
        out["bunGot"] = await new Promise<string>((resolve, reject) => {
          bun.connect({ unix: cmd.name, socket: { data: (_s, d) => resolve(Buffer.from(d).toString()) } }).catch(reject);
        });
        bl.stop(true);
      }
      print(out);
    } catch (e) {
      print(failure(e));
    }
    break;
  }
}
process.exit(0);
