import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { bindExIn, connectExIn } from "../src/netapi.ts";
import { closeServer, deepDir, listing, rejection, shortDir, tempDir, world } from "./helpers.ts";

// SPEC "用語" (/proc を使える) checks /proc three ways, each where it is
// used: the connect row by / opened for it, proc-direct by the socket's
// directory's fd at each call, procB (its estimate included) by
// /proc/<pid>/fd/<fd>. The tests stand a directory in for /proc whose fd
// entries are symlinks, so a PID namespace that disagrees with the /proc
// mounted can be played: every entry names the directory given.

const linux = world().cfg.os === "linux";

/** A stand-in for /proc where self/fd/<n> and <pid>/fd/<n> (n < 1024) all name target. */
function fakeProc(target: string, which: readonly ("self" | "pid")[]): string {
  const p = tempDir();
  for (const w of which) {
    const fd = `${p}/${w === "self" ? "self" : String(process.pid)}/fd`;
    fs.mkdirSync(fd, { recursive: true });
    for (let n = 0; n < 1024; n++) {
      fs.symlinkSync(target, `${fd}/${n}`);
    }
  }
  return p;
}

describe("/proc checks", { skip: !linux && "Linux only" }, () => {
  // The connect row: where /proc/self/fd/<fd of /> names something other
  // than /, the row without proc-direct (relative) is the call's.
  test("a /proc that does not name / takes the relative row", async () => {
    const path = `${deepDir(shortDir())}/s.sock`;
    const peer = await bindExIn(world(), path, {});
    const w = world({ proc: fakeProc(tempDir(), ["self", "pid"]) });
    const c = await connectExIn(w, path, {});
    assert.ok(!c.skipped.some((s) => s.name === "proc-direct"));
    assert.ok(c.skipped.some((s) => s.name === "relative") || c.route === "relative");
    c.socket.destroy();
    peer.file.remove();
    await closeServer(peer.socket);
  });

  // proc-direct checks the fd it uses: with every /proc/self/fd entry
  // naming /, the row is proc-direct's (the check of / passes) but the
  // socket's directory's fd is not named, so proc-direct is skipped with
  // that reason and link-file connects.
  test("proc-direct checks the socket's directory's fd at each call", async () => {
    const path = `${deepDir(shortDir())}/s.sock`;
    const peer = await bindExIn(world(), path, {});
    const w = world({ proc: fakeProc("/", ["self"]) });
    const c = await connectExIn(w, path, {});
    assert.equal(c.route, "link-file");
    assert.ok(JSON.stringify(c.skipped).includes("does not name the socket's directory"));
    c.socket.destroy();
    peer.file.remove();
    await closeServer(peer.socket);
  });

  // procB's estimate checks /proc/<pid>/fd as procB does: where it names
  // something else, procB is not counted on, so a place too deep for a
  // real-path spelling gets no B (nothing made there) and the bind is
  // ENAMETOOLONG.
  test("procB's estimate does not count on a /proc that does not name the fd", async () => {
    const deep = deepDir(shortDir(), 100);
    fs.chmodSync(deep, 0o700);
    const w = world({ tmp: deep, proc: fakeProc(tempDir(), ["self", "pid"]) });
    const e = await rejection(bindExIn(w, `${deepDir(tempDir())}/s.sock`, {}));
    assert.equal(e["code"], "ENAMETOOLONG");
    assert.ok(!listing(deep).some((n) => n.startsWith("sockat-")), JSON.stringify(listing(deep)));
  });
});
