-- The balance that the server last told the player of.
local balance

RegisterNetEvent('bank:balance', function(value)
    balance = value
    print(('Balance: $%d'):format(value))
end)

RegisterNetEvent('bank:error', function(message)
    print(('Bank error: %s'):format(message))
end)

exports('balance', function()
    return balance
end)
