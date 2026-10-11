--[[
    FiveLab function references: Citizen.GetFunctionReference, and the
    routines the runtime runs for the references of its functions.

    A reference names a function of a runtime, so that other runtimes can
    call it. Citizen.CanonicalizeRef formats it from the reference's index,
    as "resource:instance:index", which FiveM's script host looks it up by.
    Indices count up from 0 in each runtime, as in FiveM.

    Each reference counts the holders that duplicated it, from 0. Deleting
    it takes one away, and once none is left, or when it had none, the
    runtime forgets the function.

    Loaded by the runtime after the events script, with the table the
    FiveLab scripts share.
]]

local fivelab = ...

local type, rawget = type, rawget

local Citizen = Citizen

-- The functions that references name, by index, with their holders.
local references = {}
local nextIndex = 0

local function reference(fn)
    local index = nextIndex
    references[index] = { fn = fn, holders = 0 }
    nextIndex = index + 1
    -- FiveM looks the function up in the Citizen table when it runs.
    return Citizen.CanonicalizeRef(index)
end

-- References a function, or a reference of another runtime, which FiveM
-- references through a function that calls it. Other values have none.
function Citizen.GetFunctionReference(fn)
    if type(fn) == 'function' then
        return reference(fn)
    elseif type(fn) == 'table' and rawget(fn, '__cfx_functionReference') then
        return reference(function(...)
            return fn(...)
        end)
    end
    return nil
end

--[[ Routines the runtime runs ]]

-- Counts another holder of a reference, and returns the index it keeps, or
-- -1 for a reference the runtime does not have.
function fivelab.duplicateRef(index)
    local entry = references[index]
    if not entry then
        return -1
    end
    entry.holders = entry.holders + 1
    return index
end

-- Takes a holder of a reference away, forgetting it once none is left.
function fivelab.deleteRef(index)
    local entry = references[index]
    if not entry then
        return
    end
    entry.holders = entry.holders - 1
    if entry.holders <= 0 then
        references[index] = nil
    end
end
