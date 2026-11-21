// The child process of the tests (helpers.ts child()): one command from
// argv, run in the cwd it was started in, on its parent's place for B; the
// result printed as one JSON line. A command that holds what it made (its D
// and its lock, a listener) keeps the process alive until stdin ends.
//
// What changes the process's cwd runs here, not in the test process.

import fs from "node:fs";
import * as v from "valibot";
import { resolveForBindIn } from "../src/resolve.ts";
import { connectAt, connectExIn } from "../src/netapi.ts";
import { errnoCode } from "../src/errors.ts";
import { world } from "./helpers.ts";

const Command = v.variant("op", [
  v.object({ op: v.literal("hold-resolve"), path: v.string() }),
  v.object({ op: v.literal("connect-ex"), path: v.string(), noProc: v.optional(v.boolean()) }),
  v.object({ op: v.literal("connect-ex-chdir"), path: v.string(), chdirTo: v.string(), noProc: v.optional(v.boolean()) }),
  v.object({ op: v.literal("cwd") }),
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
    try {
      const c = await connectExIn(w, cmd.path, {}, (spelling) => {
        if (to !== null) {
          process.chdir(to);
        }
        return connectAt(spelling);
      });
      c.socket.destroy();
      print({ ok: true, route: c.route, skipped: c.skipped.map((s) => s.name) });
    } catch (e) {
      print(failure(e));
    }
    break;
  }
  case "cwd":
    print({ ok: true, cwd: process.cwd(), real: fs.realpathSync(".") });
    break;
}
process.exit(0);
