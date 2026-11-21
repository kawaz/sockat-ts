import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { bindEx } from "../src/index.ts";
import { bindExIn, listenAt } from "../src/netapi.ts";
import { closeServer, deepDir, linksInB, placeB, rejection, shortDir, tempDir, thrown, world } from "./helpers.ts";

describe("SocketFile", () => {
  // SPEC "remove": the file goes and the listener stays open; a second call
  // does nothing; cleanup after it does nothing either.
  test("remove takes the file and leaves the listener open, once", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const before = linksInB(placeB()).length;
    const b = await bindEx(path);
    b.file.remove();
    assert.equal(fs.existsSync(path), false);
    assert.ok(b.socket.listening);
    b.file.remove();
    b.file.cleanup();
    assert.equal(linksInB(placeB()).length, before);
    await closeServer(b.socket);
  });

  // SPEC "remove": a file that replaced the socket while the listener is
  // open (another (st_dev, st_ino)) is left alone, without an error.
  test("remove leaves a file that replaced the socket", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const b = await bindEx(path);
    fs.unlinkSync(path);
    fs.writeFileSync(path, "other");
    b.file.remove();
    assert.equal(fs.readFileSync(path, "utf8"), "other");
    await closeServer(b.socket);
  });

  // SPEC "cleanup": after the cleanup no E is left; the socket file stays.
  test("cleanup takes the E and leaves the socket file", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const before = linksInB(placeB()).length;
    const b = await bindEx(path);
    assert.equal(linksInB(placeB()).length, before + 1);
    b.file.cleanup();
    assert.equal(linksInB(placeB()).length, before);
    assert.ok(fs.lstatSync(path).isSocket());
    b.file.remove();
    await closeServer(b.socket);
  });
});

const root = process.geteuid?.() === 0;

describe("SocketFile, more", () => {
  // SPEC "remove と cleanup": a call that failed is tried again by the next
  // (a failure is not remembered). The unlink of E fails while its D cannot
  // be written to, and of the socket file while its directory cannot;
  // once they can, the same calls finish the job.
  test("remove and cleanup that failed are tried again", { skip: root && "permissions do not hold for root" }, async () => {
    const w = world();
    const dir = deepDir(tempDir());
    const path = `${dir}/s.sock`;
    const b = await bindExIn(w, path, {});
    const base = w.auto;
    assert.ok(base !== null && base.d !== null);
    const d = `${base.real}/${base.d.name}`;
    fs.chmodSync(d, 0o511);
    assert.equal(thrown(() => b.file.cleanup())["code"], "EACCES");
    fs.chmodSync(d, 0o711);
    b.file.cleanup();
    fs.chmodSync(dir, 0o500);
    assert.equal(thrown(() => b.file.remove())["code"], "EACCES");
    fs.chmodSync(dir, 0o700);
    b.file.remove();
    assert.equal(fs.existsSync(path), false);
    await closeServer(b.socket);
  });

  // SPEC "remove": where bind(2) follows a symlink in the last component
  // (macOS), the socket is made where the symlink leads; remove() takes that
  // socket and leaves the caller's symlink.
  test("remove takes the socket a symlink at the path led to, and leaves the symlink", { skip: world().cfg.bindFollows !== "yes" && "bind does not follow a symlink here" }, async () => {
    const dir = shortDir();
    fs.symlinkSync(`${dir}/real.sock`, `${dir}/link.sock`);
    const b = await bindEx(`${dir}/link.sock`);
    assert.ok(fs.lstatSync(`${dir}/real.sock`).isSocket());
    b.file.remove();
    assert.equal(fs.existsSync(`${dir}/real.sock`), false);
    assert.ok(fs.lstatSync(`${dir}/link.sock`).isSymbolicLink());
    await closeServer(b.socket);
  });

  // When bindEx cannot record the socket file (here: replaced by a regular
  // file right after the bind), the error is general and the replacement
  // stays: E is removed before the listener is closed, so the close unlinks
  // a spelling that names nothing.
  test("bindEx that cannot record the socket leaves what replaced it (long path)", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const e = await rejection(
      bindExIn(world(), path, {}, async (spelling) => {
        const a = await listenAt(spelling);
        if (a.ok) {
          fs.unlinkSync(path);
          fs.writeFileSync(path, "precious");
        }
        return a;
      }),
    );
    assert.equal(e["code"], undefined);
    assert.equal(e["route"], "link-dir");
    assert.match(e.error.message, /what is at the path left/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.readFileSync(path, "utf8"), "precious");
  });

  // A short path goes to the standard as it is, and the standard's close
  // unlinks the path: what replaced the socket goes with it (SPEC からの
  // 外れ, README). The error says so.
  test("bindEx that cannot record the socket says the close unlinked a short path", async () => {
    const path = `${shortDir()}/s.sock`;
    const e = await rejection(
      bindExIn(world(), path, {}, async (spelling) => {
        const a = await listenAt(spelling);
        if (a.ok) {
          fs.unlinkSync(path);
          fs.writeFileSync(path, "precious");
        }
        return a;
      }),
    );
    assert.equal(e["route"], "standard");
    assert.match(e.error.message, /which unlinks the path/);
  });
});
