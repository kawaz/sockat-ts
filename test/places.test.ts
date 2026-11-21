import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { bindExIn, connectExIn } from "../src/netapi.ts";
import { resolveForBindIn } from "../src/resolve.ts";
import { closeServer, deepDir, listing, rejection, shortDir, tempDir, world } from "./helpers.ts";

const uid = process.geteuid?.() ?? 0;

/** A fresh place standing in for /tmp (1777, as /tmp is). */
function freshPlace(): string {
  const p = shortDir();
  fs.chmodSync(p, 0o1777);
  return p;
}

describe("places of B", () => {
  // SPEC-routes "B の作り方" step 5: a sockat-<uid> already there that fails
  // the check (taken: here others can write to it) makes its place
  // unusable. Nothing is made there (no B of another name), and B goes to
  // the next place ($TMPDIR here).
  test("a taken B of the default name passes the place over to the next", async () => {
    const p = freshPlace();
    fs.mkdirSync(`${p}/sockat-${uid}`);
    fs.chmodSync(`${p}/sockat-${uid}`, 0o777);
    const next = shortDir();
    fs.chmodSync(next, 0o700);
    const w = world({ tmp: p, getenv: (n) => (n === "TMPDIR" ? next : undefined) });
    const b = await bindExIn(w, `${deepDir(tempDir())}/s.sock`, {});
    assert.equal(w.auto?.kind, "tmpdir");
    assert.deepEqual(listing(p), [`sockat-${uid}/`]);
    assert.deepEqual(listing(`${p}/sockat-${uid}`), []);
    assert.equal(fs.statSync(`${p}/sockat-${uid}`).mode & 0o777, 0o777);
    b.file.remove();
    await closeServer(b.socket);
  });

  // SPEC "診断": with the only place taken, the routes through B cannot be
  // used, and their reason says the B was taken (fails the checks).
  test("with the only place taken, the reason of the routes through B says so", async () => {
    const p = freshPlace();
    fs.mkdirSync(`${p}/sockat-${uid}`);
    fs.chmodSync(`${p}/sockat-${uid}`, 0o777);
    const w = world({ tmp: p, proc: "" });
    const e = await rejection(connectExIn(w, `${deepDir(shortDir())}/s.sock`, {}));
    assert.equal(e["code"], "ENAMETOOLONG");
    assert.match(JSON.stringify(e["skipped"]), /sockat-\d+ taken \(fails the checks\)/);
    assert.deepEqual(listing(p), [`sockat-${uid}/`]);
  });

  // SPEC-routes "実体の置き場": a B or D held that was removed (by a hand, an
  // old systemd-tmpfiles, macOS's cleaning of $TMPDIR) is let go and made
  // again by the next call.
  test("a removed D, and a removed B, are made again", () => {
    const w = world({ tmp: freshPlace() });
    const path = `${deepDir(tempDir())}/s.sock`;
    resolveForBindIn(w, path, {}).cleanup();
    const b0 = w.auto;
    assert.ok(b0 !== null && b0.d !== null);
    const d0 = b0.d.name;
    fs.rmSync(`${b0.real}/${d0}`, { recursive: true });
    resolveForBindIn(w, path, {}).cleanup();
    assert.ok(w.auto?.d !== null && w.auto?.d?.name !== d0, "D made again");
    assert.ok(fs.existsSync(`${b0.real}/${w.auto?.d?.name}`));
    fs.rmSync(b0.real, { recursive: true });
    resolveForBindIn(w, path, {}).cleanup();
    assert.ok(w.auto !== null && w.auto !== b0, "B made again");
    assert.ok(fs.statSync(w.auto.real).isDirectory());
  });

  // SPEC "bind の順": with usableCrossUid and no place others can search
  // (here the only place is 0700), the bind does not fall back to a spelling
  // others cannot follow: link-dir (and link-file) are unusable and, with no
  // thread-cwd here, the bind is ENAMETOOLONG.
  test("usableCrossUid with no place others can follow is ENAMETOOLONG, not a spelling they cannot follow", async () => {
    const p = shortDir();
    fs.chmodSync(p, 0o700);
    const e = await rejection(bindExIn(world({ tmp: p }), `${deepDir(tempDir())}/s.sock`, { usableCrossUid: true }));
    assert.equal(e["code"], "ENAMETOOLONG");
    assert.ok(JSON.stringify(e["skipped"]).includes("no base others can follow"));
    assert.deepEqual(listing(p), []);
  });

  // SPEC-routes "実体の置き場": B itself found without others' search
  // permission is looked at again by its fd at each usableCrossUid call (a
  // process making B at the same time may have opened it between its mkdir
  // 0700 and its chmod 0711): once B is 0711, the spelling is usableCrossUid.
  test("B found without others' search permission is looked at again for usableCrossUid", async () => {
    const p = freshPlace();
    fs.mkdirSync(`${p}/sockat-${uid}`, { mode: 0o700 });
    fs.chmodSync(`${p}/sockat-${uid}`, 0o700);
    const w = world({ tmp: p });
    const path = `${deepDir(tempDir())}/s.sock`;
    resolveForBindIn(w, path, {}).cleanup();
    assert.equal(w.auto?.selfX, false);
    fs.chmodSync(`${p}/sockat-${uid}`, 0o711);
    const b = await bindExIn(w, path, { usableCrossUid: true });
    assert.ok(b.spelling.kind === "Linked" && b.spelling.usableCrossUid);
    b.file.remove();
    await closeServer(b.socket);
  });

  // SPEC-routes "実体の置き場" place 4: with no place 1 to 3, B is made in the
  // socket's directory (.sockat.<random>) and spelt by procB only (its real
  // path is longer than the path). Where /proc cannot be used there is no
  // such spelling, so the bind is ENAMETOOLONG.
  test("with no other place, B goes in the socket's directory and is spelt by procB", async () => {
    const dir = deepDir(tempDir());
    const w = world({ tmp: "/nonexistent-stt-place" });
    if (w.cfg.os === "linux") {
      const b = await bindExIn(w, `${dir}/s.sock`, {});
      assert.equal(b.base, "sockdir");
      assert.ok(b.spelling.kind === "Linked" && b.spelling.until === "Process");
      assert.ok(listing(dir).some((e) => /^\.sockat\.[A-Za-z0-9]{10}\/$/.test(e)));
      b.file.remove();
      await closeServer(b.socket);
    } else {
      const e = await rejection(bindExIn(w, `${dir}/s.sock`, {}));
      assert.equal(e["code"], "ENAMETOOLONG");
    }
  });

  // SPEC-routes "D と E": a lock that is busy for every name (here flock(1)
  // stood in for by false(1), exit 1) leaves no empty D behind per name
  // tried; D cannot be made and the bind is ENAMETOOLONG.
  test("a lock that is always busy leaves no D behind", async () => {
    const p = freshPlace();
    const w = world({ tmp: p, lock: { kind: "flock-command", command: "false" } });
    const e = await rejection(bindExIn(w, `${deepDir(tempDir())}/s.sock`, {}));
    assert.equal(e["code"], "ENAMETOOLONG");
    assert.deepEqual(listing(`${p}/sockat-${uid}`), []);
  });
});
