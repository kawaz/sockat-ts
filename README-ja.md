# sockat (TypeScript)

> [English](./README.md) | 日本語

作成中。`@kawaz/sockat` は TypeScript (Node.js 22 以上と Bun) から、`sun_path` の上限を超えるパスで Unix domain socket を bind / connect できるようにする package。標準が受け付ける長さのパスは標準にそのまま渡し、長いパスだけを短い綴りにして標準に渡す。native の部品は持たない。

- 振る舞いの正本 (言語によらない仕様): [kawaz/sockat の SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)
- 他の言語の実装: [kawaz/sockat](https://github.com/kawaz/sockat)

## 使い方

node:net (Node と Bun):

```ts
import { bind, connect, bindEx } from "@kawaz/sockat";

const server = await bind(longPath); // listening になってから返る net.Server
server.on("connection", (s) => s.end("hi"));
const socket = await connect(longPath); // connect が終わってから返る net.Socket

const b = await bindEx(longPath); // b.socket, b.file, b.spelling, b.route, b.base, b.skipped
b.file.remove(); // listener を閉じる前に呼ぶ
b.socket.close();
```

Bun の `Bun.listen` / `Bun.connect`:

```ts
import { listen, connect } from "@kawaz/sockat/bun";

const listener = listen({ unix: longPath, socket: { data(s, d) { s.write(d); } } });
const socket = await connect({ unix: longPath, socket: { data() {} } });
```

他に `connectEx`・`listenEx`・`resolveForBind`・`resolveForConnect`・`sweep`・`sweepBase` がある (SPEC の「公開する操作」)。

## 作る経路 (OS × 経路)

native の部品が要る経路は作らず、使えない経路として `skipped` に入れて次へ進む (理由は `no native code in sockat-ts`)。

| OS | bind | connect |
|---|---|---|
| Linux / Android | link-dir (procB → 実パス)。thread-cwd は作らない | proc-direct (`/proc` が無ければ relative) → link-file。thread-cwd-direct は作らない |
| macOS | link-dir → link-file。thread-cwd は作らない | relative → link-file。widened・thread-cwd-direct は作らない |
| FreeBSD | link-dir。at は作らない | link-file。at-direct は作らない |
| NetBSD | link-dir → link-file | relative → link-file |
| OpenBSD・illumos | link-dir | relative → link-file |

## 未実装と SPEC から外れる点

- 作らない経路 (上の表) で届く場面に届かない。Linux はファイル名がおよそ 70 バイトを超える長いパスの bind が `ENAMETOOLONG` になる (macOS は link-file で届く)
- `bindEx` / `listenEx` の listener も、閉じると (`close()` / `stop()`) 綴りで unlink する (SPEC は「`_ex` の listener は閉じても消さない」。runtime に止める口が無い)。`file.remove()` は閉じる前に呼ぶ
- 既定の `bind` / `listen` の listener を閉じると綴りで unlink する。link-file の綴りでは symlink だけが消え、ソケットのファイルが残る
- D のロックは macOS と BSD は `O_SHLOCK`、Linux は `flock(1)` (util-linux / busybox)。Linux で `flock(1)` が無いと、長いパスの bind と `resolveForBind` / `resolveForConnect` が `ENAMETOOLONG` になる (既定の connect は届く)。illumos 等はロックの手段が無く同じ
- DGRAM と SEQPACKET は無い (Node と Bun の標準に無い)
- Linux で `/proc` が見えない環境 (空の tmpfs を被せた等) では、Bun 自体が起動時に `abort()` で落ちる (Bun 1.4.4・1.4.5 で確認。sockat を使わない `bun -e 'console.log(1)'` も同じ)。Node はそのまま動き、connect は relative を使う
- 長いパスの listener の `address()` (node:net) と `unix` (`Bun.listen`) は元のパスを返す。他の言語の相手と運用の道具には綴りが見える
- 短いパスのエラーは標準のまま (Node の listen は無いディレクトリに `EACCES` を返す)。長いパスは SPEC の errno (`ENOENT`)

## ライセンス

MIT
