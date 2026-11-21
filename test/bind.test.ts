import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { bindEx, connect } from "../src/index.ts";
import { bindExIn, bindIn } from "../src/netapi.ts";
import type { World } from "../src/world.ts";
import { randomName } from "../src/names.ts";
import {
  closeServer,
  addressesOf,
  deepDir,
  echo,
  linksInB,
  listing,
  pathOfLength,
  placeB,
  rejection,
  roundTrip,
  shortDir,
  skippedNames,
  tempDir,
  world,
} from "./helpers.ts";

const os = world().cfg.os;

/** A fresh place standing in for /tmp (1777, as /tmp is). */
function freshPlace(): string {
  const p = shortDir();
  fs.chmodSync(p, 0o1777);
  return p;
}

/** The symlinks in w's D (its path and target), whatever B it is in. */
function linksOf(w: World): { path: string; target: string }[] {
  const b = w.auto;
  if (b === null || b.d === null) {
    return [];
  }
  const d = `${b.real}/${b.d.name}`;
  return fs
    .readdirSync(d)
    .map((n) => ({ path: `${d}/${n}`, target: fs.readlinkSync(`${d}/${n}`) }))
    .toSorted((x, y) => x.path.localeCompare(y.path));
}

describe("bind", () => {
  // DR-0003: a path of exactly the standard length goes to the standard as
  // it is (and the standard takes it), one byte longer takes the routes.
  // The boundary is the standard's own, so it is checked through it.
  test("the standard length is the boundary between the standard and the routes", async () => {
    const w = world();
    const max = w.cfg.standardLength;
    const root = shortDir();
    const atMax = pathOfLength(root, max);
    const a = await bindExIn(w, atMax, {});
    assert.equal(a.route, "standard");
    assert.deepEqual(a.spelling, { kind: "Original" });
    assert.deepEqual(a.skipped, []);
    assert.equal(a.socket.address(), atMax);
    assert.ok(fs.lstatSync(atMax).isSocket());
    a.file.remove();
    await closeServer(a.socket);

    const over = pathOfLength(root, max + 1);
    const b = await bindExIn(w, over, {});
    assert.notEqual(b.route, "standard");
    assert.equal(b.skipped[0]?.name, "standard");
    assert.ok(fs.lstatSync(over).isSocket());
    b.file.remove();
    await closeServer(b.socket);
  });

  // A long path binds through B/D/E/<name> (link-dir): procB where /proc
  // can be used (Linux), B's real path elsewhere. The socket is at the path
  // itself, the listener's address() is the caller's path, and the E stays
  // in this process's D for the spelling until the cleanup.
  test("a long path binds by link-dir and the socket is at the path", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const before = linksInB(placeB()).length;
    const b = await bindEx(path);
    echo(b.socket);
    assert.equal(b.route, "link-dir");
    assert.equal(b.base, os === "linux" ? "proc" : "tmp");
    assert.deepEqual(
      b.spelling,
      os === "linux"
        ? { kind: "Linked", removable: true, until: "Process", usableCrossUid: false, usableWithPrivateTmp: true }
        : { kind: "Linked", removable: true, until: "Cleanup", usableCrossUid: true, usableWithPrivateTmp: false },
    );
    assert.deepEqual(
      b.skipped.map((s) => s.name),
      ["standard"],
    );
    assert.equal(b.socket.address(), path);
    assert.ok(fs.lstatSync(path).isSocket());
    assert.equal(linksInB(placeB()).length, before + 1);
    assert.equal(await roundTrip(await connect(path)), "x");
    b.file.remove();
    assert.equal(fs.existsSync(path), false);
    assert.ok(b.socket.listening, "remove does not close the listener");
    assert.equal(linksInB(placeB()).length, before);
    await closeServer(b.socket);
  });

  // usableCrossUid asks for a spelling another uid can follow: no procB, and
  // a B that others can search all the way (the tests' place is 1777 as
  // /tmp is, and B is 0711), so the spelling is Linked and usableCrossUid.
  test("usableCrossUid binds through B's real path that others can follow", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const b = await bindExIn(world(), path, { usableCrossUid: true });
    assert.equal(b.route, "link-dir");
    assert.equal(b.base, "tmp");
    assert.ok(b.spelling.kind === "Linked" && b.spelling.usableCrossUid && b.spelling.until === "Cleanup");
    b.file.remove();
    await closeServer(b.socket);
  });

  // SPEC "ディレクトリを先に引く": a missing directory is ENOENT and a
  // directory that is a file ENOTDIR, before anything is decided or made, so
  // no route is named and nothing is skipped. Node's standard says EACCES for
  // a missing directory of a short path (libuv); a long path says ENOENT.
  test("a long path whose directory is missing is ENOENT, and ENOTDIR through a file", async () => {
    const root = tempDir();
    const missing = `${deepDir(root)}/no/such/dir/s.sock`;
    const e = await rejection(bindEx(missing));
    assert.equal(e["code"], "ENOENT");
    assert.equal(e["route"], null);
    assert.deepEqual(e["skipped"], []);
    assert.equal(e["path"], missing);

    const file = `${deepDir(root)}/f`;
    fs.writeFileSync(file, "");
    const e2 = await rejection(bindEx(`${file}/s.sock`));
    assert.equal(e2["code"], "ENOTDIR");
    assert.equal(e2["route"], null);
  });

  // SPEC "失敗をやり直さない": a route that binds and fails returns the
  // standard's errno (EADDRINUSE for a file already at the path), named by
  // the caller's path, with the route that failed; its E is removed before
  // it returns, and no later route is tried.
  test("a long path with a file already there is EADDRINUSE from link-dir, and its E is gone", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    fs.writeFileSync(path, "");
    const before = linksInB(placeB());
    const e = await rejection(bindEx(path));
    assert.equal(e["code"], "EADDRINUSE");
    assert.equal(e["route"], "link-dir");
    assert.deepEqual(skippedNames(e), ["standard"]);
    assert.equal(e["path"], path);
    assert.ok(e.error.message.includes(path));
    assert.deepEqual(linksInB(placeB()), before);
    assert.ok(fs.lstatSync(path).isFile());
  });

  // SPEC "名前で終わらないパス、先頭以外の NUL": an argument error that makes
  // nothing; a NUL even in a short path (the standard would cut it short).
  test("a long path not ending with a name, and a NUL, are argument errors that make nothing", async () => {
    const root = deepDir(tempDir());
    const before = listing(placeB());
    for (const p of [`${root}/`, `${root}/.`, `${root}/..`, "/tmp/a\0b", `${root}/a\0b`, `${root}/a\0b/s.sock`]) {
      const e = await rejection(bindEx(p));
      assert.ok(e.error instanceof TypeError, p);
      assert.equal(e["code"], "ERR_INVALID_ARG_VALUE");
      assert.match(e.error.message, /^The argument 'path'/);
      assert.equal(e["route"], null);
      assert.deepEqual(e["skipped"], []);
    }
    assert.deepEqual(listing(placeB()), before);
  });

  // SPEC "短いパス": a leading NUL is a Linux abstract name and goes to the
  // standard whatever the length: a short one binds (Original), and a long
  // one gets what the standard gives it (no route of sockat's is tried, so
  // nothing is skipped); elsewhere a leading NUL is an argument error.
  test("a leading NUL is an abstract name on Linux and an argument error elsewhere", async () => {
    const name = `\0stt-${process.pid}-${randomName()}`;
    const long = `${name}-${"a".repeat(120)}`;
    if (os === "linux") {
      const b = await bindEx(name);
      assert.equal(b.route, "standard");
      assert.deepEqual(b.spelling, { kind: "Original" });
      b.file.remove();
      await closeServer(b.socket);
      const r = await bindEx(long).then(
        async (l) => {
          await closeServer(l.socket);
          return { route: l.route, skipped: l.skipped };
        },
        (e: unknown) => (e instanceof Error && "route" in e && "skipped" in e ? { route: e.route, skipped: e.skipped } : null),
      );
      assert.deepEqual(r, { route: "standard", skipped: [] });
    } else {
      for (const p of [name, long]) {
        const e = await rejection(bindEx(p));
        assert.ok(e.error instanceof TypeError);
      }
    }
  });

  // A file name no spelling through B fits (100 bytes): on macOS bind(2)
  // follows a symlink, so link-file (B/D/E, whose length does not depend on
  // the name) binds; on Linux it is not tried (bind does not follow), and
  // thread-cwd is not made here (DR-0002), so the bind is ENAMETOOLONG.
  test("a long file name binds by link-file where bind follows a symlink, and is ENAMETOOLONG elsewhere", async () => {
    const path = `${deepDir(tempDir())}/${"n".repeat(100)}`;
    const w = world();
    if (w.cfg.bindFollows === "yes") {
      const b = await bindExIn(w, path, {});
      assert.equal(b.route, "link-file");
      assert.ok(b.spelling.kind === "Linked" && !b.spelling.removable);
      assert.deepEqual(
        b.skipped.map((s) => s.name),
        ["standard", "link-dir"],
      );
      assert.ok(fs.lstatSync(path).isSocket());
      assert.equal(b.socket.address(), path);
      b.file.remove();
      assert.equal(fs.existsSync(path), false);
      await closeServer(b.socket);
    } else {
      const e = await rejection(bindExIn(w, path, {}));
      assert.equal(e["code"], "ENAMETOOLONG");
      assert.equal(e["route"], null);
      assert.deepEqual(skippedNames(e), os === "linux" ? ["standard", "link-dir", "thread-cwd"] : ["standard", "link-dir"]);
    }
  });

  // SPEC-routes "link-file": where bind(2) is not known to follow a symlink,
  // link-file is tried and told at run time. Forced on every system: where
  // the bind fails with nothing at the path (it did not follow), the route is
  // skipped and its E removed; where a file is at the path, its error
  // (EADDRINUSE) is the call's, from link-file, and nothing is tried after.
  test("link-file told at run time: skipped when bind did not follow, EADDRINUSE when a file is there", async () => {
    const w = world({ bindFollows: "unknown" });
    const dir = deepDir(tempDir());
    const path = `${dir}/${"n".repeat(100)}`;
    const before = linksInB(placeB());
    if (os === "linux") {
      const e = await rejection(bindExIn(w, path, {}));
      assert.equal(e["code"], "ENAMETOOLONG");
      assert.ok(Array.isArray(skippedNames(e)) && JSON.stringify(e["skipped"]).includes("bind did not follow the symlink"));
      assert.deepEqual(linksInB(placeB()), before);
      assert.equal(fs.existsSync(path), false);
    }
    fs.writeFileSync(path, "");
    const e = await rejection(bindExIn(w, path, {}));
    assert.equal(e["code"], "EADDRINUSE");
    assert.equal(e["route"], "link-file");
    assert.deepEqual(linksInB(placeB()), before);
  });

  // DR-0002: D cannot be made without a lock (no flock(1), illumos), so the
  // routes through D cannot be used and a long bind is ENAMETOOLONG.
  test("without a way to lock D, a long bind is ENAMETOOLONG", async () => {
    for (const lock of [{ kind: "none" } as const, { kind: "flock-command", command: "stt-no-such-flock" } as const]) {
      const w = world({ lock });
      const e = await rejection(bindExIn(w, `${deepDir(tempDir())}/s.sock`, {}));
      assert.equal(e["code"], "ENAMETOOLONG");
      assert.ok(JSON.stringify(e["skipped"]).includes("D not made"));
    }
  });

  // SPEC "B の確認": a place on the way to which another user could replace
  // a directory (here: the place itself writable by others and not sticky)
  // is not used; B goes to the next place.
  test("a place that fails the check of its ancestors is passed over", async () => {
    const bad = shortDir();
    fs.chmodSync(bad, 0o777);
    const good = shortDir();
    fs.chmodSync(good, 0o700);
    const w = world({ tmp: bad, getenv: (n) => (n === "TMPDIR" ? good : undefined) });
    const b = await bindExIn(w, `${deepDir(tempDir())}/s.sock`, {});
    assert.equal(b.base, os === "linux" ? "proc" : "tmpdir");
    assert.deepEqual(listing(bad), []);
    assert.equal(listing(good).length, 1);
    b.file.remove();
    await closeServer(b.socket);
  });

  // SPEC "Options.base": B is the path given (base "given"); a missing parent
  // is ENOENT and a symlink EPERM, before any route and without falling back
  // to the automatic places; a relative one is an argument error whatever
  // the length of the path.
  test("Options.base is B itself, and a base that fails its check is an error", async () => {
    const root = shortDir();
    const path = `${deepDir(tempDir())}/s.sock`;
    const b = await bindExIn(world(), path, { base: `${root}/b` });
    assert.equal(b.base, "given");
    assert.equal(listing(`${root}/b`).length, 1);
    b.file.remove();
    await closeServer(b.socket);

    const e = await rejection(bindExIn(world(), path, { base: `${root}/no/b` }));
    assert.equal(e["code"], "ENOENT");
    assert.equal(e["route"], null);
    assert.deepEqual(e["skipped"], []);

    fs.symlinkSync(root, `${root}/link`);
    const e2 = await rejection(bindExIn(world(), path, { base: `${root}/link` }));
    assert.equal(e2["code"], "EPERM");

    const e3 = await rejection(bindExIn(world(), "/tmp/s.sock", { base: "rel/b" }));
    assert.ok(e3.error instanceof TypeError);

    const closed = shortDir();
    fs.chmodSync(closed, 0o700);
    const e4 = await rejection(bindExIn(world(), path, { base: `${closed}/b`, usableCrossUid: true }));
    assert.equal(e4["code"], "EPERM");
    assert.deepEqual(listing(closed), []);
  });

  // SPEC "並行": many binds at once share one B and one D of the process
  // and do not trip over each other making them.
  test("concurrent binds share B and D", async () => {
    const w = world();
    const dir = deepDir(tempDir());
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => bindExIn(w, `${dir}/s${i}.sock`, {})));
    assert.equal(new Set(all.map((b) => b.route)).size, 1);
    assert.equal(w.bases().length, 1);
    for (const b of all) {
      b.file.remove();
      await closeServer(b.socket);
    }
  });

  // DR-0002 "listener を閉じた時": closing unlinks the spelling the
  // standard was given. Through link-dir's E that is the socket file at the
  // path (as for a short path); through link-file's it is the E alone, and
  // the socket file stays (SPEC "長いパスで標準と違う点").
  test("closing a long path's listener unlinks its spelling", async () => {
    const dir = deepDir(tempDir());
    const a = await bindExIn(world(), `${dir}/s.sock`, {});
    assert.equal(a.route, "link-dir");
    await closeServer(a.socket);
    assert.equal(fs.existsSync(`${dir}/s.sock`), false);
    const w = world();
    if (w.cfg.bindFollows === "yes") {
      const before = linksInB(placeB()).length;
      const path = `${dir}/${"n".repeat(100)}`;
      const b = await bindExIn(w, path, {});
      assert.equal(b.route, "link-file");
      await closeServer(b.socket);
      assert.ok(fs.lstatSync(path).isSocket(), "the socket file stays");
      assert.equal(linksInB(placeB()).length, before, "the E is gone");
      b.file.remove();
      assert.equal(fs.existsSync(path), false);
    }
  });

  // Where bind(2) is known to follow a symlink (macOS), link-file's failure
  // is real and returned as it is: a directory that cannot be written to is
  // EACCES from link-file, not ENAMETOOLONG (no route after it here would
  // meet the failure again).
  test(
    "link-file's real failure is returned where bind follows a symlink",
    { skip: (world().cfg.bindFollows !== "yes" || process.geteuid?.() === 0) && "macOS, not root" },
    async () => {
      const dir = deepDir(tempDir());
      fs.chmodSync(dir, 0o555);
      const e = await rejection(bindExIn(world(), `${dir}/${"n".repeat(100)}`, {}));
      fs.chmodSync(dir, 0o755);
      assert.equal(e["code"], "EACCES");
      assert.equal(e["route"], "link-file");
    },
  );

  // DR-0002: the overridden address() is the standard's with the path in
  // place of the spelling: the path while the listener listens, and once it
  // is closed what the standard gives then (Node keeps the name, Bun's
  // node:net gives null), never the spelling.
  test("address() of a long path's listener is the path, and the standard's value once closed", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const b = await bindEx(path);
    assert.equal(b.socket.address(), path);
    b.file.remove();
    await closeServer(b.socket);
    const after = b.socket.address();
    assert.ok(after === null || after === path, JSON.stringify(after));
  });

  // SPEC-routes "link-dir": the default bind keeps one link-dir E per
  // socket's directory in its D and binds through it again, so repeated and
  // concurrent default binds into one directory add a single E; bindEx
  // still makes an E per call, which its cleanup removes.
  test("default binds into one directory share one link-dir E; bindEx makes its own", async () => {
    const w = world({ tmp: freshPlace() });
    const dir = deepDir(tempDir());
    const servers = await Promise.all(Array.from({ length: 5 }, (_, i) => bindIn(w, `${dir}/s${i}.sock`)));
    const e = linksOf(w);
    assert.equal(e.length, 1, JSON.stringify(e));
    for (let i = 0; i < 5; i++) {
      assert.ok(fs.lstatSync(`${dir}/s${i}.sock`).isSocket());
    }
    const again = await bindIn(w, `${dir}/s5.sock`);
    assert.deepEqual(linksOf(w), e);
    const x = await bindExIn(w, `${dir}/x.sock`, {});
    assert.equal(linksOf(w).length, 2);
    x.file.remove();
    assert.deepEqual(linksOf(w), e);
    for (const s of [...servers, again, x.socket]) {
      await closeServer(s);
    }
  });

  // SPEC-routes "link-dir": a shared E that was removed, or that points
  // elsewhere now, is found by reading it through D and made again; the
  // bind goes through.
  test("a shared E removed or pointing elsewhere is made again", async () => {
    const w = world({ tmp: freshPlace() });
    const dir = deepDir(tempDir());
    const a = await bindIn(w, `${dir}/a.sock`);
    const [first] = linksOf(w);
    assert.ok(first !== undefined);
    fs.unlinkSync(first.path);
    const b = await bindIn(w, `${dir}/b.sock`);
    assert.ok(fs.lstatSync(`${dir}/b.sock`).isSocket());
    const [second] = linksOf(w);
    assert.ok(second !== undefined && second.path !== first.path);
    fs.unlinkSync(second.path);
    fs.symlinkSync(tempDir(), second.path);
    const c = await bindIn(w, `${dir}/c.sock`);
    assert.ok(fs.lstatSync(`${dir}/c.sock`).isSocket());
    assert.equal(linksOf(w).filter((l) => l.target === fs.realpathSync(dir)).length, 1);
    for (const s of [a, b, c]) {
      await closeServer(s);
    }
  });

  // SPEC-routes "経路の失敗の扱い": a default bind that fails (EADDRINUSE)
  // keeps its link-dir E, even one it made itself (a default bind running
  // alongside may be going through it), and the next default bind into the
  // directory goes through that same E. bindEx still removes the E it made.
  test("a failing default bind keeps its shared E, which the next one uses", async () => {
    const w = world({ tmp: freshPlace() });
    const dir = deepDir(tempDir());
    fs.writeFileSync(`${dir}/busy.sock`, "");
    const e1 = await rejection(bindIn(w, `${dir}/busy.sock`));
    assert.equal(e1["code"], "EADDRINUSE");
    const e = linksOf(w);
    assert.equal(e.length, 1);
    const a = await bindIn(w, `${dir}/a.sock`);
    assert.deepEqual(linksOf(w), e);
    await rejection(bindIn(w, `${dir}/busy.sock`));
    assert.deepEqual(linksOf(w), e);
    const ex = await rejection(bindExIn(w, `${dir}/busy.sock`, {}));
    assert.equal(ex["code"], "EADDRINUSE");
    assert.deepEqual(linksOf(w), e);
    await closeServer(a);
  });

  // SPEC "カーネルが返すアドレス": the addresses of a long path's listener,
  // of a connection accepted on it and of a socket connected to it can be
  // taken without failing.
  test("the addresses of a long path's sockets can be taken", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const b = await bindEx(path);
    const accepted = new Promise<unknown[]>((resolve) => b.socket.once("connection", (s) => resolve(addressesOf(s))));
    const c = await connect(path);
    assert.equal(addressesOf(c).length, 3);
    assert.equal((await accepted).length, 3);
    c.destroy();
    b.file.remove();
    await closeServer(b.socket);
  });
});
