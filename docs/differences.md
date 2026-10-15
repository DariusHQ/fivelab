# Differences from FiveM

FiveRunner follows FiveM's Windows server and its clients as closely as it can, down to their error messages and their quirks. This page lists where it differs, on purpose or for now.

## Scripts

- Stack traces name FiveRunner's own scripts after it, such as `@fiverunner:/scheduler.lua`, where FiveM names its own, and those frames are not the same as FiveM's.
- NaN prints as `-nan` and `nan`, as the C library of FiveRunner's WebAssembly build writes it, where FiveM's MSVC build writes `-nan(ind)` and `nan`. This goes for `tostring`, `string.format` and `f:write`.
- Where FiveM throws exceptions with MSVC's texts, such as for convars that `std::stof` reads, FiveRunner approximates the texts, and the sign of the NaN that `std::stof` reads.

## Console

- Command lines with surrogates encoded in UTF-8 keep a high and a low surrogate as the one character they spell, where FiveM writes them back to UTF-8 one by one.
- The raw lines of commands are text, so bytes that are not UTF-8 do not come back as they were.
- The wildcards of channel filters and convar change listeners follow JavaScript's regular expressions on line breaks, where FiveM uses `std::regex`.
- A console listener that prints what it hears stops hearing prints after 16 levels, where FiveM recurses until the server crashes.
- KVP lives in memory, not in a database.

## Server

- FiveM's built-in variables are all defined, with their types, flags and defaults, but FiveRunner acts on few of them. It runs GTA V only, with no switch to RDR3 by `gamename`. `citizen_dir` is not defined, `sv_infoVersion` stays 0, there is no `increase_pool_size`, and `version` reads `win32`, as FiveRunner follows FiveM's Windows build throughout.
- `endpoint_add_tcp` and `endpoint_add_udp` listen nowhere and resolve no names. The first TCP endpoint still sets the primary port.
- There are no system resources.
- Directories list in the order of NTFS, for scans of resources as for `io`, whatever order the files of the host have, with upper case as JavaScript has it for each UTF-16 code unit, which can differ from the table of an NTFS volume for a few characters.
- Relative paths of resources use forward slashes, with no doubled slashes.
- Nothing is rate-limited: events, latent events, state bags, commands and HTTP requests.

## Players

- `GetPlayers` lists players in the order they connected.
- Clients download resources at their next tick and start them at the one after. Ping is 0 unless set, and `lastSeen` moves with the ticks of clients.
- A client that fails to start a resource goes on, with a diagnosis, where FiveM's client stops with "Couldn't start resource".
- A client that leaves resets its resources at its next tick, where FiveM's does once its game session ends. A start that the client had pending for a resource that it removed meanwhile does not happen, where FiveM's race would start a destroyed resource.

## Events and state bags

- Latent events arrive by a deadline: the end of the sender's tick, plus the latency in whole milliseconds for each fragment after the first. Nothing is acknowledged or sent again, and pending events have no limit: `sv_netEventReassemblyMaxPendingEvents` is defined but not enforced.
- There are no entities, so no state bags of entities (`GetEntityFromStateBagName` gives 0) and no scopes. The state bags of players reach only their own clients, as in OneSync's big mode. Their packets have no size limit, and arrive at the start of the other side's next tick.

## HTTP

- `PerformHttpRequest` sends requests with `fetch` by default. Header names come back in lower case, repeated headers are joined but `Set-Cookie`, GET and HEAD send no body, TLS certificates are verified, which FiveM does not do, requests use HTTP/1.1 only, and curl's error texts are approximated. Browsers also hide redirects. `PerformHttpRequestInternal`, the JSON variant, is not implemented.
- The HTTP server listens nowhere by itself: embedders hand it requests through `HttpServer.request`. Of FiveM's own endpoints, only `/` exists, with no `/info.json`, `/players.json`, `/dynamic.json`, `/client`, `/files/` or `/perf/`. Requests come whole, so FiveM's loss of chunked bodies sent before `setDataHandler` does not happen. The server speaks HTTP/1.1 only, leaves `Date` and `Connection` to the transport, and writes nothing after a response ends, where FiveM writes past it.

## os and io (servers)

- Names of local time zones come from `Intl`, which can differ from Windows' names for `%Z`.
- `os.rdtsc` and `os.rdtscp` read no real time stamp counter: they count 3 ticks for each nanosecond of the steady clock.
- Paths know only the mounts of resources, `@name/`, and the server's own files: none of FiveM's `citizen:/`, `cache:/`, `kvs:/` and `memory:` devices, nor absolute paths of the host.
- Where FiveM reports `errno` as earlier calls left it, for `io.flush`, `io.tmpfile`, failed `f:write` and `f:flush`, and failed `io.popen`, FiveRunner reports 0, "No error".
- `f:read` with a count above 2^31 - 1 fails with "not enough memory", where FiveM fails or not by what it can allocate.
- Files are shared as FiveM's own handles share them, with no other processes or antivirus locks.

The rest of FiveM's VFS rules, the 64 KiB read-ahead of `f:lines`, the quirks of `f:read`, the cutting of files after writes and the 32-bit seeks of `SetFilePointer` are emulated as FiveM has them.
