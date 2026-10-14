/*
 * Included before lua-cmsgpack. It takes a target whose pointers have 32 bits
 * for a 32-bit Lua, and then packs integers in 32 bits and floats as singles.
 * WebAssembly's pointers have 32 bits, but CfxLua's integers and floats have 64
 * here, as in the 64-bit builds of FiveM, which pack them in full. lua-cmsgpack
 * only reads the value of UINTPTR_MAX to make that choice, and Lua only checks
 * that it is defined, so the translation unit of lua-cmsgpack sees the value of
 * a 64-bit target.
 */
#include <stdint.h>

#undef UINTPTR_MAX
#define UINTPTR_MAX UINT64_MAX
