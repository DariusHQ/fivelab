-- The balances of players, by their ids. Players start with 500.
local balances = {}

local function balanceOf(id)
    return balances[id] or 500
end

exports('balance', balanceOf)

RegisterNetEvent('bank:deposit', function(amount)
    local id = source
    if type(amount) ~= 'number' or amount <= 0 then
        TriggerClientEvent('bank:error', id, 'invalid amount')
        return
    end
    balances[id] = balanceOf(id) + amount
    TriggerClientEvent('bank:balance', id, balances[id])
end)

RegisterNetEvent('bank:withdraw', function(amount)
    local id = source
    if type(amount) ~= 'number' or amount <= 0 or amount > balanceOf(id) then
        TriggerClientEvent('bank:error', id, 'insufficient funds')
        return
    end
    balances[id] = balanceOf(id) - amount
    TriggerClientEvent('bank:balance', id, balances[id])
end)

AddEventHandler('playerDropped', function()
    balances[source] = nil
end)
