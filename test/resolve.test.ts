import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { describe, test } from "node:test";
import { resolveForBind, resolveForConnect } from "../src/index.ts";
import { resolveForBindIn } from "../src/resolve.ts";
import { closeServer, deepDir, echo, linksInB, placeB, roundTrip, standardListen, tempDir, thrown, world } from "./helpers.ts";


function listen(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    echo(s);
    s.once("error", reject);
    s.listen(path, () => resolve(s));
  });
}

function connectTo(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path);
    s.once("connect", () => resolve(s)).once("error", reject);
  });
}

describe("resolve", () => {
  // A path the standard takes is spelt as it is: Original for an absolute
  // path, CwdRelative for a relative one, with no E to clean up.
  test("a short path is its own spelling", () => {
    const f = resolveForBind("/tmp/stt-short.sock");
    assert.equal(f.path, "/tmp/stt-short.sock");
    assert.deepEqual(f.spelling, { kind: "Original" });
    assert.equal(f.route, "standard");
    assert.deepEqual(resolveForBind("rel.sock").spelling, { kind: "CwdRelative" });
    f.cleanup();
    assert.equal(resolveForConnect("/tmp/stt-short.sock").path, "/tmp/stt-short.sock");
  });

  // resolveForBind of a long path: a Linked spelling short enough for the
  // standard, naming the same place. socketFile() before the bind is an
  // error (nothing to record); after the bind it records the socket, and its
  // remove() takes the file, its cleanup the E.
  test("resolveForBind spells a long path that the standard binds, and socketFile removes it", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const before = linksInB(placeB()).length;
    const f = resolveForBind(path);
    assert.equal(f.spelling.kind, "Linked");
    assert.ok(Buffer.byteLength(f.path) <= world().cfg.standardLength);
    assert.equal(f.route, "link-dir");
    assert.equal(thrown(() => f.socketFile())["code"], "ENOENT");
    const server = await listen(f.path);
    assert.ok(fs.lstatSync(path).isSocket());
    const sf = f.socketFile();
    sf.remove();
    assert.equal(fs.existsSync(path), false);
    assert.equal(linksInB(placeB()).length, before);
    sf.remove();
    f.cleanup();
    await closeServer(server);
  });

  // SPEC "ForBind の SocketFile": the file recorded after the bind is the one
  // removed; a file put at the path in its place is left alone.
  test("socketFile's remove leaves a file that replaced the socket", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const f = resolveForBind(path);
    const server = await listen(f.path);
    const sf = f.socketFile();
    fs.unlinkSync(path);
    fs.writeFileSync(path, "other");
    sf.remove();
    assert.equal(fs.readFileSync(path, "utf8"), "other");
    await closeServer(server);
  });

  // SPEC "ForBind の SocketFile": what the spelling leads to must be a
  // socket; a regular file at the path (not bound) is ENOTSOCK.
  test("socketFile of a path that leads to a file, not a socket, is ENOTSOCK", () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const f = resolveForBind(path);
    fs.writeFileSync(path, "");
    assert.equal(thrown(() => f.socketFile())["code"], "ENOTSOCK");
    f.cleanup();
  });

  // resolveForConnect: link-file through the process's D, used for as many
  // connects as wanted, and after cleanup() the spelling names nothing.
  test("resolveForConnect spells a long path for repeated connects until cleanup", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const server = await standardListenLong(path);
    const f = resolveForConnect(path);
    assert.equal(f.route, "link-file");
    for (let i = 0; i < 3; i++) {
      assert.equal(await roundTrip(await connectTo(f.path)), "x");
    }
    f.cleanup();
    await assert.rejects(connectTo(f.path), { code: "ENOENT" });
    await closeServer(server.server);
    server.remove();
  });

  // SPEC "resolve": a length only thread-cwd / at could reach is
  // ENAMETOOLONG for resolveForBind (link-file only where bind is measured
  // to follow a symlink).
  test("resolveForBind of a file name no spelling fits is ENAMETOOLONG", () => {
    const path = `${deepDir(tempDir())}/${"n".repeat(100)}`;
    const w = world();
    if (w.cfg.bindFollows === "yes") {
      const f = resolveForBindIn(w, path, {});
      assert.equal(f.route, "link-file");
      assert.ok(f.spelling.kind === "Linked" && !f.spelling.removable);
      f.cleanup();
    } else {
      const e = thrown(() => resolveForBindIn(w, path, {}));
      assert.equal(e["code"], "ENAMETOOLONG");
      assert.equal(e["route"], null);
    }
  });

  // The resolve of a long path with the directory missing is ENOENT.
  test("a resolve of a missing directory is ENOENT", () => {
    const e = thrown(() => resolveForConnect(`${deepDir(tempDir())}/no/s.sock`));
    assert.equal(e["code"], "ENOENT");
    assert.deepEqual(e["skipped"], []);
  });
});

/** A listener at a long path through a resolve, with its removal. */
async function standardListenLong(path: string): Promise<{ server: net.Server; remove: () => void }> {
  const f = resolveForBind(path);
  const server = await standardListen(f.path);
  const sf = f.socketFile();
  return { server, remove: () => sf.remove() };
}

