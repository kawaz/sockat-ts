import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";
import { describe, test } from "node:test";
import * as v from "valibot";
import { bindExIn } from "../src/netapi.ts";
import { resolveForBindIn, resolveForConnectIn } from "../src/resolve.ts";
import { child, closeServer, deepDir, listing, place, runtime, shortDir, tempDir, world } from "./helpers.ts";

// The hub's DR-0019 (SPEC "相対パスを絶対パスにする"): the binds and the
// resolves make a relative path absolute first, by one of two absolute
// candidates (the socket's directory's real path, and $PWD with the
// relative path folded onto it and checked); a candidate that fits goes to
// the standard (Original, nothing in the places), otherwise the routes, and
// only when no route can be used the relative path itself (CwdRelative).
// The connects leave a relative path as it is. A long absolute path tries
// its real candidate before the routes.
//
// What binds a relative path runs in a child process (its cwd, and $PWD as
// the test hands it through the world).

const Spelling = v.looseObject({ kind: v.string() });
const BindRel = v.variant("ok", [
  v.object({
    ok: v.literal(true),
    route: v.string(),
    spelling: Spelling,
    skipped: v.array(v.unknown()),
    address: v.unknown(),
    spellings: v.array(v.string()),
    bound: v.array(v.string()),
    removed: v.array(v.string()),
    closed: v.array(v.string()),
    bunUnix: v.optional(v.string()),
    bunSpelling: v.optional(Spelling),
  }),
  v.object({
    ok: v.literal(false),
    code: v.nullable(v.string()),
    message: v.string(),
    route: v.unknown(),
    skipped: v.array(v.unknown()),
    spellings: v.array(v.string()),
    look: v.array(v.string()),
  }),
]);
const Resolved = v.variant("ok", [
  v.object({ ok: v.literal(true), path: v.string(), spelling: Spelling, route: v.string(), skipped: v.array(v.unknown()) }),
  v.object({ ok: v.literal(false), code: v.nullable(v.string()), message: v.string(), route: v.unknown(), skipped: v.array(v.unknown()) }),
]);
const ResolveRel = v.object({ bind: Resolved, connect: Resolved });

const isBun = typeof process.versions["bun"] === "string";
const os = world().cfg.os;

/** bind-rel in cwd. */
async function bindRel(cmd: Record<string, unknown>, cwd: string): Promise<v.InferOutput<typeof BindRel>> {
  const r = await child({ op: "bind-rel", ...cmd }, cwd);
  await r.end();
  return v.parse(BindRel, r.out);
}

/** resolve-rel in cwd. */
async function resolveRel(cmd: Record<string, unknown>, cwd: string): Promise<v.InferOutput<typeof ResolveRel>> {
  const r = await child({ op: "resolve-rel", ...cmd }, cwd);
  await r.end();
  return v.parse(ResolveRel, r.out);
}

/** The bind order after standard on this system (SPEC "bind の順", DR-0002). */
function bindRoutes(): string[] {
  const w = world();
  const order = ["link-dir"];
  if (w.cfg.bindFollows !== "no") {
    order.push("link-file");
  }
  if (os === "linux" || os === "darwin") {
    order.push("thread-cwd");
  } else if (os === "freebsd") {
    order.push("at");
  }
  return order;
}

/**
 * Runs test/child.ts with command in a cwd depth components of 200 bytes
 * below a fresh directory, made and entered by a shell one relative
 * component at a time ($PWD as the shell keeps it), then removes it the
 * same way: the JSON line the child printed.
 */
function inDeepCwd(depth: number, command: Record<string, unknown>): unknown {
  const script = [
    'c=$1; n=$2; shift 2; i=0',
    'while [ "$i" -lt "$n" ]; do mkdir "$c" && cd -P "$c" || exit 9; i=$((i+1)); done',
    'export PWD',
    '"$@"; s=$?',
    'rm -f s.sock x.sock; i=0',
    'while [ "$i" -lt "$n" ]; do cd -P .. && rmdir "$c" || exit 8; i=$((i+1)); done',
    'exit $s',
  ].join("\n");
  const cwd = tempDir();
  const r = spawnSync("sh", ["-c", script, "sh", "d".repeat(200), String(depth), runtime, nodePath.join(import.meta.dirname, "child.ts"), JSON.stringify(command)], {
    cwd,
    env: { ...process.env, STT_PLACE: place, PWD: cwd },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** A long directory reached through a short symlink (<short>/l -> <long>): $PWD fits, the real path does not. */
function shortLinkToLong(): { link: string; long: string } {
  const long = deepDir(tempDir());
  const link = `${shortDir()}/l`;
  fs.symlinkSync(long, link);
  return { link, long };
}

describe("relative paths of the binds and the resolves (DR-0019)", () => {
  // A short relative path goes to the standard as its real candidate (the
  // socket's directory's real path and the name; tried first): Original,
  // nothing skipped, and the listener's address() (Bun's unix) is that
  // absolute path, not the string given. remove() takes the file.
  test("a short relative path binds through its real candidate", async () => {
    const dir = shortDir();
    const want = `${fs.realpathSync(dir)}/s.sock`;
    const out = await bindRel({ path: "s.sock", pwd: dir, look: [`${dir}/s.sock`] }, dir);
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepEqual([out.route, out.spelling, out.skipped], ["standard", { kind: "Original" }, []]);
    assert.deepEqual(out.spellings, [want]);
    assert.equal(out.address, want);
    assert.deepEqual([out.bound, out.removed, out.closed], [["socket"], ["-"], ["-"]]);
    if (isBun) {
      assert.deepEqual([out.bunUnix, out.bunSpelling], [want, { kind: "Original" }]);
    }
  });

  // Behind a symlink the two candidates differ in length: a cwd reached
  // through a long path to a short real directory fits by its real
  // candidate; one reached through a short symlink to a long directory
  // fits by its $PWD candidate (the symlink's spelling). Either goes to the
  // standard as Original, and the socket is in the directory the path names.
  test("the real candidate or the $PWD candidate, whichever fits", async () => {
    const target = shortDir();
    const viaLong = `${deepDir(tempDir())}/l`;
    fs.symlinkSync(target, viaLong);
    const a = await bindRel({ path: "s.sock", pwd: viaLong, look: [`${target}/s.sock`] }, viaLong);
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepEqual([a.route, a.spelling, a.spellings, a.bound], ["standard", { kind: "Original" }, [`${fs.realpathSync(target)}/s.sock`], ["socket"]]);

    const { link, long } = shortLinkToLong();
    const b = await bindRel({ path: "s.sock", pwd: link, look: [`${long}/s.sock`] }, link);
    assert.ok(b.ok, JSON.stringify(b));
    assert.deepEqual([b.route, b.spelling, b.spellings, b.address, b.bound], ["standard", { kind: "Original" }, [`${link}/s.sock`], `${link}/s.sock`, ["socket"]]);
    if (isBun) {
      assert.equal(b.bunUnix, `${link}/s.sock`);
    }
  });

  // $PWD is used only while it names the cwd: one naming another directory
  // (or none) leaves the real candidate, too long here, and the routes. The
  // address is then the real candidate's form.
  test("a $PWD that is not the cwd is not a candidate", async () => {
    for (const pwd of [shortDir(), undefined]) {
      const { link, long } = shortLinkToLong();
      const out = await bindRel({ path: "s.sock", ...(pwd === undefined ? {} : { pwd }), look: [`${long}/s.sock`] }, link);
      assert.ok(out.ok, JSON.stringify(out));
      assert.equal(out.route, "link-dir");
      assert.equal(out.spelling.kind, "Linked");
      assert.equal(out.skipped[0], "standard");
      assert.equal(out.address, `${fs.realpathSync(long)}/s.sock`);
      assert.deepEqual(out.bound, ["socket"]);
    }
  });

  // "<symlink>/.." folded as a string names the directory the symlink is
  // in, while the kernel goes to the parent of its target: the $PWD
  // candidate whose directory is not the one the path names is not used,
  // and the socket is made where the kernel resolves the path (through the
  // routes here, its real candidate being long).
  test("a $PWD candidate whose folded directory is another is not used", async () => {
    const s = shortDir();
    const long = deepDir(tempDir());
    fs.mkdirSync(`${long}/t`);
    fs.symlinkSync(`${long}/t`, `${s}/sym`);
    const out = await bindRel({ path: "sym/../s.sock", pwd: s, look: [`${s}/s.sock`, `${long}/s.sock`] }, s);
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.route, "link-dir");
    assert.deepEqual(out.bound, ["-", "socket"]);
    assert.equal(out.address, `${fs.realpathSync(long)}/s.sock`);
  });

  // A deep cwd: neither candidate fits, so a short relative path takes the
  // routes (standard is skipped, as for a long path).
  test("a short relative path in a deep cwd takes the routes", async () => {
    const deep = deepDir(tempDir());
    const out = await bindRel({ path: "s.sock", pwd: deep, look: [`${deep}/s.sock`] }, deep);
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.route, "link-dir");
    assert.equal(out.skipped[0], "standard");
    assert.deepEqual([out.bound, out.removed], [["socket"], ["-"]]);
  });

  // When no route can be used either (no place, no /proc), the relative
  // path goes to the standard as it is (step 5): CwdRelative, route
  // standard, skipped the routes found unusable and not standard, and the
  // address the string given.
  test("a relative path no route can take goes to the standard as it is", async () => {
    const deep = deepDir(tempDir());
    const out = await bindRel({ path: "s.sock", pwd: deep, bare: true, look: [`${deep}/s.sock`] }, deep);
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepEqual([out.route, out.spelling, out.skipped], ["standard", { kind: "CwdRelative" }, bindRoutes()]);
    assert.deepEqual([out.spellings, out.address], [["s.sock"], "s.sock"]);
    assert.deepEqual([out.bound, out.removed], [["socket"], ["-"]]);
  });

  // A candidate, or a route, that binds and fails returns that error and
  // tries nothing else: neither the other candidate nor the relative path.
  test("a candidate or a route that fails is not tried again another way", async () => {
    const dir = shortDir();
    fs.writeFileSync(`${dir}/s.sock`, "");
    const a = await bindRel({ path: "s.sock", pwd: dir }, dir);
    assert.ok(!a.ok);
    assert.deepEqual([a.code, a.route, a.spellings], ["EADDRINUSE", "standard", [`${fs.realpathSync(dir)}/s.sock`]]);

    const deep = deepDir(tempDir());
    fs.writeFileSync(`${deep}/s.sock`, "");
    const b = await bindRel({ path: "s.sock", pwd: deep }, deep);
    assert.ok(!b.ok);
    assert.deepEqual([b.code, b.route, b.spellings.length], ["EADDRINUSE", "link-dir", 1]);
    assert.notEqual(b.spellings[0], "s.sock");
  });

  // The kernel keeps the absolute spelling: after the cwd changes,
  // remove() and the standard's close (which unlinks the spelling) both
  // act on the socket bound, and a file of the same name in the new cwd
  // stays.
  test("after a chdir, remove() and close act on the socket bound, not on the new cwd", async () => {
    const one = shortDir();
    const two = shortDir();
    fs.writeFileSync(`${two}/s.sock`, "precious");
    const out = await bindRel({ path: "s.sock", pwd: one, chdirTo: two, look: [`${one}/s.sock`, `${two}/s.sock`] }, one);
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepEqual([out.bound, out.removed, out.closed], [["socket", "file"], ["-", "file"], ["-", "file"]]);
    assert.equal(fs.readFileSync(`${two}/s.sock`, "utf8"), "precious");
  });

  // A relative path whose directory is missing has no candidate and fails
  // where the routes look the directory up: ENOENT, no route, nothing
  // skipped (the standard is not handed it).
  test("a short relative path whose directory is missing is ENOENT", async () => {
    const dir = shortDir();
    const out = await bindRel({ path: "none/s.sock", pwd: dir }, dir);
    assert.ok(!out.ok);
    assert.deepEqual([out.code, out.route, out.skipped, out.spellings], ["ENOENT", null, [], []]);
  });

  // A short relative path not ending with a name has no candidate: the
  // bind hands it to the standard as it is (the standard's error), the
  // resolves return it as it is, CwdRelative.
  test("a short relative path not ending with a name is left as it is", async () => {
    const dir = shortDir();
    fs.mkdirSync(`${dir}/d`);
    const b = await bindRel({ path: "d/", pwd: dir }, dir);
    assert.ok(!b.ok);
    assert.deepEqual(b.spellings, ["d/"]);
    const r = await resolveRel({ path: "d/", pwd: dir }, dir);
    for (const f of [r.bind, r.connect]) {
      assert.ok(f.ok, JSON.stringify(f));
      assert.deepEqual([f.path, f.spelling, f.route, f.skipped], ["d/", { kind: "CwdRelative" }, "standard", []]);
    }
  });

  // The resolves: a short relative path is spelt by its candidate
  // (Original); in a deep cwd by B (Linked; link-file's not removable for
  // resolveForConnect); with no route, the relative path itself
  // (CwdRelative, the routes found unusable skipped, not standard).
  test("the resolves of a relative path", async () => {
    const dir = shortDir();
    const want = `${fs.realpathSync(dir)}/s.sock`;
    const short = await resolveRel({ path: "s.sock", pwd: dir }, dir);
    for (const f of [short.bind, short.connect]) {
      assert.ok(f.ok, JSON.stringify(f));
      assert.deepEqual([f.path, f.spelling, f.route, f.skipped], [want, { kind: "Original" }, "standard", []]);
    }
    const deep = deepDir(tempDir());
    const linked = await resolveRel({ path: "s.sock", pwd: deep }, deep);
    assert.ok(linked.bind.ok && linked.connect.ok, JSON.stringify(linked));
    assert.deepEqual([linked.bind.route, linked.bind.spelling.kind], ["link-dir", "Linked"]);
    assert.deepEqual([linked.connect.route, linked.connect.spelling["kind"], linked.connect.spelling["removable"]], ["link-file", "Linked", false]);
    const bare = await resolveRel({ path: "s.sock", pwd: deep, bare: true }, deep);
    assert.ok(bare.bind.ok && bare.connect.ok, JSON.stringify(bare));
    const forBind = world().cfg.bindFollows === "yes" ? ["link-dir", "link-file"] : ["link-dir"];
    assert.deepEqual([bare.bind.path, bare.bind.spelling, bare.bind.route, bare.bind.skipped], ["s.sock", { kind: "CwdRelative" }, "standard", forBind]);
    assert.deepEqual([bare.connect.path, bare.connect.spelling, bare.connect.route, bare.connect.skipped], ["s.sock", { kind: "CwdRelative" }, "standard", ["link-file"]]);
  });

  // A cwd deeper than PATH_MAX (and $PWD as deep): the socket's directory
  // has no real path to use (realpath(3) fails for the length: ERANGE from
  // Node on macOS, ENAMETOOLONG from Bun; Node on Linux gets one from glibc
  // that is too long to look up), and $PWD cannot be looked up. No
  // candidate, and no route tried (they go through the real path): a short
  // relative path binds as it is, as the standard does, and the resolve
  // gives it back CwdRelative with nothing skipped. A relative path over
  // the standard length is ENAMETOOLONG with no route. bindEx binds as
  // the bind does, but cannot record the socket file for its removal.
  test("a cwd deeper than PATH_MAX binds a short relative path as the standard does", () => {
    const pathMax = os === "linux" ? 4096 : 1024;
    const out = v.parse(
      v.object({
        bind: v.looseObject({ ok: v.boolean() }),
        bindEx: v.looseObject({ ok: v.boolean() }),
        resolve: Resolved,
        long: Resolved,
      }),
      inDeepCwd(Math.ceil(pathMax / 201) + 1, { op: "deep-cwd" }),
    );
    assert.deepEqual(out.bind, { ok: true, address: "s.sock", file: "socket" });
    // bindEx binds too, but cannot record the socket file (no real path):
    // a general error, the listener left open (DR-0004), its file there.
    assert.deepEqual([out.bindEx["ok"], out.bindEx["code"], out.bindEx["file"]], [false, null, "socket"]);
    assert.match(String(out.bindEx["message"]), /could not be recorded/);
    assert.ok(out.resolve.ok, JSON.stringify(out.resolve));
    assert.deepEqual(out.resolve.path, "r.sock");
    assert.deepEqual(out.resolve.spelling, { kind: "CwdRelative" });
    assert.equal(out.resolve.route, "standard");
    assert.deepEqual(out.resolve.skipped, [], "no route was tried");
    assert.ok(!out.long.ok);
    assert.deepEqual([out.long.code, out.long.route, out.long.skipped], ["ENAMETOOLONG", null, []]);
  });

  // The cwd changed after the candidate is made and before the bind: the
  // socket is made where the candidate names (the cwd of the call), not in
  // the new cwd, whose file of the same name stays.
  test("a cwd changed just before the bind does not move a candidate", async () => {
    const one = shortDir();
    const two = shortDir();
    fs.writeFileSync(`${two}/s.sock`, "precious");
    const r = await child({ op: "bind-ex-chdir", path: "s.sock", chdirTo: two, when: "before", look: [`${one}/s.sock`, `${two}/s.sock`] }, one);
    await r.end();
    const out = v.parse(v.object({ ok: v.boolean(), look: v.array(v.string()) }), r.out);
    assert.ok(out.ok, JSON.stringify(r.out));
    assert.deepEqual(out.look, ["-", "file"], "bound in one, then closed (which unlinks it there)");
    assert.equal(fs.readFileSync(`${two}/s.sock`, "utf8"), "precious");
  });
});

describe("the real candidate of a long absolute path", () => {
  // A long absolute path whose real path fits (through a symlink) goes to
  // the standard as that real path: Original, nothing skipped, nothing in
  // the places, and Options.base not looked at (B is not used: a base that
  // fails its check is no error here). address() is the path given.
  test("a long absolute path binds through its real path when that fits", async () => {
    const target = shortDir();
    const deep = deepDir(tempDir());
    fs.symlinkSync(target, `${deep}/l`);
    const path = `${deep}/l/s.sock`;
    const badBase = `${shortDir()}/b`;
    fs.symlinkSync(shortDir(), badBase);
    const before = listing(place);
    const b = await bindExIn(world(), path, { base: badBase });
    assert.deepEqual([b.route, b.spelling, b.skipped, b.base], ["standard", { kind: "Original" }, [], null]);
    assert.equal(b.socket.address(), path);
    assert.ok(fs.lstatSync(`${target}/s.sock`).isSocket());
    assert.deepEqual(listing(place), before);
    b.file.remove();
    assert.equal(fs.existsSync(`${target}/s.sock`), false);
    await closeServer(b.socket);

    const real = `${fs.realpathSync(target)}/t.sock`;
    const fb = resolveForBindIn(world(), `${deep}/l/t.sock`, { base: badBase });
    const fc = resolveForConnectIn(world(), `${deep}/l/t.sock`, { base: badBase });
    assert.deepEqual([fb.path, fb.spelling, fb.route, fb.skipped], [real, { kind: "Original" }, "standard", []]);
    assert.deepEqual([fc.path, fc.spelling, fc.route, fc.skipped], [real, { kind: "Original" }, "standard", []]);
    assert.deepEqual(listing(place), before);
  });

  // Bun's listenEx the same: its unix is the path given.
  test("Bun's listenEx of a long absolute path through its real path", { skip: !isBun && "Bun only" }, async () => {
    const bun = await import("../src/bunapi.ts");
    const target = shortDir();
    const deep = deepDir(tempDir());
    fs.symlinkSync(target, `${deep}/l`);
    const path = `${deep}/l/s.sock`;
    const l = bun.listenExIn(world(), { unix: path, socket: { data() {} } }, {});
    assert.deepEqual([l.route, l.spelling, l.socket.unix], ["standard", { kind: "Original" }, path]);
    l.file.remove();
    l.socket.stop(true);
  });
});

describe("the connects and ForConnect", () => {
  // A connect leaves a relative path as it is: within the standard length
  // it goes to the standard relative, through a deep cwd, and makes nothing
  // in the places.
  test("a connect of a short relative path goes to the standard as it is", async () => {
    const deep = deepDir(tempDir());
    const peer = await bindExIn(world(), `${deep}/s.sock`, {});
    peer.socket.on("connection", (s) => s.on("error", () => {}));
    const before = listing(place);
    const r = await child({ op: "connect-ex", path: "s.sock" }, deep);
    await r.end();
    assert.deepEqual(v.parse(v.object({ ok: v.literal(true), route: v.string(), skipped: v.array(v.unknown()) }), r.out), { ok: true, route: "standard", skipped: [] });
    assert.deepEqual(listing(place), before);
    peer.file.remove();
    await closeServer(peer.socket);
  });

  // ForConnect's spelling: Original for a short absolute path; for
  // link-file's spelling Linked, not removable (unlinking it removes E),
  // and until the process ends through procB (Linux with /proc).
  test("ForConnect says what its spelling is good for", () => {
    const short = resolveForConnectIn(world(), `${shortDir()}/s.sock`, {});
    assert.deepEqual(short.spelling, { kind: "Original" });
    const long = resolveForConnectIn(world(), `${deepDir(tempDir())}/s.sock`, {});
    assert.equal(long.route, "link-file");
    assert.ok(long.spelling.kind === "Linked", JSON.stringify(long.spelling));
    assert.equal(long.spelling.removable, false);
    assert.equal(long.spelling.until, os === "linux" ? "Process" : "Cleanup");
    long.cleanup();
  });
});
