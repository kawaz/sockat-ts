import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { standardLength, sockaddrLength } from "../src/config.ts";
import { bindExIn, bindIn, connectAt, connectExIn, listenAt } from "../src/netapi.ts";
import { resolveForBindIn } from "../src/resolve.ts";
import { closeServer, deepDir, listing, rejection, shortDir, standardListen, tempDir, world } from "./helpers.ts";

// What the external review (the hub's docs/research/2026-11-21-external-review-carbon.md)
// found in sockat-ts, each made a test.

const uid = process.geteuid?.() ?? 0;

/** A fresh place standing in for /tmp (1777, as /tmp is). */
function freshPlace(): string {
  const p = shortDir();
  fs.chmodSync(p, 0o1777);
  return p;
}

describe("external review", () => {
  // 1-2: where entries of B and D are named by real path (no /proc), a B
  // removed while an E is held may have its name taken by someone else, and
  // a D-named symlink there would take the cleanup's unlink to another
  // directory. cleanup() unlinks only while B and D still are the ones held,
  // so a file of the same name elsewhere stays.
  test("cleanup after B was removed and its name taken unlinks nothing elsewhere", () => {
    const p = freshPlace();
    const w = world({ tmp: p, proc: "" });
    const f = resolveForBindIn(w, `${deepDir(tempDir())}/s.sock`, {});
    const b = w.auto;
    assert.ok(b !== null && b.d !== null);
    const victim = shortDir();
    fs.writeFileSync(`${victim}/0`, "precious");
    fs.rmSync(b.real, { recursive: true });
    fs.mkdirSync(b.real);
    fs.symlinkSync(victim, `${b.real}/${b.d.name}`);
    f.cleanup();
    assert.equal(fs.readFileSync(`${victim}/0`, "utf8"), "precious");
  });

  // 1-2: the default connect's link-file E is unlinked after the connect
  // (which waits); a B removed and its name taken meanwhile (here: made a
  // symlink to another directory holding a file of E's name) is not
  // followed, and that file stays.
  test("the default connect does not unlink through a B whose name was taken meanwhile", async () => {
    const p = freshPlace();
    const w = world({ tmp: p, proc: "" });
    const dir = deepDir(shortDir());
    const peer = await bindExIn(world(), `${dir}/s.sock`, {});
    peer.socket.on("connection", (s) => s.on("error", () => {}));
    const victim = shortDir();
    const c = await connectExIn(w, `${dir}/s.sock`, {}, async (spelling) => {
      const a = await connectAt(spelling);
      const b = w.auto;
      if (b !== null && spelling.startsWith(`${b.real}/`)) {
        const e = spelling.slice(b.real.length + 1);
        fs.writeFileSync(`${victim}/${e}`, "precious");
        fs.rmSync(b.real, { recursive: true });
        fs.symlinkSync(victim, b.real);
      }
      return a;
    });
    assert.equal(c.route, "link-file");
    c.socket.destroy();
    assert.equal(listing(victim).length, 1, "E's namesake in the other directory stays");
    peer.file.remove();
    await closeServer(peer.socket);
  });

  // 1-6: bindEx records the socket file right after the bind (SPEC
  // "remove"), so a symlink on the way changed before the bind leads the
  // record to where the bind went, and remove() leaves the socket that was
  // at the old target alone.
  test("bindEx records the file where the bind went, not where the path led before", async () => {
    const root = shortDir();
    fs.mkdirSync(`${root}/a`);
    fs.mkdirSync(`${root}/b`);
    fs.symlinkSync(`${root}/a`, `${root}/sym`);
    const other = await standardListen(`${root}/a/s.sock`);
    const b = await bindExIn(world(), `${root}/sym/s.sock`, {}, (spelling) => {
      fs.unlinkSync(`${root}/sym`);
      fs.symlinkSync(`${root}/b`, `${root}/sym`);
      return listenAt(spelling);
    });
    assert.ok(fs.lstatSync(`${root}/b/s.sock`).isSocket());
    b.file.remove();
    assert.equal(fs.existsSync(`${root}/b/s.sock`), false);
    assert.ok(fs.lstatSync(`${root}/a/s.sock`).isSocket(), "the other socket stays");
    await closeServer(b.socket);
    await closeServer(other);
  });

  // 2-1: Options.base with a NUL is an argument error whatever the path,
  // short and abstract included (SPEC "エラー").
  test("Options.base with a NUL is an argument error for a short path too", async () => {
    for (const p of [`${shortDir()}/s.sock`, "\0stt-abstract"]) {
      const e = await rejection(bindExIn(world(), p, { base: "/tmp/a\0b" }));
      assert.ok(e.error instanceof TypeError, p);
      assert.equal(e["code"], "ERR_INVALID_ARG_VALUE");
    }
  });

  // 2-4: a place passed over as taken stays in the reason when the next
  // place is then too long for any spelling.
  test("the reason keeps the taken place when the next one is too long", async () => {
    const p = freshPlace();
    fs.mkdirSync(`${p}/sockat-${uid}`);
    fs.chmodSync(`${p}/sockat-${uid}`, 0o777);
    const deep = deepDir(shortDir(), 120);
    fs.chmodSync(deep, 0o700);
    const w = world({ tmp: p, proc: "", getenv: (n) => (n === "TMPDIR" ? deep : undefined) });
    const e = await rejection(bindExIn(w, `${deepDir(tempDir())}/s.sock`, {}));
    assert.equal(e["code"], "ENAMETOOLONG");
    assert.match(JSON.stringify(e["skipped"]), /spelling too long \([^)]*sockat-\d+ taken/);
  });

  // 2-3: the default bind's estimate of the spelling counts the shared E
  // its D has for the directory, not the next counter: with the counter
  // grown to 3 characters, a name that fits only through the 1-character
  // shared E still binds through it.
  test("the default bind estimates with the shared E's name", async () => {
    // link-file is left out so that only link-dir can bind the name.
    const w = world({ tmp: freshPlace(), proc: "", bindFollows: "no" });
    const dir = deepDir(tempDir());
    const first = await bindIn(w, `${dir}/a.sock`);
    const b = w.auto;
    assert.ok(b !== null && b.d !== null);
    b.nextE = 36 * 36;
    const max = w.cfg.spellingLength;
    const name = "n".repeat(max - Buffer.byteLength(`${b.real}/${b.d.name}/0/`));
    const second = await bindIn(w, `${dir}/${name}`);
    assert.ok(fs.lstatSync(`${dir}/${name}`).isSocket());
    await closeServer(first);
    await closeServer(second);
  });

  // 3-1: the standard length never exceeds the sockaddr length: Node on
  // Linux is 107 too, not 108 (DR-0003).
  test("the standard length is the sockaddr length on every system", () => {
    for (const os of ["linux", "darwin", "freebsd", "netbsd", "openbsd", "illumos", "other"] as const) {
      assert.equal(standardLength(os), sockaddrLength(os), os);
    }
    assert.equal(world().cfg.standardLength, world().cfg.spellingLength);
  });
});
