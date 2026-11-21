# DR-0004: bindEx が相対パスのファイルを覚えられなかった時は、閉じると自分のソケットだけを消せる時にだけ閉じる

- Status: Active (ハブの答え 2026-11-22: 外部レビュー 1-6 の (1) は案 b)
- Date: 2026-11-22

## Context

- SPEC の「remove」は、bind したソケットのファイルを覚えられない時、listener を閉じて E を片付け、ファイルは消さずにエラーを返すと決めている。相対パスで、bind と覚えるまでの間に cwd が変わった時も同じ扱い
- Node と Bun の標準は、listener を閉じる時に listen に渡した文字列で unlink する (DR-0002「listener を閉じた時」)。止める口は無い。相対パスは、閉じた時点の cwd で解かれる
- そのため、bind の後に cwd が変わったのを見つけて閉じると、移った先の同じ名前の無関係なファイルを消す。SPEC の「閉じる」と「ファイルは消さない」が、ts では両立しない (外部レビュー 1-6)
- 長いパスの綴りは B・D・E を通るので、E を先に消してから閉じれば unlink は何も消さない。当たるのは、標準にそのまま渡した短い相対パスだけ

## Decision

bindEx と listenEx が、標準にそのまま渡した短い相対パスのファイルを cwd の変化で覚えられなかった時は、閉じる前に今の cwd でその名前を確かめる。

- 閉じる: bind が今の cwd で行われたと分かり (bind の呼び出しの前後で cwd の `(st_dev, st_ino)` が同じだった。node:net の `listen()` と `Bun.listen()` は呼び出しの中で bind する)、今の cwd でその名前を lstat した `(st_dev, st_ino)` が、bind の直後に覚えたソケットと同じ時。閉じると、bind したソケットが消える (SPEC どおり)
- 閉じない: それ以外 (bind した cwd が今と違う、分からない、その名前に何も無い、別の物がある)。listener は `unref()` して開いたまま手放し、エラーの文言にそう書く (`the listener was left open and unref'd rather than closed …; the socket file stays where it was bound`)
- 見分けられない時は閉じない側に倒す
- 長いパス (E を通る綴り) と絶対パスの短いパスは、今まで通り閉じる

## Alternatives Considered

- 案 a: 見つけたら、確かめずにいつも閉じずに手放す
  - 不採用理由: bind が移った先の cwd で行われた時 (cwd が bind の前に変わった) は、閉じると bind したソケットだけが消えて SPEC どおりになる。確かめれば閉じられる場面まで、fd とファイルを残すことになる
- 案 c: 振る舞いを変えず、README に「cwd を変えるプロセスは bind の前に絶対パスにする」とだけ書く
  - 不採用理由: sockat が自分で閉じて、無関係なファイルを消す道が残る。利用者の書き方では避けられない場面 (他の処理が cwd を変える) がある

## Consequences

- 閉じなかった listener は、プロセスが終わるまで fd とソケットのファイルを残す (unref したので、プロセスの終わりは止めない)。利用者には listener が返らないので、自分で閉じる手段は無い
- lstat から close までの間に、その名前を他の物に置き換えられると見分けられない (inode を指定して unlink する手段が無い。SPEC「remove」と同じ限界)
- bind の呼び出しの前後で cwd が変わって戻った場合は見分けられない (SPEC「remove」の相対パスと同じ)

## 関連

- [DR-0002](DR-0002-native-free-routes.md) (listener を閉じた時)
- ハブの [SPEC の remove](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#remove)、外部レビュー (ハブの `docs/research/2026-11-21-external-review-carbon.md`) の 1-6
