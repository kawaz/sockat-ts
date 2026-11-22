# DR-0004: bindEx が標準に渡した綴りのファイルを覚えられなかった時は、閉じると自分のソケットだけを消せる時にだけ閉じる

- Status: Active (ハブの答え 2026-11-22: 外部レビュー 1-6 の (1) は案 b。同じ日のハブの答えで、短い絶対パスの置き換えにも広げた。ハブの DR-0019 で、cwd を比べるのは相対のまま標準に渡した綴りだけになった)
- Date: 2026-11-22

## Context

- SPEC の「remove」は、bind したソケットのファイルを覚えられない時、listener を閉じて E を片付け、ファイルは消さずにエラーを返すと決めている。覚えられないのは、bind の直後にソケットが置き換えられた時と、相対のまま標準に渡した綴り (`CwdRelative`) で bind と覚えるまでの間に cwd が変わった時
- Node と Bun の標準は、listener を閉じる時に listen に渡した文字列で unlink する (DR-0002「listener を閉じた時」)。止める口は無い。相対の綴りは、閉じた時点の cwd で解かれる
- そのため、標準に渡した綴り (route が `standard`) では、閉じると次の物を消す。SPEC の「閉じる」と「ファイルは消さない」が、ts では両立しない (外部レビュー 1-6)
  - 絶対の綴り (標準に渡す長さ以下の絶対パス、ハブの DR-0019 の絶対パスの候補): bind の直後に置き換えた物を消す
  - 相対の綴り (`CwdRelative`。どの候補も経路も使えず、相対のまま渡した時だけ): bind の後に cwd が変わっていれば、移った先の同じ名前の無関係なファイルを消す
- 経路の綴りは B・D・E を通るので、E を先に消してから閉じれば unlink は何も消さない。当たるのは、標準に渡した綴りだけ

## Decision

bindEx と listenEx が、標準に渡した綴りのファイルを覚えられなかった時は、閉じる前にその綴りを確かめる。

- 閉じる条件は、次の全部が成り立つ時。閉じると、bind したソケットが消える (SPEC どおり)
  1. bind の直後にソケットのファイルを覚えていた (覚えられなかった理由が、`CwdRelative` の cwd の変化だけの時)
  2. `CwdRelative` では、bind が今の cwd で行われたと分かっている (bind の呼び出しの前後で cwd の `(st_dev, st_ino)` が同じだった。node:net の `listen()` と `Bun.listen()` は呼び出しの中で bind する)
  3. 標準に渡した綴りを lstat した `(st_dev, st_ino)` が、覚えたソケットと同じ
- 閉じない: それ以外。次の場面を含む
  - ソケットが置き換えられて何も覚えていない
  - bind した cwd が今と違うか、分からない
  - その綴りに何も無いか、別の物がある
- 閉じない時は、listener を `unref()` して開いたまま手放し、エラーの文言にそう書く (`the listener was left open and unref'd rather than closed …`)
- 見分けられない時は閉じない側に倒す
- 経路の綴り (E を通る綴り) は、今まで通り E を消してから閉じる

## Alternatives Considered

- 案 a: 覚えられなかったら、確かめずにいつも閉じずに手放す
  - 不採用理由: bind が移った先の cwd で行われた時 (cwd が bind の前に変わった) は、閉じると bind したソケットだけが消えて SPEC どおりになる。確かめれば閉じられる場面まで、fd とファイルを残すことになる
- 案 c: 振る舞いを変えず、README に「cwd を変えるプロセスは bind の前に絶対パスにする」「置き換えられたら消える」とだけ書く
  - 不採用理由: sockat が自分で閉じて、無関係なファイルを消す道が残る。利用者の書き方では避けられない場面 (他の処理が cwd を変える、他のプロセスが置き換える) がある

## Consequences

- 閉じなかった listener は、プロセスが終わるまで fd を残す (unref したので、プロセスの終わりは止めない)。利用者には listener が返らないので、自分で閉じる手段は無い
- 置き換えられた絶対の綴りでは、置き換えた物がそのまま残る。`CwdRelative` では、bind したソケットのファイルが bind した所に残る
- lstat から close までの間に、その綴りを他の物に置き換えられると見分けられない (inode を指定して unlink する手段が無い。SPEC「remove」と同じ限界)
- bind の呼び出しの前後で cwd が変わって戻った場合は見分けられない (SPEC「remove」の `CwdRelative` と同じ)
- cwd が PATH_MAX より深い所の `CwdRelative` の bindEx は、ソケットのファイルの realpath を引けないので覚えられず、ここに当たる (DR-0005)

## 関連

- [DR-0002](DR-0002-native-free-routes.md) (listener を閉じた時)、[DR-0005](DR-0005-absolutize-relative-path-details.md)
- ハブの [SPEC の remove](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#remove)、外部レビュー (ハブの `docs/research/2026-11-21-external-review-carbon.md`) の 1-6、[DR-0019](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0019-absolutize-relative-path-on-bind.md)
