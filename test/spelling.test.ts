import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { describe, test } from "node:test";
import * as v from "valibot";
import { sockaddrLength } from "../src/config.ts";
import { bindExIn, connectExIn } from "../src/netapi.ts";
import { resolveForBindIn } from "../src/resolve.ts";
import { forNodeNet } from "../src/route.ts";
import { bind, bindEx, connect, connectEx, resolveForBind, resolveForConnect } from "../src/index.ts";
import { type Caught, child, closeServer, deepDir, rejection, shortDir, skippedNames, standardListen, tempDir, thrown, world } from "./helpers.ts";

const BindRemoveOut = v.object({ ok: v.literal(true), route: v.string(), bound: v.array(v.string()), removed: v.array(v.string()) });
const NumericOut = v.object({
  ok: v.literal(true),
  route: v.string(),
  spelling: v.string(),
  address: v.string(),
  file: v.string(),
  connectRoute: v.string(),
  got: v.string(),
  longRoute: v.nullable(v.string()),
  longSkipped: v.array(v.string()),
  longFile: v.string(),
  bunUnix: v.optional(v.string()),
  bunFile: v.optional(v.string()),
  bunGot: v.optional(v.string()),
});

/**
 * <root>/a and <root>/b/target, with <root>/a/sym -> <root>/b/target: the
 * kernel resolves "<root>/a/sym/.." to <root>/b, a string fold to <root>/a.
 */
function symlinkFork(root: string): void {
  fs.mkdirSync(`${root}/a`);
  fs.mkdirSync(`${root}/b/target`, { recursive: true });
  fs.symlinkSync(`${root}/b/target`, `${root}/a/sym`);
}

/** c is an argument error (SPEC "エラー": 引数の誤り). */
function isArg(c: Caught): void {
  assert.ok(c.error instanceof TypeError, c.error.message);
  assert.equal(c["code"], "ERR_INVALID_ARG_VALUE");
}

describe("spellings", () => {
  // SPEC "パスを字句で畳まない": a long path through "<symlink>/.." binds
  // where the kernel resolves it (the parent of the symlink's target), and
  // the E of a resolve points there too; folding ".." as a string would put
  // the socket next to the symlink instead.
  test("a long path through <symlink>/.. binds where the kernel resolves it", async () => {
    const root = deepDir(tempDir(), 100);
    symlinkFork(root);
    const path = `${root}/a/sym/../s.sock`;
    const b = await bindExIn(world(), path, {});
    assert.notEqual(b.route, "standard");
    assert.ok(fs.lstatSync(`${root}/b/s.sock`).isSocket());
    assert.equal(fs.existsSync(`${root}/a/s.sock`), false);
    const f = resolveForBindIn(world(), `${root}/a/sym/../t.sock`, {});
    assert.equal(fs.realpathSync(f.path.slice(0, f.path.lastIndexOf("/"))), fs.realpathSync(`${root}/b`));
    f.cleanup();
    b.file.remove();
    assert.equal(fs.existsSync(`${root}/b/s.sock`), false);
    await closeServer(b.socket);
  });

  // The same for a short relative path: bindEx records the socket the
  // kernel bound (in b), so its remove() leaves an unrelated live socket at
  // a/s.sock alone.
  test("remove() of a short relative path through <symlink>/.. leaves an unrelated socket", async () => {
    const root = shortDir();
    symlinkFork(root);
    const other = await standardListen(`${root}/a/s.sock`);
    const r = await child({ op: "bind-ex-remove", path: "sym/../s.sock", look: [`${root}/a/s.sock`, `${root}/b/s.sock`] }, `${root}/a`);
    const out = v.parse(BindRemoveOut, r.out);
    assert.equal(out.route, "standard");
    assert.deepEqual(out.bound, ["socket", "socket"]);
    assert.deepEqual(out.removed, ["socket", "-"]);
    await r.end();
    await closeServer(other);
  });

  // SPEC "短いパス": node:net reads a string Number() makes 0 or more as a TCP
  // port, so such a spelling gets "./" (the same file). A long path whose
  // relative spelling is digits only connects to the unix socket, not to a
  // TCP server on that port.
  test("a long path whose relative spelling is a number connects to the socket, not to a TCP port", async () => {
    const tcp = net.createServer((s) => {
      s.on("error", () => {});
      s.end("tcp");
    });
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", () => resolve()));
    const a = tcp.address();
    const port = typeof a === "object" && a !== null ? a.port : 0;
    const dir = deepDir(tempDir());
    const ub = await bindExIn(world(), `${dir}/${port}`, {});
    const ux = ub.socket;
    ux.on("connection", (s) => {
      s.on("error", () => {});
      s.end("unix");
    });
    const r = await child({ op: "connect-ex", path: `${dir}/${port}`, noProc: true }, dir);
    assert.equal(v.parse(v.object({ ok: v.literal(true), route: v.string() }), r.out).route, "relative");
    await r.end();
    const c = await connectExIn(world({ proc: "" }), `${dir}/${port}`, {});
    const got = await new Promise<string>((resolve) => c.socket.once("data", (d) => resolve(d.toString())));
    assert.equal(got, "unix");
    ub.file.remove();
    await closeServer(ux);
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  });

  // A short relative path node:net would read as a port ("0") binds and
  // connects as a path in the cwd, its spelling still CwdRelative and its
  // address() the path given; one whose "./" spelling is over the standard
  // length takes the routes (and binds where link-file reaches any file name
  // length, macOS; elsewhere no spelling through B fits so long a name). @kawaz/sockat/bun hands Bun `unix`, which Bun
  // reads as a path whatever it is.
  test("a short relative path read as a number binds and connects as a path", async () => {
    const dir = shortDir();
    const long = "1".repeat(world().cfg.standardLength);
    const r = await child({ op: "numeric", name: "0", long }, dir);
    const out = v.parse(NumericOut, r.out);
    assert.equal(out.route, "standard");
    assert.equal(out.spelling, "CwdRelative");
    assert.equal(out.address, "0");
    assert.equal(out.file, "socket");
    assert.equal(out.got, "unix");
    assert.equal(out.longSkipped[0], "standard", "the long one took the routes");
    if (world().cfg.bindFollows === "yes") {
      assert.equal(out.longRoute, "link-file");
      assert.equal(out.longFile, "socket");
    } else {
      assert.equal(out.longRoute, null);
      assert.equal(out.longFile, "-");
    }
    if (typeof process.versions["bun"] === "string") {
      assert.deepEqual([out.bunUnix, out.bunFile, out.bunGot], ["0", "socket", "bun"]);
    }
    await r.end();
    assert.equal(forNodeNet("1e3"), "./1e3");
    assert.equal(forNodeNet(" "), "./ ");
    assert.equal(forNodeNet("a1"), "a1");
    assert.equal(forNodeNet("d/1"), "d/1");
  });

  // SPEC "短いパス": an empty path is an argument error in every function,
  // checked before the standard is handed anything and before the abstract
  // check (Linux's bind of "" would autobind to an unnamed abstract address).
  test("an empty path is an argument error in every function", async () => {
    isArg(await rejection(bind("")));
    isArg(await rejection(connect("")));
    isArg(await rejection(bindEx("")));
    isArg(await rejection(connectEx("")));
    isArg(thrown(() => resolveForBind("")));
    isArg(thrown(() => resolveForConnect("")));
    if (typeof process.versions["bun"] === "string") {
      const bun = await import("../src/bun.ts");
      isArg(thrown(() => bun.listen({ unix: "", socket: { data() {} } })));
      isArg(thrown(() => bun.listenEx({ unix: "", socket: { data() {} } })));
      isArg(await rejection(bun.connect({ unix: "", socket: { data() {} } })));
      isArg(await rejection(bun.connectEx({ unix: "", socket: { data() {} } })));
    }
  });

  // SPEC "sockaddr に入る長さ": a route's spelling is at most sun_path less
  // the NUL (107 on Linux, 103 on the others), not the standard length
  // (the two are equal now, DR-0003). The routes are held to the world's
  // spelling length: a short one leaves no spelling through B.
  test("routes' spellings are held to the sockaddr length, not the standard length", async () => {
    assert.equal(sockaddrLength("linux"), 107);
    assert.equal(sockaddrLength("illumos"), 107);
    assert.equal(sockaddrLength("darwin"), 103);
    const w = world();
    assert.equal(w.cfg.spellingLength, sockaddrLength(w.cfg.os));
    const e = await rejection(bindExIn(world({ spellingLength: 30 }), `${deepDir(tempDir())}/s.sock`, {}));
    assert.equal(e["code"], "ENAMETOOLONG");
    assert.ok(JSON.stringify(e["skipped"]).includes("spelling too long"));
    assert.deepEqual(skippedNames(e), w.cfg.os === "linux" ? ["standard", "link-dir", "thread-cwd"] : w.cfg.os === "darwin" ? ["standard", "link-dir", "link-file", "thread-cwd"] : skippedNames(e));
  });
});
