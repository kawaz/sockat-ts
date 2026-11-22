# sockat (TypeScript)

> [English](./README.md) | 日本語

Unix domain socket のパスが長すぎて bind / connect できない。`@kawaz/sockat` は、それを無くす JavaScript / TypeScript のライブラリです。Node.js でも Bun でも、どの版でも同じに動きます。

長いパスを標準の `node:net` に渡すと、bind はこのエラーで断られます (Node.js でも Bun でも同じ文言です)。

```text
Error: listen EINVAL: invalid argument /…/app.sock
```

どこから断られるかは、ランタイムと版で違います。Node.js の版や Bun ではある長さまで通ってしまうことも、黙ってパスを切り詰められることもあり、同じコードが環境によって動いたり動かなかったりします。

標準の書き方を sockat に置き換えるだけで、長いパスでもそのまま動きます。Node.js でも Bun でも同じコードです。

```ts
import { bind, connect } from "@kawaz/sockat";

// const server = net.createServer().listen(path);
const server = await bind(path); // listen が終わってから返る

// const socket = net.connect(path);
const socket = await connect(path); // connect が終わってから返る
```

返ってくるのは標準と同じ `net.Server` / `net.Socket` で、短いパスは今までどおり標準にそのまま渡します。長いパスの時だけ、sockat が同じ場所を指す短い道を裏で用意してつなぎます。パスを短くする工夫も、ランタイムや OS ごとの上限も、気にしなくて構いません。

## 入れ方

```sh
npm install @kawaz/sockat
# または
bun add @kawaz/sockat
```

Node.js 22 以上と Bun で動き、他のパッケージにも native の部品にも依存しません。

## もっと詳しく

- [利用マニュアル](./docs/MANUAL-ja.md)
- [リファレンス](./docs/MANUAL-ja.md#関数の一覧)
- [技術説明](https://github.com/kawaz/sockat/blob/main/pages/technical-ja.md)

## ライセンス

MIT
