# FiveRunner

Run FiveM resources in your browser and in CI. No GTA V, no FXServer, no restarts.

> **Status:** early development. `npx fiverunner test` runs the Lua tests of FiveM resources in Node; `npx fiverunner dev` comes next. Watch the repository to follow along.

## Testing resources

Write tests in files whose names end in `.test.lua`, next to your resource:

```lua
describe('bank', function()
    it('takes deposits', function()
        local ann = fiverunner.connect({ name = 'Ann' })
        ann:emit('bank:deposit', 100)
        expect(exports.bank:balance(ann.id)).toBe(600)
    end)
end)
```

Then run them, on your machine or in GitHub Actions:

```bash
npx fiverunner test
```

Each test gets a server of its own, with your resources started, and players whose clients run your client scripts. Time moves as fast as it can, so tests that wait take no time. [docs/testing.md](docs/testing.md) tells all that tests can do, and [examples/bank](examples/bank) is a resource with tests.

## Planned

- `npx fiverunner dev` loads your resources (client Lua, server Lua and NUI) into a browser page. Join fake players, fire events, inspect state and click through your NUI without launching the game.

## How it works

Your scripts run on CfxLua, the Lua 5.4 runtime FiveM ships, compiled to WebAssembly: the same syntax extensions, vectors and quaternions, `json` and `msgpack`. Each resource gets its own Lua state, one per side and per player, the same isolation FiveM gives you. On top of that, FiveRunner reimplements the Cfx scripting runtime: events with `source` and net-safety, exports, function references, state bags, threads and `Wait`, and the natives API.

Servers also get FiveM's own `io` and `os` libraries, its VFS and file permissions, its HTTP client and server, its server variables and its console.

## Differences from FiveM

FiveRunner follows FiveM's Windows server and its clients down to their error messages and their quirks. Where it differs, on purpose or for now, [docs/differences.md](docs/differences.md) says so.

## Clean room

FiveRunner's scripting runtime is a clean-room implementation and contains no code from the FiveM platform. CfxLua and its libraries are open source; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). FiveRunner is not affiliated with or endorsed by Cfx.re, Rockstar Games or Take-Two Interactive.

## License

[MIT](LICENSE)
