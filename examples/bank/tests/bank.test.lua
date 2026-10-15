describe('bank', function()
    local ann

    beforeEach(function()
        ann = fiverunner.connect({ name = 'Ann' })
    end)

    it('starts players with 500', function()
        expect(exports.bank:balance(ann.id)).toBe(500)
    end)

    it('takes deposits', function()
        ann:emit('bank:deposit', 100)
        expect(exports.bank:balance(ann.id)).toBe(600)
    end)

    it('tells clients their balance', function()
        ann:emit('bank:deposit', 100)
        fiverunner.waitFor(function()
            return #ann:received('bank:balance') > 0
        end)
        expect(ann:received('bank:balance')).toEqual({ { 600 } })
        expect(ann:run('return exports.bank:balance()')).toBe(600)
        expect(ann:output()).toContain('[script:bank] Balance: $600')
    end)

    it('refuses to withdraw more than players have', function()
        ann:emit('bank:withdraw', 1000)
        expect(exports.bank:balance(ann.id)).toBe(500)
        fiverunner.waitFor(function()
            return #ann:received('bank:error') > 0
        end)
        expect(ann:received('bank:error')).toEqual({ { 'insufficient funds' } })
    end)

    it('keeps the balances of players apart', function()
        local bob = fiverunner.connect({ name = 'Bob' })
        ann:emit('bank:deposit', 100)
        expect(exports.bank:balance(bob.id)).toBe(500)
    end)

    it('forgets the balances of players that leave', function()
        ann:emit('bank:deposit', 100)
        local id = ann.id
        ann:disconnect()
        expect(exports.bank:balance(id)).toBe(500)
    end)
end)
