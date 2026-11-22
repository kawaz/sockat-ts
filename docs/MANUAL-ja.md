# sockat (TypeScript) マニュアル

> [English](./MANUAL.md) | 日本語

`@kawaz/sockat` の TypeScript での名前と形、sockat-ts に固有の点。`@kawaz/sockat` は、`sun_path` の上限 (macOS 104・Linux 108 バイト) を超えるパスでも Unix domain socket を bind / connect できるようにする TypeScript の package (Node.js 22 以上と Bun)。標準が受け付ける長さのパスは標準にそのまま渡し、長いパスだけを同じ所を指す短い綴りにして標準に渡す。native の部品は持たない。

- 振る舞いの正本 (言語によらない仕様): [kawaz/sockat の SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)
- 他の言語の実装: [kawaz/sockat](https://github.com/kawaz/sockat)

言語によらない説明はハブにある。このマニュアルは TypeScript での名前と形、sockat-ts に固有の点だけを書く。

- [長いパスで標準と違う点](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#長いパスで標準と違う点) (カーネルが返すアドレス、listener を閉じた時、`PrivateTmp` の相手 等)
- [使ってはいけない書き方](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#使ってはいけない書き方)
- [置き場に残る物](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#置き場に残る物) と [`sweep`](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#sweep)
- [Q&A](https://github.com/kawaz/sockat/blob/main/pages/faq-ja.md) (長命の daemon、試験を繰り返す環境、`PrivateTmp` 等)

## 使い方

```sh
npm install @kawaz/sockat
bun add @kawaz/sockat
```

node:net (Node と Bun):

```ts
import { bind, bindEx, connect } from "@kawaz/sockat";

const server = await bind(path); // listening になってから返る net.Server
server.on("connection", (s) => s.end("hi"));
const socket = await connect(path); // connect が終わってから返る net.Socket
```

- 空のパスと、先頭以外に NUL を含むパスは `TypeError` (`code` は `ERR_INVALID_ARG_VALUE`)。Linux では先頭が NUL のパス (abstract) を標準にそのまま渡す
- node:net は数値に読める文字列 (`"0"`・`"8080"`・`"1e3"`・空白だけ 等) を TCP のポートとみなす。sockat は、スラッシュを含まずそう読める綴りに `./` を付けて渡す (同じファイル。`Spelling` は `CwdRelative` のまま、`address()` は渡したパス)。`./` を付けて標準に渡す長さを超える時は長いパスとして扱う
- OS のエラーは Node の形 (`code`・`errno`・`syscall`・`path`。`path` は渡したパス)。`*Ex` と resolve のエラーには `route` (実際に bind / connect して失敗した経路、無ければ `null`) と `skipped` が付く

### Bun の入口 (`@kawaz/sockat/bun`)

Bun の `Bun.listen` / `Bun.connect` (Bun 以外で呼ぶとすぐエラー):

```ts
import { connect, listen } from "@kawaz/sockat/bun";

const listener = listen({ unix: path, socket: { data(s, d) { s.write(d); } } });
const socket = await connect({ unix: path, socket: { data() {} } });
```

## 関数の一覧

| 関数 | 返す物 |
|---|---|
| `bind(path)` / `connect(path)` | `net.Server` / `net.Socket` (Promise) |
| `bindEx(path, options?)` / `connectEx(path, options?)` | `Bound<net.Server>` / `Connected<net.Socket>` |
| `listen(options)` / `connect(options)` (`/bun`) | `Bun.UnixSocketListener` (同期) / `Bun.Socket` (Promise) |
| `listenEx(options, sockatOptions?)` / `connectEx(options, sockatOptions?)` (`/bun`) | `Bound<…>` / `Connected<…>` |
| `resolveForBind(path, options?)` / `resolveForConnect(path, options?)` | `ForBind` / `ForConnect` (同期) |
| `sweep()` / `sweepBase(path)` | 無し |

### ソケットのファイルを消す (`bindEx` と `file`)

```ts
const b = await bindEx(path); // b.socket, b.file, b.spelling, b.route, b.base, b.skipped
// …
b.file.remove(); // ソケットのファイルを消す (listener は閉じない)。閉じる前に呼ぶ
b.socket.close();
```

`file.remove()` と `file.cleanup()` の約束は [SPEC の「片付け」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#片付け)。sockat-ts に固有の点:

- ファイルを覚えられない時、`bindEx` はエラーにする。長いパスは綴りの symlink を先に消してから listener を閉じる (置き換わった物は消さない)。短いパスは、閉じると bind したソケットだけが消えると確かめられる時だけ閉じ、それ以外は閉じずに `unref()` して手放す ([SPEC から外れる点](#spec-から外れる点))
- `bindEx` / `listenEx` の listener も、閉じると綴りを unlink する ([SPEC から外れる点](#spec-から外れる点))。`remove()` は閉じる前に呼ぶ

### 綴りの性質 (`Spelling`)

意味は [SPEC の「綴りの性質」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#綴りの性質-spelling)。TypeScript では `kind` で分ける判別共用体。

| `kind` | 綴り |
|---|---|
| `"Original"` | 元の絶対パス (abstract の名前も) |
| `"CwdRelative"` | 元の相対パス (`./` を付けた物も) |
| `"Linked"` | 置き場の B・D・E を通り、元のパスと同じ所を指す |
| `"Dangling"` | どこにも届かない (sockat-ts では生まれない) |

`"Linked"` の属性は `removable`・`until` (`"Process"` / `"Cleanup"`)・`usableCrossUid`・`usableWithPrivateTmp`。

listener の `address()` (node:net) と `unix` (`Bun.listen`) は綴りでなく渡したパスを返す。

### `Options`

| 項目 | 意味 |
|---|---|
| `usableCrossUid` | 別の uid の相手も辿れる綴りを求める (bind 系だけが見る)。sockat-ts は thread-cwd を作らないので、満たせなければ `ENAMETOOLONG` |
| `base` | B そのもののパス (アプリが管理する場所。例 `/tmp/app-1000/sockat`)。`sweepBase(base)` で死んだ D を片付ける |

意味は [SPEC の「`Options`」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#options)。

### resolve

綴りを自分で標準 (`net.Server.listen`、`Bun.serve({ unix })`、`fetch(url, { unix })` 等) に渡したい時に使う。

```ts
const f = resolveForBind(path); // 長いパスは Linked の綴り。届かない長さは ENAMETOOLONG
const server = net.createServer().listen(f.path);
// listening の後・閉じる前に
const file = f.socketFile();
// …
file.remove();
```

```ts
const f = resolveForConnect(path);
const socket = net.connect({ path: f.path }); // 何度でも
f.cleanup(); // 要らなくなったら
```

### 置き場の片付け

何が残り、いつ消えるかは [SPEC の「置き場に残る物」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#置き場に残る物)。TypeScript での形:

- 既定の `bind` / `listen` は `file` を返さない。長いパスに何度も bind する長命のプロセスは `bindEx` / `listenEx` を使い、`file.remove()` か `file.cleanup()` で片付ける
- 試験を繰り返す環境では `sweep()` を、`options.base` の B は `sweepBase(base)` を呼ぶ ([SPEC の「`sweep`」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#sweep))

## 使ってはいけない書き方

一覧となぜいけないかは [SPEC の「使ってはいけない書き方」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#使ってはいけない書き方)。TypeScript での形と避け方 (下のコードは [test/readme.test.ts](../test/readme.test.ts) で動かしている):

| TypeScript での形 | 代わりに |
|---|---|
| `spelling` を見ずに、カーネルが返す綴り (他の言語の相手の `getpeername`、`lsof` の出力等) で `fs.unlinkSync` / `fs.statSync` する | 渡したパスを持っておいて使う。`b.file.remove()` |
| `cleanup()` の後やプロセスが終わった後に `f.path` を使う | 綴りは `until` の間だけ使う |
| 相対パスで bind し、`process.chdir` の後にその相対パスで `fs.unlinkSync` する (`bindEx` / `listenEx` の listener を `chdir` の後に閉じるのも同じ。標準が閉じた時点の cwd で相対パスを unlink する) | bind の前に cwd を前に付けて絶対パスにする (`path.resolve` は `..` を字句で畳むので使わない)。`b.file.remove()` |
| `server.close()` / `listener.stop()` でソケットのファイルが消えると当てにする (link-file の綴りでは symlink だけが消える) | `b.file.remove()` か、渡したパスで消す |
| `b.file.remove()` で listener も閉じると当てにする | listener は自分で閉じる |
| `server.close()` の後に `b.file.remove()` を呼ぶ | 閉じる前に呼ぶ |
| `/proc` を通る綴りや `usableCrossUid` が false の綴りを、別の uid の相手に辿らせる | `{ usableCrossUid: true }` を渡す (満たせなければ満たさない綴りに落とさず `ENAMETOOLONG`) |
| `route`・`base`・`skipped` の文字列で分岐する | `spelling` で分岐する |

```ts
// 絶対パスで bind し、閉じる前に remove する
// path.resolve は使わない (`a/sym/..` を symlink の先の親でなく `a` にしてしまう)
const b = await bindEx(relative.startsWith("/") ? relative : `${process.cwd()}/${relative}`);
try {
  // …
} finally {
  b.file.remove();
  b.socket.close();
}

// 別の uid の相手に辿らせる綴りを求める。満たせなければ ENAMETOOLONG で、
// 長いパスの f.spelling は usableCrossUid が true の Linked
const f = resolveForBind(path, { usableCrossUid: true });
```

## 長いパスへの届き方

標準にそのまま渡す長さは、Node も Bun も、Linux と illumos は 107 バイト、他は 103 バイトまで (`sun_path` − 1。Linux の Node は NUL の入らない 108 バイトも受け付けるが、渡さない)。それを超えるパスは SPEC の [経路と試す順番](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#長いパスの経路と試す順番) に従う。

native の部品が要る経路は作らず、使えない経路として `skipped` に入れて次へ進む (理由は `no native code in sockat-ts`)。

| OS | bind | connect |
|---|---|---|
| Linux / Android | link-dir (`/proc` を通す綴り → B の実パス) → thread-cwd (作らない) | proc-direct (`/proc` が無ければ relative) → thread-cwd-direct (作らない) → link-file |
| macOS | link-dir → link-file → thread-cwd (作らない) | relative → widened (作らない) → thread-cwd-direct (作らない) → link-file |
| FreeBSD | link-dir → at (作らない) | at-direct (作らない) → link-file |
| NetBSD | link-dir → link-file | relative → link-file |
| OpenBSD・illumos | link-dir | relative → link-file |

- 経路の中身は [SPEC の「経路の名前」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#経路の名前)
- D のロック: macOS と BSD は `O_SHLOCK` で開く、Linux は `flock(1)` (util-linux / busybox) に fd を継がせる。**Linux で `flock(1)` が無いと、長いパスの bind と resolve は `ENAMETOOLONG`** (既定の connect は届く)。illumos はロックの手段が無く同じ

### どこから届かなくなるか

ディレクトリが標準に渡す長さを超えるほど深い時に、sockat-ts で届くファイル名の長さ (バイト。置き場は OS の既定)。作らない経路の分、ハブの [届く範囲](https://github.com/kawaz/sockat/blob/main/pages/reach/README-ja.md) より短い所がある:

| OS | bind (`bind`・`bindEx`・`listen`・`resolveForBind`) | `connect`・`connectEx` | `resolveForConnect` |
|---|---|---|---|
| Linux / Android | およそ 76 (`/proc` を通す綴りはおよそ 70) | 255 まで | 255 まで |
| macOS | 255 まで (link-file) | 255 まで | 255 まで |
| FreeBSD・OpenBSD | およそ 72 | 255 まで | 255 まで |
| NetBSD | 255 まで (link-file) | 255 まで | 255 まで |
| illumos | 届かない (D をロックできない) | 255 まで (D を作らない) | 届かない (D をロックできない) |

B を作れない環境 (置き場が全部書けない等) では、B を通る経路が使えず、connect は proc-direct・relative の分だけ届く。

Linux で `/proc` が見えない環境 (空の tmpfs を被せた等) では、Bun 自体が起動時に `abort()` で落ちる (Bun 1.4.4・1.4.5 で確認。sockat を使わない `bun -e 'console.log(1)'` も同じ)。Node はそのまま動き、connect は relative を使う。

## SPEC から外れる点

- 作らない経路 ([長いパスへの届き方](#長いパスへの届き方) の表) でしか届かない所に届かない
- **`bindEx` / `listenEx` の listener も、閉じると綴りを unlink する** (SPEC は「`_ex` の listener は閉じても消さない」。runtime に止める口が無い)。`file.remove()` は閉じる前に呼ぶ
- `bindEx` / `listenEx` が短いパスのファイルを覚えられなかった時 (bind の直後にソケットが置き換えられた、相対パスで bind の間に cwd が変わった) は、閉じると bind したソケットだけが消えると確かめられる時にだけ閉じる。それ以外は listener を閉じずに `unref()` して手放す。置き換えた物と、bind したソケットのファイルは残る ([DR-0004](./decisions/DR-0004-close-relative-listener-only-when-ours.md))。標準は閉じる時にパスを unlink する (相対パスは閉じた時点の cwd で) ので、SPEC の「閉じる」をそのまま当てると、それらを消してしまうため
- 標準は閉じた時点の cwd で相対パスを unlink するので、cwd を変えるプロセスは bind の前に絶対パスにする
- DGRAM と SEQPACKET は無い (Node と Bun の標準に無い)
- 短いパスのエラーは標準のまま (Node の listen は無いディレクトリに `EACCES` を返す)。長いパスは SPEC の errno (`ENOENT`)
