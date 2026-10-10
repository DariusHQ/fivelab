# FiveLab

Run FiveM resources in your browser and in CI. No GTA V, no FXServer, no restarts.

> **Status:** early development. Nothing is usable yet. Watch the repository to follow along.

## Planned

- `npx fivelab dev` loads your resources (client Lua, server Lua and NUI) into a browser page. Join fake players, fire events, inspect state and click through your NUI without launching the game.
- `npx fivelab test` runs Lua tests against the same engine in Node, so GitHub Actions can catch a broken event, export or callback on every push.

## How it works

Your scripts run on CfxLua, the Lua 5.4 runtime FiveM ships, compiled to WebAssembly: the same syntax extensions, vectors and quaternions, `json` and `msgpack`. Each resource gets its own Lua state, one per side and per player, the same isolation FiveM gives you. On top of that, FiveLab reimplements the Cfx scripting runtime: events with `source` and net-safety, exports, function references, state bags, threads and `Wait`, and the natives API.

FiveLab's scripting runtime is a clean-room implementation and contains no code from the FiveM platform. CfxLua and its libraries are open source; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). FiveLab is not affiliated with or endorsed by Cfx.re, Rockstar Games or Take-Two Interactive.

## License

[MIT](LICENSE)
