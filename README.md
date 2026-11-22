# sockat (TypeScript)

> English | [日本語](./README-ja.md)

Your Unix domain socket path is too long to bind / connect. `@kawaz/sockat` is a JavaScript / TypeScript library that makes that go away. It works the same on Node.js and on Bun, whatever the version.

Hand a long path to the standard `node:net`, and the bind fails with this error (the same words on Node.js and on Bun):

```text
Error: listen EINVAL: invalid argument /…/app.sock
```

Where it starts to fail differs by runtime and version. Some versions of Node.js, and Bun, let a long path through up to some length, and a path may even be cut short without a word, so the same code works in one environment and not in another.

Replace the standard code with sockat's, and long paths just work. It is the same code on Node.js and on Bun.

```ts
import { bind, connect } from "@kawaz/sockat";

// const server = net.createServer().listen(path);
const server = await bind(path); // returns once it is listening

// const socket = net.connect(path);
const socket = await connect(path); // returns once it is connected
```

You get back the same `net.Server` / `net.Socket` as the standard, and short paths go to the standard unchanged, as before. Only for a long path does sockat quietly set up a short way to the same place and connect through it. You don't need to shorten paths yourself or care about each runtime's or OS's limit.

## Install

```sh
npm install @kawaz/sockat
# or
bun add @kawaz/sockat
```

It runs on Node.js 22 or later and on Bun, with no dependencies and no native code.

## More

- [User manual](./docs/MANUAL.md)
- [Reference](./docs/MANUAL.md#functions)
- [How it works](https://github.com/kawaz/sockat/blob/main/pages/technical.md)

## License

MIT
