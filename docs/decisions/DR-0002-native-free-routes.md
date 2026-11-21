# DR-0002: native の部品を持たず、JS だけで作れる経路だけを作る。D のロックは O_SHLOCK と flock(1)

- Status: Active
- Date: 2026-11-21

## Context

[ハブの research](https://github.com/kawaz/sockat/blob/main/docs/research/2026-11-21-typescript-port.md) で、SPEC の経路のうち、綴りを作って標準に渡すだけのもの (link-dir・link-file・proc-direct・relative、既定の connect の link-file) は Node と Bun の両方で JS だけで作れると分かった。スレッドの cwd を移す経路、`bindat` / `connectat`、広げた sockaddr、D を守る flock は FFI か N-API の addon が要る (どちらも experimental か、prebuilt の配布が重い)。kawaz は「ネイティブ要素抜きにできんの？」と問い、ハブの統括は「まず native 抜きで最低限を作り、足りない所が見えてから native の持ち方を決める」と読んだ (2026-11-21)。

## Decision

### 作る経路と作らない経路

| 操作 | 作る | 作らない (いつも使えない経路として `skipped` に入れて次へ) |
|---|---|---|
| bind | standard、link-dir (procB・実パス)、link-file (macOS・NetBSD と、表に無い OS は実行時の見分け) | thread-cwd (Linux・Apple の OS)、at (FreeBSD) |
| connect | standard、proc-direct、relative、link-file | widened (Apple の OS)、at-direct (FreeBSD)、thread-cwd-direct (Linux・Apple の OS) |

- `skipped` に入れるのは、その OS の列に並ぶ経路だけ (SPEC の「診断」)。理由は `no native code in sockat-ts`
- bind で `Dangling` の綴りは生まれない

### `*at` 系の代わり

node:fs に `mkdirat`・`fchmodat`・`symlinkat`・`openat` は無い。

- Linux / Android: 親の fd (`O_PATH | O_DIRECTORY`、`fs.constants` に無いので数値) を `/proc/self/fd/<fd>/<名前>` で綴って fs の操作に渡す (`/proc` を使える時)
- それ以外: SPEC-routes の手順で確かめた実パス (ルートから親まで、持ち主が root か自分で他人が書けないか sticky) に名前を足して操作し、作った後に `lstat` と開いた fd の `fstat` の `(st_dev, st_ino)` を比べる。途中を他人が付け替えられないことは確かめ済みなので、fd 基準と同じ守りになる

### D のロック

| OS | 共有ロック (D を持つ間) | 排他ロック (`sweep`) |
|---|---|---|
| Apple の OS・FreeBSD・NetBSD・OpenBSD | `fs.openSync(D, O_RDONLY \| O_DIRECTORY \| O_SHLOCK \| O_NONBLOCK)` の fd を持ち続ける | `O_EXLOCK \| O_NONBLOCK` で開く |
| Linux / Android | D の fd を子プロセスの fd 3 に継がせて `flock -s -n 3` (util-linux / busybox の flock(1)) を同期で走らせる。flock のロックは open file description に付くので、子が終わっても親の fd が開いている間は残る | 同じく `flock -x -n 3` |
| illumos・その他 | 無し | 無し |

- BSD 系の `O_SHLOCK` は flock と同じロックなので、他の言語の `sweep` やハブの適合試験の `flock(LOCK_EX | LOCK_NB)` の判定とそのまま噛み合う (macOS の Node 26.13.1 と Bun 1.4.4 で実測 2026-11-21)
- ロックを掛けられない時 (flock(1) が無い、illumos 等) は D を作れない扱いにして、D を使う経路を使えないとして飛ばす (SPEC の「B・D・E を作れない」)。`sweep` はロックを取れない D を消さない
- flock(1) を起こすのは (プロセス, B) ごとに D を作る 1 回だけ

### listener を閉じた時

標準の listener は閉じる時に、listen に渡した綴りの文字列で unlink する。止める口は Node にも Bun にも無い ([ハブの research](https://github.com/kawaz/sockat/blob/main/docs/research/2026-11-21-typescript-port.md) 1-3)。

- 既定の `bind` は SPEC どおり (link-dir は途中の E を辿って元のパスのファイルが消える、link-file は E だけが消える)
- `bindEx` の listener も閉じると綴りで消す。SPEC は「`_ex` の listener は閉じても消さない」なので、README の「SPEC から外れる点」に書く (ハブの答え 2026-11-21)。`remove()` を閉じる前に呼べば、link-dir の綴りは E が消えているので閉じる時の unlink は何も消さない

### アドレスを返す口

長いパスの listener (経路の綴りで listen した物) は、インスタンスの `address()` (node:net) と `unix` (`Bun.listen`) を元のパスを返すように上書きする。短いパスは触らない (標準が元のパスを返す)。

## Alternatives Considered

- 案 A: bun:ffi / node:ffi で全経路を作る (ハブの TS-Q1 の b)
  - 不採用理由 (今は): どちらも experimental。native 抜きで足りない所が見えてから決める
- 案 B: D の中に listen しているソケットを置き、`sweep` はそこへ connect して拒否されたら死んだ D とみなす
  - 不採用理由: 本物の flock でないので、Linux の systemd-tmpfiles が生きている D を守らない。O_SHLOCK と flock(1) で本物の flock が掛かる
- 案 C: `bindEx` の listener の close を包み、閉じる前に E を退けて unlink を空振りさせる
  - 不採用理由 (今は): 退けてから戻すまでに競合の窓がある。入れるなら別の DR で

## Consequences

- 届かない場面: ファイル名が link-dir に収まらない長さの bind (Linux は procB の綴りで、ファイル名がおよそ 70 を超える時。macOS は link-file があるので、ファイル名によらず届く)。connect は link-file が置き場に書ければどこにも届く
- ハブの適合試験の `langs.json` の ts の `lacks` に、作らない 5 つの経路を入れる
- Linux で flock(1) の無い環境は、長いパスの bind と `resolveForBind` / `resolveForConnect` が `ENAMETOOLONG` になる (既定の connect は D を作らないので届く)

## 関連

- [DR-0001](DR-0001-public-api-shape.md)、[DR-0003](DR-0003-standard-length-per-runtime.md)
- ハブの [SPEC-routes](https://github.com/kawaz/sockat/blob/main/docs/SPEC-routes-ja.md)
