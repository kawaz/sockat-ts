# Resolve a path only (resolve)

> English | [日本語](./resolve-ja.md)

Part of the [user manual](../MANUAL.md). The code runs in [test/manual.test.ts](../../test/manual.test.ts) (`path` is the socket's path, of any length).

To hand a long path to a library that takes a path, make a short path (a spelling) naming the same place and hand it that.

## Hand it to node:net's listen

Listen on `f.path` of `resolveForBind`, and take `f.socketFile()` after it listens and before it is closed. Its `remove` removes the file.

```ts
import { once } from "node:events";
import net from "node:net";
import { resolveForBind } from "@kawaz/sockat";

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
```

## Hand it to Bun.serve

```ts
import { resolveForBind } from "@kawaz/sockat";

const f = resolveForBind(path);
const server = Bun.serve({ unix: f.path, fetch: () => new Response("hello\n") });
const file = f.socketFile();
try {
  // serve
} finally {
  file.remove();
  await server.stop();
}
```

## Connect many times

`f.path` of `resolveForConnect` can be used as many times as you like until `cleanup()`.

```ts
import { once } from "node:events";
import net from "node:net";
import { resolveForConnect } from "@kawaz/sockat";

const f = resolveForConnect(path);
for (let i = 0; i < 2; i++) {
  const socket = net.connect(f.path);
  await once(socket, "connect");
  socket.end("hello\n");
}
f.cleanup(); // once done
```

## Connect with node:http

```ts
import http from "node:http";
import { resolveForConnect } from "@kawaz/sockat";

const f = resolveForConnect(path);
http.get({ socketPath: f.path, path: "/" }, (res) => {
  res.resume();
  res.on("end", () => f.cleanup());
});
```

## Connect with fetch (Bun)

```ts
import { resolveForConnect } from "@kawaz/sockat";

const f = resolveForConnect(path);
const res = await fetch("http://localhost/", { unix: f.path });
console.log(await res.text());
f.cleanup();
```
