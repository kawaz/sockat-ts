# パスだけを解決する (resolve)

> [English](./resolve.md) | 日本語

[利用マニュアル](../MANUAL-ja.md) の一部。コードは [test/manual.test.ts](../../test/manual.test.ts) で動かしている (`path` はソケットのパスで、長さは問わない)。

パスを受け取るライブラリに長いパスを渡す時に、同じ所を指す短いパス (綴り) を作って、それを渡す。

## node:net の listen に渡す

`resolveForBind` の `f.path` で listen させ、listen の後・閉じる前に `f.socketFile()` を受け取っておく。消すのはその `remove`。

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

## Bun.serve に渡す

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

## 何度も connect する

`resolveForConnect` の `f.path` は、`cleanup()` するまで何度でも使える。

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

## node:http でつなぐ

```ts
import http from "node:http";
import { resolveForConnect } from "@kawaz/sockat";

const f = resolveForConnect(path);
http.get({ socketPath: f.path, path: "/" }, (res) => {
  res.resume();
  res.on("end", () => f.cleanup());
});
```

## fetch でつなぐ (Bun)

```ts
import { resolveForConnect } from "@kawaz/sockat";

const f = resolveForConnect(path);
const res = await fetch("http://localhost/", { unix: f.path });
console.log(await res.text());
f.cleanup();
```
