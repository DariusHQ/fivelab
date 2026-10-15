# Vendored Lua libraries

These files are copied unmodified from their projects; see
[THIRD_PARTY_NOTICES.md](../../../../../THIRD_PARTY_NOTICES.md) for their licenses.

| File           | Project                                                       | Commit                                     |
| -------------- | ------------------------------------------------------------- | ------------------------------------------ |
| `deferred.lua` | [zserge/lua-promises](https://github.com/zserge/lua-promises) | `b3004b0d8586f3a5a38307afaa135776c8067c57` |

FiveM ships the same promise library as its `promise` global, so FiveRunner loads it into
every script runtime under that name.
