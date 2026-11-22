# Connect

> English | [日本語](./connect-ja.md)

Part of the [user manual](../MANUAL.md). The code runs in [test/manual.test.ts](../../test/manual.test.ts) (`path` is the socket's path, of any length).

## Connect with node:net

Write `await connect(path)` instead of `net.connect(path)`. It returns the standard `net.Socket` once it is connected.

```ts
import { connect } from "@kawaz/sockat";

const socket = await connect(path); // net.Socket, connected
socket.end("hello\n");
```

## Connect with Bun.connect

Call `connect` of `@kawaz/sockat/bun` with what you would give `Bun.connect`.

```ts
import { connect } from "@kawaz/sockat/bun";

const socket = await connect({
  unix: path,
  socket: {
    data(_socket, data) {
      console.log(data.toString());
    },
  },
});
socket.write("hello\n");
```

## Connect over HTTP

Hand an HTTP client (node:http, Bun's fetch) a short path naming the same place. Use [resolve](resolve.md#connect-with-nodehttp).

## Connect to the same path many times

Make the short path once and use it again. Use [resolve](resolve.md#connect-many-times).
