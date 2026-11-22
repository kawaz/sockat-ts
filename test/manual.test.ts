import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { describe, test } from "node:test";
import * as sockatBun from "../src/bun.ts";
import * as sockat from "../src/index.ts";
import { closeServer, deepDir, echo, roundTrip, shortDir, tempDir } from "./helpers.ts";

// The code of the user manual (docs/manual/) and of the reference's
// recommended code (docs/REFERENCE-ja.md "使ってはいけない書き方"), run as it
// is written there so that what the pages show works. Each test destructures
// what the page imports and then runs the page's code verbatim (the last
// test checks that every code block of the pages appears here as it is).

const onBun = typeof process.versions["bun"] === "string";
const bunOnly = { skip: !onBun && "Bun only" };

/** A socket path over every standard length. */
function longPath(): string {
  return `${deepDir(tempDir())}/s.sock`;
}

/** Connects to path, sends x and resolves with what comes back. */
async function ask(path: string): Promise<string> {
  return roundTrip(await sockat.connect(path));
}

/** Connects to path and resolves with all it sends before it ends. */
async function readAll(path: string): Promise<string> {
  const socket = await sockat.connect(path);
  let got = "";
  socket.on("data", (b) => {
    got += b.toString();
  });
  await once(socket, "end");
  socket.destroy();
  return got;
}

describe("docs/manual/bind", () => {
  // node:net: bind resolves with a listening net.Server at a long path.
  test("listen with node:net", async () => {
    const { bind } = sockat;
    const path = longPath();
    const server = await bind(path); // net.Server, listening
    server.on("connection", (socket) => socket.end("hello\n"));
    assert.equal(await readAll(path), "hello\n");
    await closeServer(server);
  });

  // Bun.listen: listen takes Bun.listen's options with a long unix path.
  test("listen with Bun.listen", bunOnly, async () => {
    const { listen } = sockatBun;
    const path = longPath();
    const listener = listen({
      unix: path,
      socket: {
        data(socket, data) {
          socket.write(data);
        },
      },
    });
    assert.equal(await ask(path), "x");
    listener.stop(true);
  });

  // bindEx: remove() before closing leaves no socket file behind.
  test("remove the socket file when done", async () => {
    const { bindEx } = sockat;
    const path = longPath();
    const b = await bindEx(path);
    try {
      // serve on b.socket
    } finally {
      b.file.remove(); // before closing
      b.socket.close();
    }
    assert.equal(fs.existsSync(path), false);
  });

  // listenEx: the same with Bun.listen.
  test("remove the socket file when done (Bun)", bunOnly, () => {
    const { listenEx } = sockatBun;
    const path = longPath();
    const b = listenEx({ unix: path, socket: { data() {} } });
    try {
      // serve on b.socket
    } finally {
      b.file.remove(); // before stopping
      b.socket.stop(true);
    }
    assert.equal(fs.existsSync(path), false);
  });

  // Options.base: a long path's spelling goes through the B given (made
  // there), and sweepBase before it exists is no error.
  test("choose the place yourself", async () => {
    const { bindEx, sweepBase } = sockat;
    const path = longPath();
    const base = `${shortDir()}/sockat`;
    // base: a directory the application manages, such as "/run/myapp/sockat"
    sweepBase(base);
    const b = await bindEx(path, { base });
    echo(b.socket);
    assert.equal(b.base, "given");
    assert.equal(await ask(path), "x");
    b.file.remove();
    await closeServer(b.socket);
  });

  // usableCrossUid: the spelling of a long path is one another uid can
  // follow (the tests' place lets others search, as /tmp does).
  test("let a process of another user connect", async () => {
    const { bindEx } = sockat;
    const path = longPath();
    const b = await bindEx(path, { usableCrossUid: true });
    assert.ok(b.spelling.kind === "Linked" && b.spelling.usableCrossUid, JSON.stringify(b.spelling));
    b.file.remove();
    await closeServer(b.socket);
  });

  // sweep: removes what ended processes left, and nothing of this one.
  test("clean up what earlier processes left", async () => {
    const { sweep } = sockat;
    const path = longPath();
    const server = await sockat.bind(path);
    echo(server);
    sweep();
    assert.equal(await ask(path), "x");
    await closeServer(server);
  });
});

describe("docs/manual/connect", () => {
  // node:net: connect resolves with a connected net.Socket.
  test("connect with node:net", async () => {
    const { connect } = sockat;
    const path = longPath();
    const server = await sockat.bind(path);
    const got = new Promise<string>((resolve) => {
      server.on("connection", (s) => {
        let d = "";
        s.on("data", (b) => {
          d += b.toString();
        });
        s.on("end", () => resolve(d));
      });
    });
    const socket = await connect(path); // net.Socket, connected
    socket.end("hello\n");
    assert.equal(await got, "hello\n");
    await closeServer(server);
  });

  // Bun.connect: connect takes Bun.connect's options with a long unix path.
  test("connect with Bun.connect", bunOnly, async () => {
    const { connect } = sockatBun;
    const path = longPath();
    const server = await sockat.bind(path);
    echo(server);
    const socket = await connect({
      unix: path,
      socket: {
        data(_socket, data) {
          console.log(data.toString());
        },
      },
    });
    socket.write("hello\n");
    socket.end();
    await closeServer(server);
  });
});

describe("docs/manual/resolve", () => {
  // resolveForBind with node:net's listen: socketFile after it listens,
  // remove before closing.
  test("hand it to node:net's listen", async () => {
    const { resolveForBind } = sockat;
    const path = longPath();
    const f = resolveForBind(path);
    const server = net.createServer().listen(f.path);
    await once(server, "listening");
    const file = f.socketFile(); // after it listens, before it is closed
    try {
      // serve
    } finally {
      file.remove();
      server.close();
    }
    assert.equal(fs.existsSync(path), false);
  });

  // resolveForBind with Bun.serve: it listens at the long path, and the
  // file is removed (what it serves is in "connect with fetch").
  test("hand it to Bun.serve", bunOnly, async () => {
    const { resolveForBind } = sockat;
    const path = longPath();
    const f = resolveForBind(path);
    const server = Bun.serve({ unix: f.path, fetch: () => new Response("hello\n") });
    const file = f.socketFile();
    try {
      // serve
    } finally {
      file.remove();
      await server.stop();
    }
    assert.equal(fs.existsSync(path), false);
  });

  // resolveForConnect: the spelling connects as many times as wanted until
  // cleanup.
  test("connect many times", async () => {
    const { resolveForConnect } = sockat;
    const path = longPath();
    const server = await sockat.bind(path);
    let n = 0;
    const both = new Promise<void>((resolve) => {
      server.on("connection", (s) => {
        s.resume();
        if (++n === 2) {
          resolve();
        }
      });
    });
    const f = resolveForConnect(path);
    for (let i = 0; i < 2; i++) {
      const socket = net.connect(f.path);
      await once(socket, "connect");
      socket.end("hello\n");
    }
    f.cleanup(); // once done
    await both;
    await closeServer(server);
  });

  // node:http: socketPath takes the spelling.
  test("connect with node:http", async () => {
    const { resolveForConnect } = sockat;
    const path = longPath();
    const s = sockat.resolveForBind(path);
    const server = http.createServer((_, res) => res.end("hello\n")).listen(s.path);
    await once(server, "listening");
    const file = s.socketFile();
    const done = new Promise<number | undefined>((resolve) => {
      http.get({ socketPath: sockat.resolveForConnect(path).path, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
    });
    assert.equal(await done, 200);
    const f = resolveForConnect(path);
    http.get({ socketPath: f.path, path: "/" }, (res) => {
      res.resume();
      res.on("end", () => f.cleanup());
    });
    await once(server, "request");
    file.remove();
    server.closeAllConnections();
    server.close();
  });

  // fetch (Bun): the unix option takes the spelling.
  test("connect with fetch (Bun)", bunOnly, async () => {
    const { resolveForConnect } = sockat;
    const path = longPath();
    const s = sockat.resolveForBind(path);
    const server = Bun.serve({ unix: s.path, fetch: () => new Response("hello\n") });
    const file = s.socketFile();
    const f = resolveForConnect(path);
    const res = await fetch("http://localhost/", { unix: f.path });
    console.log(await res.text());
    f.cleanup();
    file.remove();
    await server.stop();
  });
});

describe("docs/REFERENCE recommended code", () => {
  // Keep the path given and remove before closing; ask for a spelling
  // another uid can follow (Linked and usableCrossUid for a long path).
  test("patterns not to use: what to write instead", async () => {
    const { bindEx, resolveForBind } = sockat;
    const path = longPath();
    // keep the path given, and remove before closing
    const b = await bindEx(path);
    try {
      // ...
    } finally {
      b.file.remove();
      b.socket.close();
    }
    // ENAMETOOLONG where no spelling another uid can follow can be had
    const f = resolveForBind(path, { usableCrossUid: true });
    assert.equal(fs.existsSync(path), false);
    assert.ok(f.spelling.kind === "Linked" && f.spelling.usableCrossUid);
    f.cleanup();
  });
});

describe("the pages' code is the code run here", () => {
  // Every TypeScript block of the manual's pages and of the reference (both
  // languages), without its import lines and blank lines, appears in this
  // file line by line (indentation aside): a page cannot show code these
  // tests do not run.
  test("every code block appears in this file", () => {
    const root = new URL("..", import.meta.url).pathname;
    const pages = [
      ...fs.readdirSync(`${root}docs/manual`).map((n) => `docs/manual/${n}`),
      "docs/REFERENCE-ja.md",
      "docs/REFERENCE.md",
    ];
    const here = fs
      .readFileSync(new URL(import.meta.url).pathname, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join("\n");
    let blocks = 0;
    for (const page of pages) {
      const text = fs.readFileSync(`${root}${page}`, "utf8");
      for (const m of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
        const code = (m[1] ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("import "))
          .join("\n");
        blocks++;
        assert.ok(here.includes(code), `${page}: a block not run here:\n${code}`);
      }
    }
    assert.ok(blocks > 0);
  });
});
