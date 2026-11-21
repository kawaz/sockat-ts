import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { connect, connectEx, listen, listenEx } from "../src/bun.ts";
import { listenExIn, listenIn } from "../src/bunapi.ts";
import { deepDir, linksInB, listing, placeB, rejection, shortDir, skippedNames, tempDir, thrown, world } from "./helpers.ts";

// @kawaz/sockat/bun runs on Bun only: under Node these tests are skipped.
const onBun = typeof process.versions["bun"] === "string";
const os = world().cfg.os;

/** A fresh place standing in for /tmp (1777). */
function shortDirSticky(): string {
  const p = shortDir();
  fs.chmodSync(p, 0o1777);
  return p;
}

/** Echoing socket handlers for Bun.listen. */
const echoing = {
  data(s: { write(d: Uint8Array): number }, d: Uint8Array): void {
    s.write(d);
  },
};

/** Connects with Bun.connect through sockat, sends x and resolves with the reply. */
function roundTrip(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    connect({
      unix: path,
      socket: {
        open(s) {
          s.write("x");
        },
        data(s, d) {
          s.terminate();
          resolve(Buffer.from(d).toString());
        },
      },
    }).catch(reject);
  });
}

describe("@kawaz/sockat/bun", { skip: !onBun && "Bun only" }, () => {
  // A short path goes to Bun.listen as it is: the listener is Bun's own and
  // its unix is the path.
  test("a short path listens and connects through Bun's own sockets", async () => {
    const path = `${shortDir()}/s.sock`;
    const l = listen({ unix: path, socket: echoing });
    assert.equal(l.unix, path);
    assert.equal(await roundTrip(path), "x");
    l.stop(true);
  });

  // A long path listens by link-dir with Bun.listen, synchronously; the
  // listener's unix is the caller's path (DR-0002); connectEx reaches it.
  test("a long path listens by link-dir and its unix is the path", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const b = listenEx({ unix: path, socket: echoing });
    assert.equal(b.route, "link-dir");
    assert.equal(b.socket.unix, path);
    assert.ok(fs.lstatSync(path).isSocket());
    const c = await connectEx({ unix: path, socket: { data() {} } });
    assert.equal(c.skipped[0]?.name, "standard");
    c.socket.terminate();
    assert.equal(await roundTrip(path), "x");
    b.file.remove();
    assert.equal(fs.existsSync(path), false);
    b.socket.stop(true);
  });

  // DR-0002 "listener を閉じた時": stopping unlinks the spelling Bun was
  // given. Through link-dir's E that is the socket file at the path (as the
  // standard does for a short path).
  test("stopping a link-dir listener removes the socket file through E", () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const l = listen({ unix: path, socket: echoing });
    l.stop(true);
    assert.equal(fs.existsSync(path), false);
  });

  // The hub's research saw Bun.listen fail with EADDRINUSE through
  // link-file on macOS; a socket file left at the target by an earlier bind
  // was there. With nothing at the path, Bun.listen follows the symlink as
  // node:net does: a long file name binds by link-file, and stopping it
  // removes the E only (the socket file stays, SPEC "長いパスで標準と違う点").
  test("a long file name listens by link-file where bind follows a symlink", { skip: os !== "darwin" && "bind follows a symlink only on macOS here" }, () => {
    const path = `${deepDir(tempDir())}/${"n".repeat(100)}`;
    const before = linksInB(placeB()).length;
    const b = listenExIn(world(), { unix: path, socket: echoing }, {});
    assert.equal(b.route, "link-file");
    assert.equal(b.socket.unix, path);
    assert.ok(fs.lstatSync(path).isSocket());
    b.socket.stop(true);
    assert.ok(fs.lstatSync(path).isSocket(), "the socket file stays");
    assert.equal(linksInB(placeB()).length, before, "the E is gone");
    b.file.remove();
    assert.equal(fs.existsSync(path), false);
  });

  // A route that binds and fails throws the errno with the caller's path and
  // the route, in Node's shape; its E is gone.
  test("a long path with a file there is EADDRINUSE from link-dir", () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    fs.writeFileSync(path, "");
    const e = thrown(() => listenEx({ unix: path, socket: echoing }));
    assert.equal(e["code"], "EADDRINUSE");
    assert.equal(e["route"], "link-dir");
    assert.equal(e["path"], path);
    assert.deepEqual(skippedNames(e), ["standard"]);
  });

  // connect to nothing at a long path is ENOENT from the route that connected.
  test("connect to a missing socket at a long path is ENOENT", async () => {
    const path = `${deepDir(tempDir())}/none.sock`;
    const e = await rejection(connectEx({ unix: path, socket: { data() {} } }));
    assert.equal(e["code"], "ENOENT");
    assert.ok(typeof e["route"] === "string");
  });
});

describe("@kawaz/sockat/bun, more", { skip: !onBun && "Bun only" }, () => {
  // SPEC-routes "link-dir": Bun's default listen, like the default bind,
  // shares one link-dir E per socket's directory; listenEx makes its own.
  test("default listens into one directory share one link-dir E", () => {
    const w = world({ tmp: shortDirSticky() });
    const dir = deepDir(tempDir());
    const ls = [0, 1, 2].map((i) => listenIn(w, { unix: `${dir}/s${i}.sock`, socket: echoing }));
    const b = w.auto;
    assert.ok(b !== null && b.d !== null);
    const d = `${b.real}/${b.d.name}`;
    assert.equal(fs.readdirSync(d).length, 1);
    const x = listenExIn(w, { unix: `${dir}/x.sock`, socket: echoing }, {});
    assert.equal(fs.readdirSync(d).length, 2);
    x.file.remove();
    x.socket.stop(true);
    for (const l of ls) {
      l.stop(true);
    }
  });

  // DR-0002: the listener's unix is the path given, after stop() too, as
  // Bun's own listener keeps the path it was given.
  test("a long path's listener's unix is the path, after stop too", () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const l = listen({ unix: path, socket: echoing });
    assert.equal(l.unix, path);
    l.stop(true);
    assert.equal(l.unix, path);
  });
});

describe("@kawaz/sockat/bun without Bun", { skip: onBun && "Node only" }, () => {
  // Used without Bun, the entry throws at once, before anything is made in
  // the places.
  test("throws at once and makes nothing", async () => {
    const before = listing(placeB());
    assert.throws(() => listen({ unix: `${deepDir(tempDir())}/s.sock`, socket: echoing }), /needs Bun/);
    await assert.rejects(connect({ unix: `${deepDir(tempDir())}/s.sock`, socket: { data() {} } }), /needs Bun/);
    assert.deepEqual(listing(placeB()), before);
  });
});
