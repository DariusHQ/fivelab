--[[
    FiveLab state bags: GlobalState, and Entity and Player, whose state
    fields are the state bags of entities and players, as FiveM's scheduler
    defines them.

    A state bag reads its keys with GetStateBagValue, and sets them with
    SetStateBagValue, packed with msgpack: replicated when servers set them
    by assignment, and as its set method says otherwise.

    msgpack packs entities as their network ids, in extension 41, and
    players as their ids, in extension 42.

    Loaded by the runtime after the exports script, or on clients the NUI
    script, with its host functions.
]]

local host = ...

local type, error, tonumber, setmetatable = type, error, tonumber, setmetatable
local msgpack = msgpack
local msgpack_pack = msgpack.pack

local isServer = host.server

local EXT_ENTITY, EXT_PLAYER = 41, 42

msgpack.extend_clear(EXT_ENTITY, EXT_PLAYER)

-- The state bag named `bag`.
local function stateBag(bag)
    return setmetatable({}, {
        __index = function(_, key)
            if key == 'set' then
                return function(_, name, value, replicated)
                    local payload = msgpack_pack(value)
                    SetStateBagValue(bag, name, payload, payload:len(), replicated)
                end
            end
            return GetStateBagValue(bag, key)
        end,
        __newindex = function(_, key, value)
            local payload = msgpack_pack(value)
            SetStateBagValue(bag, key, payload, payload:len(), isServer)
        end,
    })
end

GlobalState = stateBag('global')

-- The name of the state bag of an entity: by its network id on servers and
-- for networked entities, and by the entity itself for others, whose bag
-- FiveM creates when it is asked for.
local function entityBag(entity)
    if isServer or NetworkGetEntityIsNetworked(entity) then
        return ('entity:%d'):format(NetworkGetNetworkIdFromEntity(entity))
    end
    EnsureEntityStateBag(entity)
    return ('localEntity:%d'):format(entity)
end

local entityMeta
entityMeta = {
    __ext = EXT_ENTITY,
    __index = function(self, key)
        if key == 'state' then
            local bag = entityBag(self.__data)
            if isServer then
                EnsureEntityStateBag(self.__data)
            end
            return stateBag(bag)
        end
        return nil
    end,
    __newindex = function()
        error('Setting values on Entity is not supported at this time.', 2)
    end,
    __pack = function(self)
        return tostring(NetworkGetNetworkIdFromEntity(self.__data))
    end,
    __unpack = function(data)
        return setmetatable({ __data = NetworkGetEntityFromNetworkId(tonumber(data)) }, entityMeta)
    end,
}

msgpack.extend(entityMeta)

local playerMeta
playerMeta = {
    __ext = EXT_PLAYER,
    __index = function(self, key)
        if key == 'state' then
            local id = self.__data
            -- The local player of a client.
            if id == -1 then
                id = GetPlayerServerId(PlayerId())
            end
            return stateBag(('player:%d'):format(id))
        end
        return nil
    end,
    __newindex = function()
        error('Setting values on Player is not supported at this time.', 2)
    end,
    __pack = function(self)
        return tostring(self.__data)
    end,
    __unpack = function(data)
        return setmetatable({ __data = tonumber(data) }, playerMeta)
    end,
}

msgpack.extend(playerMeta)

-- An entity's handle as a table with its state, or what is no number as it is.
function Entity(ent)
    if type(ent) == 'number' then
        return setmetatable({ __data = ent }, entityMeta)
    end
    return ent
end

-- A player's id as a table with its state, or what is no number nor string as it is.
function Player(ent)
    if type(ent) == 'number' or type(ent) == 'string' then
        return setmetatable({ __data = tonumber(ent) }, playerMeta)
    end
    return ent
end

if not isServer then
    LocalPlayer = Player(-1)
end
