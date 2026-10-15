# Testing resources

`fiverunner test` runs Lua tests against your resources in Node: a FiveM server, and the clients of the players that tests connect, on FiveRunner's engine. No GTA V, no FXServer.

```bash
npx fiverunner test
```

It runs the tests of the project in the directory it runs in:

- A **resource**, when the directory has an `fxmanifest.lua` or a `__resource.lua`. Servers of tests have it as `resources/<name of the directory>` and ensure it, so a resource in `bank/` is the resource `bank`.
- A **server**, when the directory has a `resources` directory. Servers of tests scan it for resources, then run the commands of `server.cfg`, if there is one, as `+exec server.cfg` would.

Test files are the files whose names end in `.test.lua`, anywhere in the project but in `node_modules` and hidden directories. They are not part of your resources: their resources do not see them, so a manifest that globs `**/*.lua` does not load them as scripts.

To run only some of them, give their paths, or the directories they are in:

```bash
npx fiverunner test tests/bank.test.lua tests/players
```

## Writing tests

```lua
describe('bank', function()
    it('starts players with 500', function()
        local ann = fiverunner.connect({ name = 'Ann' })
        expect(exports.bank:balance(ann.id)).toBe(500)
    end)

    it('deposits', function()
        local ann = fiverunner.connect({ name = 'Ann' })
        ann:emit('bank:deposit', 100)
        expect(exports.bank:balance(ann.id)).toBe(600)
    end)
end)
```

A test file runs as a server script of a resource of its own, `fiverunner`, which starts after the resources of the project. It reaches them as any resource would: with exports, events, state bags, commands and natives.

**Each test runs in a server of its own**, which starts the project anew: what a test does, the next test does not see. A first server loads the file to collect its tests, then each test that runs gets a server, so the code of the file outside tests runs each time.

- `describe(name, fn)` groups tests, and may hold other describes.
- `it(name, fn, timeout)` adds a test, which `test` adds too. A test fails if it does not end within its timeout: 5000 milliseconds, unless it gives its own.
- `it.skip` and `describe.skip` skip tests. `it.only` and `describe.only` run tests alone: once a file marks a test with only, its other tests are skipped.
- `beforeEach(fn)` and `afterEach(fn)` add hooks to the describe they are in, or to the file. A test runs after the `beforeEach` hooks of its describes, from the outermost in, and before their `afterEach` hooks, from the innermost out, the last added first. When a `beforeEach` hook fails, the test does not run, but the `afterEach` hooks do.

Tests run in threads, so they may `Wait`. Errors fail tests, with the line of the test file they came through.

## expect

`expect(value)` checks `value` with a matcher. Call matchers with a dot:

```lua
expect(balance).toBe(600)
expect(player).never.toBeNil()
```

| Matcher                  | Passes when the value                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `toBe(expected)`         | is `expected`: the same table, or the same string, number or boolean, NaN included                          |
| `toEqual(expected)`      | equals `expected`: tables with the same keys and equal values, whatever their metatables                    |
| `toBeTruthy()`           | is neither `nil` nor `false`                                                                                |
| `toBeFalsy()`            | is `nil` or `false`                                                                                         |
| `toBeNil()`              | is `nil`                                                                                                    |
| `toBeGreaterThan(n)`     | is a number greater than `n`, and so for `toBeGreaterThanOrEqual`, `toBeLessThan` and `toBeLessThanOrEqual` |
| `toBeCloseTo(n, digits)` | is a number that differs from `n` by less than half of 10 to the power of minus `digits`: 2 unless given    |
| `toContain(item)`        | is a string that holds the string `item`, or a table with a value that is `item`                            |
| `toContainEqual(item)`   | is a table with a value that equals `item`                                                                  |
| `toHaveLength(n)`        | is a string or a table whose length is `n`                                                                  |
| `toMatch(pattern)`       | is a string that matches the Lua pattern `pattern`                                                          |
| `toThrow(text)`          | is a function that raises an error when called, whose message holds `text`, if given                        |

`never` negates them: `expect(value).never.toBe(nil)`.

## Players

`fiverunner.connect(identity)` connects a player, and returns it once its client started the resources of the server. If the server refuses the player, it returns `nil` and why.

```lua
local ann = fiverunner.connect({
    name = 'Ann',
    identifiers = { 'license:abc', 'discord:123' },
    tokens = { '3:abc' },
    endpoint = '127.0.0.2',
    guid = '1234',
})
```

Every field is optional. Each player runs a client of its own, with the client scripts of your resources.

| Field or method             |                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `player.id`                 | The id of the player on the server, its `source`                                                                                      |
| `player.name`               | Its name                                                                                                                              |
| `player:run(code, ...)`     | Runs the Lua code `code` in the client of the player, with `...` as its arguments, and returns what it returns. Raises what it raises |
| `player:emit(event, ...)`   | Triggers `event` on the server from the client, with `...`, and returns once the server got it                                        |
| `player:received(event)`    | The arguments of each `event` that the client got from the server, in the order they came                                             |
| `player:output()`           | What the client printed, line by line, as `[channel] text`, without colors                                                            |
| `player:disconnect(reason)` | Disconnects the player, as players quit, and returns once the server dropped it                                                       |

`player:run` runs code given as a string, as Lua cannot send functions with their upvalues to another state: give the code what it needs as arguments.

```lua
local x, y = ann:run('local a, b = ... return a + b, GetCurrentResourceName()', 1, 2)
```

## Helpers

- `fiverunner.output()` gives what the server printed, line by line, as `[channel] text`, without colors.
- `fiverunner.waitFor(check, timeout)` calls `check` at each tick until it returns something truthy, and returns that. With a `timeout`, in milliseconds, it fails the test once that much time went by.

```lua
fiverunner.waitFor(function() return #ann:received('bank:balance') > 0 end)
```

## Time

The clock of the server of a test moves only as FiveRunner moves it, frame by frame, as fast as it can: `Wait(60000)` takes no time. Timeouts are by that clock. `GetGameTimer` starts at 0, and the wall clock of each server starts at 2026-01-01 00:00:00 UTC, in UTC, so `os.time` and `os.date` give the same results on every run.

## The servers of tests

- They run the resources of the project, with their files as they are on the disk. What tests write, such as with `SaveResourceFile`, stays in memory, and the next test does not see it.
- KVP starts empty.
- `PerformHttpRequest` sends no requests: each fails as if no server took it, with status 0 and the error `FiveRunner sends no HTTP requests in tests - CURL error code 7 (Couldn't connect to server)`.
- Tests may run any command with `ExecuteCommand`, as the console may.
- A script that runs for 5 seconds without returning, such as a loop without `Wait`, gets an error.

The rest is FiveRunner's engine, which follows FiveM's server and clients as [docs/differences.md](differences.md) says. Natives that FiveRunner does not implement do nothing and return zero values, and tests say so in their output when they fail.

## Output

`fiverunner test` writes a line for each test file, then each failure, with where it failed and what the server and the clients printed, but for the lines that tell that resources start and stop:

```text
✓ tests/bank.test.lua (2 tests)
× tests/withdraw.test.lua (1 test, 1 failed)
   × withdraws

Failed: tests/withdraw.test.lua > withdraws
  expected 500 to be 400
    at tests/withdraw.test.lua:4
  Output:
    [script:fiverunner] withdrawing

Test files: 1 failed, 1 passed (2)
Tests: 1 failed, 2 passed (3)
Duration: 0.15 s
```

It exits with 0 when the tests passed, 1 when any failed, a test file did not load or had no tests, or there were no test files, and 2 when its arguments make no sense or there is no project.

## GitHub Actions

On GitHub Actions, `fiverunner test` also annotates each failure at its line. A workflow that runs the tests of a resource on each push:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npx fiverunner test
```

FiveRunner needs Node 22 or later.
