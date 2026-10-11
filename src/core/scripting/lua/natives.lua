--[[
FiveLab's native loader, which behaves like FiveM's natives_loader.lua.

Natives load on first use: _G gets an __index metamethod that asks
Citizen.LoadNative for the Lua code of a missing global and runs it. The code
defines the native's function in Global, which stores it in _G, so later uses
find it directly. Names that are no native are remembered, so looking them
up again costs nothing.
]]

local G = _G
local Citizen = Citizen
local msgpack = msgpack

local load = load
local rawget = rawget
local rawset = rawset
local setmetatable = setmetatable
local tostring = tostring
local type = type

local loadNative = Citizen.LoadNative
local pack = msgpack.pack

-- char* parameters: nil, false and 0 become NULL, anything else its string.
local function _ts(value)
    if value == 0 or not value then
        return nil
    end
    return tostring(value)
end

-- object parameters travel as msgpack bytes and their length.
local function _obj(value)
    local bytes = pack(value)
    return bytes, #bytes
end

-- Hash parameters also take names. Like FiveM, this looks up type and
-- GetHashKey when it runs.
local function _ch(value)
    if G.type(value) == 'string' then
        return G.GetHashKey(value)
    end
    return value
end

-- func parameters take function references.
local function _mfr(fn)
    return G.Citizen.GetFunctionReference(fn)
end

-- What native code assigns to Global lands in _G as well.
local Global = setmetatable({}, {
    __newindex = function(t, name, value)
        G[name] = value
        rawset(t, name, value)
    end,
})

local env = {
    Global = Global,
    _mfr = _mfr,
    _obj = _obj,
    _ch = _ch,
    _ts = _ts,
    msgpack = msgpack,
    rs = rawset,
    _i = Citizen.PointerValueInt(),
    _f = Citizen.PointerValueFloat(),
    _v = Citizen.PointerValueVector(),
    _r = Citizen.ReturnResultAnyway(),
    _ri = Citizen.ResultAsInteger(),
    _rf = Citizen.ResultAsFloat(),
    _rl = Citizen.ResultAsLong(),
    _s = Citizen.ResultAsString(),
    _rv = Citizen.ResultAsVector(),
    _ro = Citizen.ResultAsObject2(msgpack.unpack),
    _in = Citizen.InvokeNative,
    _in2 = Citizen.InvokeNative2,
    _gn = Citizen.GetNative,
    _ii = Citizen.PointerValueIntInitialized,
    _fi = Citizen.PointerValueFloatInitialized,
}

local missing = {}

setmetatable(G, {
    __index = function(t, name)
        local value = rawget(t, name)
        if not value and not missing[name] then
            local code = loadNative(name)
            if code then
                if type(code) == 'function' then
                    rawset(t, name, code)
                    value = code
                else
                    local chunk = load(code, '@' .. name .. '.lua', 't', env)
                    if chunk then
                        chunk()
                        value = rawget(t, name)
                    end
                end
            else
                missing[name] = true
            end
        end
        return value
    end,
})
