import { describe, expect, it } from 'vitest'

import {
  bytesToBase64,
  imageFileFromTransfer,
  pastedImageFileName
} from '@renderer/utils/clipboard-images'

/** A `DataTransfer` stand-in — jsdom's is not constructible with files. */
function transfer(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer
}

function file(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

describe('imageFileFromTransfer', () => {
  it('finds the image in a payload that also carries other files', () => {
    const image = file('shot.png', 'image/png')
    expect(imageFileFromTransfer(transfer([file('a.txt', 'text/plain'), image]))).toBe(image)
  })

  it('matches the content type case-insensitively', () => {
    const image = file('shot.png', 'IMAGE/PNG')
    expect(imageFileFromTransfer(transfer([image]))).toBe(image)
  })

  it('returns null for a paste with no image, so the editor keeps it', () => {
    // The load-bearing case: consuming every paste would break copying text in.
    expect(imageFileFromTransfer(transfer([]))).toBeNull()
    expect(imageFileFromTransfer(transfer([file('a.txt', 'text/plain')]))).toBeNull()
    expect(imageFileFromTransfer(null)).toBeNull()
  })
})

describe('pastedImageFileName', () => {
  const at = new Date('2026-09-03T14:22:05.000Z')

  it('keeps a name the user\'s own file carried', () => {
    expect(pastedImageFileName(file('diagram.png', 'image/png'), at)).toBe('diagram.png')
  })

  it('synthesises a distinguishable name for a clipboard screenshot', () => {
    // Chromium reports `image.png` for every one, so two pastes would otherwise
    // be indistinguishable in the attachments list.
    for (const generic of ['image.png', 'image', 'blob', '', 'clipboard.png']) {
      expect(pastedImageFileName(file(generic, 'image/png'), at), generic).toBe(
        'pasted-image-2026-09-03-14-22-05.png'
      )
    }
  })

  it('takes the extension from the content type', () => {
    expect(pastedImageFileName(file('image.png', 'image/jpeg'), at)).toContain('.jpg')
    expect(pastedImageFileName(file('', 'image/webp'), at)).toContain('.webp')
    // An unknown image type still gets a plausible extension rather than none.
    expect(pastedImageFileName(file('', 'image/x-weird'), at)).toContain('.png')
  })

  it('never puts a colon in the name', () => {
    // Windows rejects them, and the name becomes a file on disk when saved.
    expect(pastedImageFileName(file('', 'image/png'), at)).not.toContain(':')
  })
})

describe('bytesToBase64', () => {
  it('encodes bytes the way the upload command decodes them', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
  })

  it('encodes a payload far past the argument limit', () => {
    // The whole reason the function chunks: `fromCharCode(...bytes)` on a
    // screenshot-sized array overflows the call stack.
    const bytes = new Uint8Array(300_000).fill(0x41)
    const encoded = bytesToBase64(bytes)

    expect(encoded).toHaveLength(Math.ceil(bytes.length / 3) * 4)
    expect(atob(encoded)).toHaveLength(bytes.length)
  })

  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, index) => index)
    const decoded = atob(bytesToBase64(bytes))

    expect([...decoded].map((character) => character.charCodeAt(0))).toEqual([...bytes])
  })
})
