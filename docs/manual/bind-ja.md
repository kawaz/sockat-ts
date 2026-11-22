# bind する

> [English](./bind.md) | 日本語

[利用マニュアル](../MANUAL-ja.md) の一部。コードは [test/manual.test.ts](../../test/manual.test.ts) で動かしている (`path` はソケットのパスで、長さは問わない)。

## node:net で待ち受ける

`net.createServer().listen(path)` の代わりに `await bind(path)` と書く。listen が終わってから、標準の `net.Server` が返る。

```ts
import { bind } from "@kawaz/sockat";

const server = await bind(path); // net.Server, listening
server.on("connection", (socket) => socket.end("hello\n"));
```

## Bun.listen で待ち受ける

`Bun.listen` の代わりに `@kawaz/sockat/bun` の `listen` を同じ引数で呼ぶ。

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

## 終わる時にソケットのファイルを消す

`bindEx` で bind し、listener を閉じる前に `b.file.remove()` を呼ぶ。

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

Bun は `listenEx` で同じに書く。

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

## 置き場を自分で決める

長いパスのために sockat が作る短い道の置き場を、アプリが管理するディレクトリにする (`base`)。前のプロセスが残した物は `sweepBase` で片付ける。

```ts
import { bindEx, sweepBase } from "@kawaz/sockat";

// base: a directory the application manages, such as "/run/myapp/sockat"
sweepBase(base);
const b = await bindEx(path, { base });
```

## 別のユーザーのプロセスにつながせる

`usableCrossUid` を渡す。別の uid の相手が辿れる綴りを作れない時は `ENAMETOOLONG`。

```ts
import { bindEx } from "@kawaz/sockat";

const b = await bindEx(path, { usableCrossUid: true });
```

## 前のプロセスが残した物を片付ける

同じプログラムを何度も起こす所 (試験等) では、`sweep` を 1 回呼ぶ。生きているプロセスの物は消さない。

```ts
import { sweep } from "@kawaz/sockat";

sweep();
```
