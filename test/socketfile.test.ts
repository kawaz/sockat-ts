import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import { bindEx } from "../src/index.ts";
import { closeServer, deepDir, linksInB, placeB, tempDir } from "./helpers.ts";

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
