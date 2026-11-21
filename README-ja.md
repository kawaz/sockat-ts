# sockat (TypeScript)

> [English](./README.md) | 日本語

`@kawaz/sockat` は、`sun_path` の上限 (macOS 104・Linux 108 バイト) を超えるパスでも Unix domain socket を bind / connect できるようにする TypeScript の package (Node.js 22 以上と Bun)。標準が受け付ける長さのパスは標準にそのまま渡し、長いパスだけを同じ所を指す短い綴りにして標準に渡す。native の部品は持たない。

- 振る舞いの正本 (言語によらない仕様): [kawaz/sockat の SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)
- 他の言語の実装: [kawaz/sockat](https://github.com/kawaz/sockat)

## 使い方

node:net (Node と Bun):

```ts
import { bind, bindEx, connect } from "@kawaz/sockat";

const server = await bind(path); // listening になってから返る net.Server
server.on("connection", (s) => s.end("hi"));
const socket = await connect(path); // connect が終わってから返る net.Socket
```

Bun の `Bun.listen` / `Bun.connect` (Bun 以外で呼ぶとすぐエラー):

```ts
import { connect, listen } from "@kawaz/sockat/bun";

const listener = listen({ unix: path, socket: { data(s, d) { s.write(d); } } });
const socket = await connect({ unix: path, socket: { data() {} } });
```

| 関数 | 返す物 |
|---|---|
| `bind(path)` / `connect(path)` | `net.Server` / `net.Socket` (Promise) |
| `bindEx(path, options?)` / `connectEx(path, options?)` | `Bound<net.Server>` / `Connected<net.Socket>` |
| `listen(options)` / `connect(options)` (`/bun`) | `Bun.UnixSocketListener` (同期) / `Bun.Socket` (Promise) |
| `listenEx(options, sockatOptions?)` / `connectEx(options, sockatOptions?)` (`/bun`) | `Bound<…>` / `Connected<…>` |
| `resolveForBind(path, options?)` / `resolveForConnect(path, options?)` | `ForBind` / `ForConnect` (同期) |
| `sweep()` / `sweepBase(path)` | 無し |

- 空のパスと、先頭以外に NUL を含むパスは `TypeError` (`code` は `ERR_INVALID_ARG_VALUE`)。Linux では先頭が NUL のパス (abstract) を標準にそのまま渡す
- node:net は数値に読める文字列 (`"0"`・`"8080"`・`"1e3"`・空白だけ 等) を TCP のポートとみなす。sockat は、スラッシュを含まずそう読める綴りに `./` を付けて渡す (同じファイル。`Spelling` は `CwdRelative` のまま、`address()` は渡したパス)。`./` を付けて標準に渡す長さを超える時は長いパスとして扱う
- OS のエラーは Node の形 (`code`・`errno`・`syscall`・`path`。`path` は渡したパス)。`*Ex` と resolve のエラーには `route` (実際に bind / connect して失敗した経路、無ければ `null`) と `skipped` が付く

### ソケットのファイルを消す (`bindEx` と `file`)

```ts
const b = await bindEx(path); // b.socket, b.file, b.spelling, b.route, b.base, b.skipped
// …
b.file.remove(); // ソケットのファイルを消す (listener は閉じない)。閉じる前に呼ぶ
b.socket.close();
```

- `b.file` は bind した直後にソケットのファイルの realpath と `(st_dev, st_ino)` を覚え、`remove()` はそのパスが今も同じファイルの時だけ消す。覚えられなければ `bindEx` はエラーにする (綴りの symlink を先に消してから listener を閉じるので、置き換わった物は消さない。短いパスは閉じると標準がパスを unlink する)
- 最後の要素が symlink の時 (macOS・NetBSD の bind はそれを辿る) は、辿った先のソケットを覚えて消し、symlink は消さない
- `remove()` は `cleanup()` もする。`cleanup()` は綴りが通る symlink (E) だけを消す。成功した後の呼び出しは何もせず、失敗した後の呼び出しはやり直す
- 開いている間だけ置き換えを見分けられる。閉じた後に作り直された物は `(st_dev, st_ino)` を使い回すファイルシステムで見分けられない

### 綴りの性質 (`Spelling`)

長いパスでは、カーネルが覚えるアドレス (他の言語の相手の `getpeername`、`ss -x`・`lsof` 等) は渡したパスでなく bind の綴りになる。`spelling` はその綴りを後で使えるかを返す。分岐はこれで書く。

| `kind` | 綴り |
|---|---|
| `Original` | 元の絶対パス (abstract の名前も) |
| `CwdRelative` | 元の相対パス (`./` を付けた物も)。cwd を変えると別の所を指す |
| `Linked` | 置き場の B・D・E を通り、元のパスと同じ所を指す |
| `Dangling` | どこにも届かない (sockat-ts では生まれない) |

`Linked` の属性:

| 属性 | 意味 |
|---|---|
| `removable` | 綴りで unlink すると実体が消えるか。link-dir は true、link-file は false (symlink だけが消える) |
| `until` | `Process` (`/proc/<pid>/fd/…` を通る綴り: プロセスが終われば辿れない)、`Cleanup` (B の実パスの綴り: `cleanup()` まで) |
| `usableCrossUid` | 別の uid の相手が辿れるか |
| `usableWithPrivateTmp` | 自分か相手が `/tmp` を隔離していても (systemd の `PrivateTmp` 等) 辿れるか。`/proc` を通る綴りは true、`/tmp`・`/var/tmp` を通る綴りは false |

listener の `address()` (node:net) と `unix` (`Bun.listen`) は綴りでなく渡したパスを返す。

### `Options`

| 項目 | 意味 |
|---|---|
| `usableCrossUid` | 別の uid の相手も辿れる綴りを求める (bind 系だけが見る)。満たせなければ満たさない綴りに落とさず、他の経路へ進む (sockat-ts では `ENAMETOOLONG` になりうる) |
| `base` | B そのもののパス (アプリが管理する場所。例 `/tmp/app-1000/sockat`)。確かめに外れたらエラーで、自動の置き場に落とさない。B は sockat 専用で、中に他の物を置かない |

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

### 置き場に残る物と `sweep`

長いパスの綴りは、利用者ごとの置き場 B の中の、プロセスごとのディレクトリ D と symlink E を通る。**B・D・E はアプリの置き場の外に増える。**

| | B | D | E |
|---|---|---|---|
| 場所 | `/tmp/sockat-<uid>` → `$XDG_RUNTIME_DIR/sockat` → `$TMPDIR/sockat-<uid>` → ソケットのディレクトリの `.sockat.<乱数>` の順で最初に作れた所。`options.base` を渡せばそこ | B の中の乱数 10 文字 | resolve と bind の E は D の中。既定の connect の E は B の直下で、connect の後すぐ消す |
| 生きている間 | 消さない | プロセスが共有ロックを掛けて持ち続ける | `cleanup()` まで残る |
| 片付け | sockat はしない | 死んだプロセスの D は OS の一時ディレクトリの掃除で消える。`sweep()` を呼んだ時だけ、ロックの外れた D を消す | `cleanup()` / `remove()` |

- `/tmp/sockat-<uid>` 等の中は、プロセスごとの D (乱数 10 文字) と、その中の綴り用の symlink だけ。生きている D を消しても、綴りが辿れなくなるだけで無関係なファイルには当たらない
- 既定の `bind` / `listen` は `file` を返さないので、E はプロセスが終わるまで残る。**長いパスに何度も bind する長命のプロセス (セッションごとにソケットを作る daemon 等) は `bindEx` を使い、要らなくなったら `remove()` か `cleanup()` で片付ける**
- **試験を繰り返す環境 (CI 等) では `sweep()` を呼ぶ**と死んだ D が溜まらない。`sweepBase(base)` は `options.base` の B の分。どちらも自動では呼ばれない
- **ソケットのディレクトリの B (`.sockat.<乱数>`) と、確かめに外れて落とした B (`sockat-<uid>.<乱数>`) は、`sweep` でも OS の掃除でも消えずに残りうる**
- **生きている D が消されうる環境**: systemd v242 より古い Linux (RHEL 8 等。`/tmp` の D を 10 日で消す) と、B が macOS の `$TMPDIR` にある時 (dirhelper が 3 日で消しうる)。綴りが辿れなくなるだけ
- **`PrivateTmp` の相手**: 相手の `/tmp` が隔離されていると、`/tmp` を通る綴りを相手は辿れない。辿れるかは `usableWithPrivateTmp` で分かる
- **片付けた後の綴りは使わない**。`/tmp` の B は消えた後に他人が同じ名前で作り直しうる

## 使ってはいけない書き方

無関係なファイルを消したり、消し損ねたりする書き方 ([SPEC の「使ってはいけない書き方」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#使ってはいけない書き方))。避け方のコードは [test/readme.test.ts](./test/readme.test.ts) で動かしている。

| 書き方 | なぜいけないか | 代わりに |
|---|---|---|
| `spelling` を見ずに、カーネルが返す綴りでソケットのファイルを `fs.unlinkSync` / `fs.statSync` する (他の言語の相手の `getpeername`、`lsof` の出力等) | link-file の綴りでは symlink が消えるだけでファイルは残る | 渡したパスを持っておいて使う。`b.file.remove()` |
| `cleanup()` の後やプロセスが終わった後に、古い綴り (`f.path`) を使う | 片付けた後の `/tmp` の B は他人が作り直しうる。`until: "Process"` の綴りはプロセスが終われば辿れない | 綴りは `until` の間だけ使う |
| 相対パスで bind し、`process.chdir` の後にその相対パスで `fs.unlinkSync` する | 別の場所のファイルに当たる (`CwdRelative`) | bind の前に `path.resolve` で絶対パスにする。`b.file.remove()` |
| `server.close()` / `listener.stop()` だけでソケットのファイルが消えると当てにする | 閉じると綴りを unlink するので、link-file の綴りでは symlink だけが消えてファイルは残る | `b.file.remove()` か、渡したパスで消す |
| `b.file.remove()` で listener も閉じると当てにする | `remove()` はファイルを消すだけ | listener は自分で閉じる |
| `server.close()` の後に `b.file.remove()` を呼ぶ | 閉じた後に作り直された別のファイルを見分けられないことがある | 閉じる前に呼ぶ |
| `/proc` を通る綴りや `usableCrossUid` が false の綴りを、別の uid の相手に辿らせる | 辿れない | `{ usableCrossUid: true }` を渡し、結果の `spelling` を確かめる |
| `route`・`base`・`skipped` の文字列で分岐する | 診断用で中身を約束しない | `spelling` で分岐する |

```ts
// 絶対パスで bind し、閉じる前に remove する
const b = await bindEx(nodePath.resolve(relative));
try {
  // …
} finally {
  b.file.remove();
  b.socket.close();
}

// 別の uid の相手に辿らせる綴りは、満たせたかを確かめる
const f = resolveForBind(path, { usableCrossUid: true });
if (f.spelling.kind === "Linked" && !f.spelling.usableCrossUid) {
  throw new Error("no spelling another uid can follow");
}
```

## 長いパスへの届き方

標準にそのまま渡す長さは、Linux は Node 108・Bun 107 バイト、他は 103 (illumos は 107) バイトまで。それを超えるパスは、まずソケットのディレクトリを引き (無ければ `ENOENT`、ディレクトリでなければ `ENOTDIR`。`..` や `.` は文字列で畳まず OS に引かせる)、次の経路を左から試す。経路が実際に bind / connect して失敗したら、そのエラーを返して次を試さない。

native の部品が要る経路は作らず、使えない経路として `skipped` に入れて次へ進む (理由は `no native code in sockat-ts`)。

| OS | bind | connect |
|---|---|---|
| Linux / Android | link-dir (`/proc` を通す綴り → B の実パス) → thread-cwd (作らない) | proc-direct (`/proc` が無ければ relative) → thread-cwd-direct (作らない) → link-file |
| macOS | link-dir → link-file → thread-cwd (作らない) | relative → widened (作らない) → thread-cwd-direct (作らない) → link-file |
| FreeBSD | link-dir → at (作らない) | at-direct (作らない) → link-file |
| NetBSD | link-dir → link-file | relative → link-file |
| OpenBSD・illumos | link-dir | relative → link-file |

- **link-dir**: D の中にソケットのディレクトリを指す E を作り、`B/D/E/<ファイル名>` で bind する。`removable`
- **link-file**: D の中にソケットのファイルを指す E を作り、`B/D/E` で bind する (bind が symlink を辿る OS だけ)。既定の connect は B の直下の E を通し、connect の後すぐ消す。ファイル名の長さによらず届く
- **proc-direct**: `/proc/self/fd/<ディレクトリの fd>/<ファイル名>` で connect する
- **relative**: cwd からの相対パスで connect する (cwd は変えない)
- D のロック: macOS と BSD は `O_SHLOCK` で開く、Linux は `flock(1)` (util-linux / busybox) に fd を継がせる。**Linux で `flock(1)` が無いと、長いパスの bind と resolve は `ENAMETOOLONG`** (既定の connect は届く)。illumos はロックの手段が無く同じ

### どこから届かなくなるか

ディレクトリが標準に渡す長さを超えるほど深い時に、届くファイル名の長さ (バイト。置き場は OS の既定):

| OS | bind (`bind`・`bindEx`・`listen`・`resolveForBind`) | connect (`connect`・`resolveForConnect`) |
|---|---|---|
| Linux / Android | およそ 76 (`/proc` を通す綴りはおよそ 70) | 255 まで |
| macOS | 255 まで (link-file) | 255 まで |
| FreeBSD・OpenBSD | およそ 72 | 255 まで |
| NetBSD | 255 まで (link-file) | 255 まで |
| illumos | 届かない (D をロックできない) | 255 まで |

B を作れない環境 (置き場が全部書けない等) では、B を通る経路が使えず、connect は proc-direct・relative の分だけ届く。

Linux で `/proc` が見えない環境 (空の tmpfs を被せた等) では、Bun 自体が起動時に `abort()` で落ちる (Bun 1.4.4・1.4.5 で確認。sockat を使わない `bun -e 'console.log(1)'` も同じ)。Node はそのまま動き、connect は relative を使う。

## SPEC から外れる点

- 作らない経路 (上の表) でしか届かない所に届かない
- **`bindEx` / `listenEx` の listener も、閉じると綴りを unlink する** (SPEC は「`_ex` の listener は閉じても消さない」。runtime に止める口が無い)。`file.remove()` は閉じる前に呼ぶ
- `bindEx` / `listenEx` がファイルを覚えられなかった時、短いパスは listener を閉じる時に標準がパスを unlink するので、その間に置き換わった物も消える
- DGRAM と SEQPACKET は無い (Node と Bun の標準に無い)
- 短いパスのエラーは標準のまま (Node の listen は無いディレクトリに `EACCES` を返す)。長いパスは SPEC の errno (`ENOENT`)

## ライセンス

MIT
