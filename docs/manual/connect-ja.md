# connect する

> [English](./connect.md) | 日本語

[利用マニュアル](../MANUAL-ja.md) の一部。コードは [test/manual.test.ts](../../test/manual.test.ts) で動かしている (`path` はソケットのパスで、長さは問わない)。

## node:net でつなぐ

`net.connect(path)` の代わりに `await connect(path)` と書く。connect が終わってから、標準の `net.Socket` が返る。

```ts
import { connect } from "@kawaz/sockat";

const socket = await connect(path); // net.Socket, connected
socket.end("hello\n");
```

## Bun.connect でつなぐ

`Bun.connect` の代わりに `@kawaz/sockat/bun` の `connect` を同じ引数で呼ぶ。

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

## HTTP でつなぐ

HTTP のクライアント (node:http、Bun の fetch) には、同じ所を指す短いパスを作って渡す。[resolve](resolve-ja.md#nodehttp-でつなぐ) を使う。

## 同じパスに何度もつなぐ

短いパスを 1 度だけ作って使い回す。[resolve](resolve-ja.md#何度も-connect-する) を使う。
