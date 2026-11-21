import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import nodePath from "node:path";
import { describe, test } from "node:test";
import { bindEx, connect, resolveForBind, resolveForConnect } from "../src/index.ts";
import { closeServer, deepDir, echo, roundTrip, tempDir } from "./helpers.ts";

// The code README recommends (README-ja.md "使ってはいけない書き方",
// "ソケットのファイルを消す", "resolve"), run as it is written there, so
// what it promises holds.

describe("README's recommended code", () => {
  // Bind by an absolute path (path.resolve before the bind, so a later
  // chdir cannot retarget it), and remove the file before closing the
  // listener: the file is gone and nothing else is touched.
  test("bind an absolute path and remove before closing", async () => {
    const dir = deepDir(tempDir());
    const relative = nodePath.relative(process.cwd(), `${dir}/s.sock`);
    const b = await bindEx(nodePath.resolve(relative));
    try {
      echo(b.socket);
      assert.equal(await roundTrip(await connect(`${dir}/s.sock`)), "x");
    } finally {
      b.file.remove();
      b.socket.close();
    }
    assert.equal(fs.existsSync(`${dir}/s.sock`), false);
  });

  // A spelling meant for a peer of another uid is checked: with
  // usableCrossUid the spelling is Linked and usableCrossUid (the tests'
  // place lets others search), so the check passes.
  test("check that a spelling for another uid was met", () => {
    const f = resolveForBind(`${deepDir(tempDir())}/s.sock`, { usableCrossUid: true });
    if (f.spelling.kind === "Linked" && !f.spelling.usableCrossUid) {
      throw new Error("no spelling another uid can follow");
    }
    f.cleanup();
  });

  // resolveForBind: bind the spelling yourself, record the file after the
  // bind and before the close, remove it; resolveForConnect: connect by the
  // spelling as many times as wanted, then clean up.
  test("bind and connect through resolve", async () => {
    const path = `${deepDir(tempDir())}/s.sock`;
    const f = resolveForBind(path);
    const server = net.createServer().listen(f.path);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    echo(server);
    const file = f.socketFile();
    const c = resolveForConnect(path);
    for (let i = 0; i < 2; i++) {
      const socket = net.connect({ path: c.path });
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      assert.equal(await roundTrip(socket), "x");
    }
    c.cleanup();
    file.remove();
    assert.equal(fs.existsSync(path), false);
    await closeServer(server);
  });
});
