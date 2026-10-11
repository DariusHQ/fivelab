import { describe, expect, it } from 'vitest'

import { nativeWrapper } from '../../src/core/natives/index.ts'

describe('nativeWrapper', () => {
  it('generates the function FiveM generates', () => {
    expect(
      nativeWrapper(
        {
          hash: 0x3fef770d40960d5an,
          result: 'Vector3',
          params: [
            { name: 'entity', type: 'Entity' },
            { name: 'alive', type: 'BOOL' },
          ],
        },
        'GetEntityCoords',
      ),
    ).toBe(
      'function Global.GetEntityCoords(entity, alive)\n' +
        '\treturn _in(0x3FEF770D40960D5A, entity, alive, _rv)\n' +
        'end\n',
    )
    expect(
      nativeWrapper(
        {
          hash: 0xc906a7dab05c8d2bn,
          result: 'BOOL',
          params: [
            { name: 'x', type: 'float' },
            { name: 'y', type: 'float' },
            { name: 'z', type: 'float' },
            { name: 'groundZ', type: 'float*' },
            { name: 'includeWater', type: 'BOOL' },
          ],
        },
        'GetGroundZFor_3dCoord',
      ),
    ).toBe(
      'function Global.GetGroundZFor_3dCoord(x, y, z, includeWater)\n' +
        '\treturn _in(0xC906A7DAB05C8D2B, x, y, z, _f, includeWater, _r)\n' +
        'end\n',
    )
    expect(
      nativeWrapper(
        {
          hash: 0x1234n,
          result: 'object',
          params: [
            { name: 'data', type: 'object' },
            { name: 'model', type: 'Hash' },
            { name: 'repeat', type: 'int' },
            { name: 'out', type: 'float*' },
          ],
        },
        'Example',
      ),
    ).toBe(
      'function Global.Example(data, model, repeat_, out)\n' +
        '\tlocal data_bytes, data_len = _obj(data)\n' +
        '\treturn _in(0x1234, data_bytes, data_len, _ch(model), repeat_, _fi(out), _ro)\n' +
        'end\n',
    )
  })
})
