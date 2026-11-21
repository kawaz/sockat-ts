import assert from "node:assert/strict";
import fs from "node:fs";
import nodePath from "node:path";
import { describe, test } from "node:test";
import * as v from "valibot";
import { connect, connectEx } from "../src/index.ts";
import { connectExIn } from "../src/netapi.ts";
import {
  child,
  closeServer,
  deepDir,
  listing,
  placeB,
  rejection,
  roundTrip,
  shortDir,
  skippedNames,
  standardListen,
  tempDir,
  world,
} from "./helpers.ts";
import { bindEx } from "../src/index.ts";

const os = world().cfg.os;

/** What child.ts prints for a connect. */
const ConnectOut = v.union([
  v.object({ ok: v.literal(true), route: v.string(), skipped: v.array(v.string()) }),
  v.object({ ok: v.literal(false), code: v.nullable(v.string()), message: v.string() }),
]);

/** A listener at a long path under root (bound through sockat), echoing. */
async function longListener(root: string, name = "s.sock"): Promise<{ path: string; close: () => Promise<void> }> {
  const path = `${deepDir(root)}/${name}`;
  const b = await bindEx(path);
  b.socket.on("connection", (s) => {
    s.on("data", (d) => s.write(d));
    s.on("error", () => {});
  });
  return {
    path,
    close: async () => {
      b.file.remove();
      await closeServer(b.socket);
    },
  };
}

describe("connect", () => {
  // A short path goes to the standard as it is.
  test("a short path connects through the standard", async () => {
    const path = `${shortDir()}/s.sock`;
    const server = await standardListen(path);
    const c = await connectEx(path);
    assert.equal(c.route, "standard");
    assert.deepEqual(c.skipped, []);
    assert.equal(await roundTrip(c.socket), "x");
    await closeServer(server);
  });

  // SPEC "connect の順": the first route that needs no writing (proc-direct
  // on Linux, relative elsewhere when the cwd is near), else link-file. The
  // connect reaches the socket and leaves nothing in B (the default connect
  // makes no D and unlinks its E right after).
  test("a long path connects and leaves nothing in B", async () => {
    const l = await longListener(tempDir());
    const before = listing(placeB());
    const c = await connectEx(l.path);
    assert.ok(os === "linux" ? c.route === "proc-direct" : ["relative", "link-file"].includes(c.route), c.route);
    assert.equal(c.skipped[0]?.name, "standard");
    assert.equal(await roundTrip(c.socket), "x");
    assert.deepEqual(listing(placeB()), before);
    await l.close();
  });

  // link-file, forced: no /proc, and a path far from the cwd so no relative
  // spelling fits. It goes through an E right in B, removed right after the
  // connect, so B holds nothing new; the routes not made (DR-0002) are in
  // skipped with the others of the system's row.
  test("link-file connects through an E in B that is gone right after", async () => {
    const w = world({ proc: "" });
    const l = await longListener(shortDir());
    const before = listing(placeB());
    const c = await connectExIn(w, l.path, {});
    assert.equal(c.route, "link-file");
    const rows: Record<string, string[]> = {
      linux: ["standard", "relative", "thread-cwd-direct"],
      darwin: ["standard", "relative", "widened", "thread-cwd-direct"],
      freebsd: ["standard", "at-direct"],
    };
    assert.deepEqual(
      c.skipped.map((s) => s.name),
      rows[os] ?? ["standard", "relative"],
    );
    assert.equal(await roundTrip(c.socket), "x");
    assert.deepEqual(listing(placeB()), before);
    await l.close();
  });

  // relative, forced from a child process whose cwd is the socket's
  // directory's parent (no /proc on Linux, so the row is relative's): the
  // path relative to the cwd fits and reaches the socket.
  test("relative connects through the path relative to the cwd", async () => {
    const l = await longListener(tempDir());
    const r = await child({ op: "connect-ex", path: l.path, noProc: true }, nodePath.dirname(nodePath.dirname(l.path)));
    const out = v.parse(ConnectOut, r.out);
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.route, "relative");
    await r.end();
    await l.close();
  });

  // SPEC "relative と cwd": a cwd changed while connecting through a
  // relative spelling is a general error (no errno), the result discarded.
  test("relative with the cwd changed meanwhile is a general error", async () => {
    const l = await longListener(tempDir());
    const r = await child(
      { op: "connect-ex-chdir", path: l.path, chdirTo: "/", noProc: true },
      nodePath.dirname(nodePath.dirname(l.path)),
    );
    const out = v.parse(ConnectOut, r.out);
    assert.ok(!out.ok);
    assert.equal(out.code, null);
    assert.match(out.message, /current directory changed/);
    await r.end();
    await l.close();
  });

  // proc-direct (Linux with /proc): /proc/self/fd/<dir fd>/<name>, no E.
  test("proc-direct connects through /proc/self/fd on Linux", { skip: os !== "linux" && "Linux only" }, async () => {
    const l = await longListener(shortDir());
    const c = await connectExIn(world(), l.path, {});
    assert.equal(c.route, "proc-direct");
    assert.equal(await roundTrip(c.socket), "x");
    await l.close();
  });

  // SPEC "失敗をやり直さない": a route that connects and fails returns its
  // errno (ENOENT: nothing at the path; ECONNREFUSED: a socket file nobody
  // listens on) with the route, and nothing is tried or left after it.
  test("ENOENT and ECONNREFUSED come from the route that connected, leaving nothing", async () => {
    const dir = deepDir(shortDir());
    const w = world({ proc: "" });
    const before = listing(placeB());
    const e = await rejection(connectExIn(w, `${dir}/none.sock`, {}));
    assert.equal(e["code"], "ENOENT");
    assert.equal(e["route"], "link-file");
    assert.equal(e["path"], `${dir}/none.sock`);

    // A socket file nobody listens on: a live one renamed into the long
    // directory, then its listener closed.
    const short = `${shortDir()}/live.sock`;
    const server = await standardListen(short);
    fs.renameSync(short, `${dir}/stale.sock`);
    await closeServer(server);
    const e2 = await rejection(connectExIn(w, `${dir}/stale.sock`, {}));
    assert.equal(e2["code"], "ECONNREFUSED");
    assert.equal(e2["route"], "link-file");
    assert.deepEqual(listing(placeB()), before);
  });

  // SPEC "ディレクトリを先に引く": a missing directory is ENOENT before any route.
  test("a long path whose directory is missing is ENOENT before any route", async () => {
    const e = await rejection(connectEx(`${deepDir(tempDir())}/no/s.sock`));
    assert.equal(e["code"], "ENOENT");
    assert.equal(e["route"], null);
    assert.deepEqual(skippedNames(e), []);
  });

  // The default connect makes no D (SPEC "既定の connect"): a world that
  // cannot lock D still connects by link-file.
  test("the default connect needs no D", async () => {
    const l = await longListener(shortDir());
    const w = world({ proc: "", lock: { kind: "none" } });
    const s = await connectExIn(w, l.path, {});
    assert.equal(s.route, "link-file");
    assert.equal(w.auto?.d ?? null, null);
    s.socket.destroy();
    await l.close();
  });

  // connect (no Ex) is the same connect without the diagnostics.
  test("connect reaches a long path", async () => {
    const l = await longListener(tempDir());
    assert.equal(await roundTrip(await connect(l.path)), "x");
    await l.close();
  });
});
