export const base32 = {
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  padding: '=',

  fromCharCode(code: number): number {
    const s = String.fromCharCode(code)
    return this.alphabet.indexOf(s)
  },

  encode(buffer: Buffer): string {
    const length = Math.ceil(buffer.length / 5) * 8
    const result = Buffer.alloc(length, this.padding)

    const mask = 0x1f

    let i = 0
    let j = 0
    let k = 0

    while (i < buffer.length) {
      if ((k += 5) >= 5) {
        k -= 8
      }

      let x = 0
      if (k < 0) {
        x |= (buffer[i] >> -k) | (buffer[i + 1] << (8 + k))
      } else {
        x |= (buffer[i] << k) | (buffer[i + 1] >> (8 - k))
        i += 1
      }

      result[j] = this.alphabet.charCodeAt(x & mask)
      j += 1
    }

    return result.toString()
  },

  decode(text: string): Buffer {
    text = text.replace(/=*$/, '')

    const length = Math.floor((text.length * 5) / 8)
    const result = Buffer.alloc(length, 0)

    let i = 0
    let j = 0
    let k = 0

    while (i < text.length) {
      const x = this.fromCharCode(text.charCodeAt(i))

      if (x === -1) {
        i += 1
        continue
      }

      if (k < 3) {
        result[j] |= x << (3 - k)
        i += 1
        k += 5
      } else {
        result[j] |= x >> (k - 3)
        j += 1
        k -= 8
      }
    }

    return result
  },
}

export const base64 = {
  encode(buffer: Buffer): string {
    return buffer.toString('base64')
  },

  decode(text: string): Buffer {
    return Buffer.from(text, 'base64')
  },
}
