# Bind

> English | [日本語](./bind-ja.md)

Part of the [user manual](../MANUAL.md). The code runs in [test/manual.test.ts](../../test/manual.test.ts) (`path` is the socket's path, of any length).

## Listen with node:net

Write `await bind(path)` instead of `net.createServer().listen(path)`. It returns the standard `net.Server` once it is listening.

```ts
import { bind } from "@kawaz/sockat";

const server = await bind(path); // net.Server, listening
server.on("connection", (socket) => socket.end("hello\n"));
```

## Listen with Bun.listen

Call `listen` of `@kawaz/sockat/bun` with what you would give `Bun.listen`.

```ts
import { listen } from "@kawaz/sockat/bun";

const listener = listen({
  unix: path,
  socket: {
    data(socket, data) {
      socket.write(data);
    },
  },
});
```

## Remove the socket file when done

Bind with `bindEx`, and call `b.file.remove()` before closing the listener.

```ts
import { bindEx } from "@kawaz/sockat";

const b = await bindEx(path);
try {
  // serve on b.socket
} finally {
  b.file.remove(); // before closing
  b.socket.close();
}
```

On Bun, write the same with `listenEx`.

```ts
import { listenEx } from "@kawaz/sockat/bun";

const b = listenEx({ unix: path, socket: { data() {} } });
try {
  // serve on b.socket
} finally {
  b.file.remove(); // before stopping
  b.socket.stop(true);
}
```

## Choose the place yourself

Put what sockat makes for the short way to a long path in a directory the application manages (`base`). Clean up what earlier processes left there with `sweepBase`.

```ts
import { bindEx, sweepBase } from "@kawaz/sockat";

// base: a directory the application manages, such as "/run/myapp/sockat"
sweepBase(base);
const b = await bindEx(path, { base });
```

## Let a process of another user connect

Pass `usableCrossUid`. Where no spelling another uid can follow can be made, it is `ENAMETOOLONG`.

```ts
import { bindEx } from "@kawaz/sockat";

const b = await bindEx(path, { usableCrossUid: true });
```

## Clean up what earlier processes left

Where the same program starts again and again (tests and the like), call `sweep` once. It leaves what live processes use.

```ts
import { sweep } from "@kawaz/sockat";

sweep();
```
