# FiveLab

Run FiveM resources in your browser and in CI. No GTA V, no FXServer, no restarts.

> **Status:** early development. Nothing is usable yet. Watch the repository to follow along.

## Planned

- `npx fivelab dev` loads your resources (client Lua, server Lua and NUI) into a browser page. Join fake players, fire events, inspect state and click through your NUI without launching the game.
- `npx fivelab test` runs Lua tests against the same engine in Node, so GitHub Actions can catch a broken event, export or callback on every push.

## How it works

Each resource runs in its own Lua 5.4 VM ([wasmoon](https://github.com/ceifa/wasmoon)), one per side and per player, the same isolation FiveM gives you. On top of that, FiveLab reimplements the Cfx scripting runtime: events with `source` and net-safety, exports, function references, state bags, threads and `Wait`, the CfxLua syntax extensions, vectors and the natives API.

FiveLab is a clean-room implementation and contains no code from the FiveM project. It is not affiliated with or endorsed by Cfx.re, Rockstar Games or Take-Two Interactive.

## License

[MIT](LICENSE)
