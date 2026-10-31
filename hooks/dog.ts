// The puppy and its track, drawn as Raster cells: each terminal cell holds
// two pixels, the upper as a half block's foreground, the lower as its back.

export const DOG_ROWS = 4
export const DOG_WIDTH = 16
const PIXEL_ROWS = DOG_ROWS * 2
const FLAG_ROOM = 5
const DEFAULT = 0x01000000

const PALETTE: Record<string, number> = {
  B: 0xe3a15a, // coat
  D: 0x9a5b2e, // ears and tail
  W: 0xfff1dc, // muzzle and chest
  K: 0x262626, // eye and nose
  P: 0xff7f8f, // tongue
  G: 0x6b6b6b, // ground
  S: 0xbdbdbd, // dust
  F: 0xf5f5f5, // flag
  L: 0x9e9e9e, // pole
  Z: 0x8fb8ff, // a sleepy z
}

const RUN_A = [
  '...........DD...',
  'D.........DBBB..',
  '.D........BBKBB.',
  '..DBBBBBBBBBBWWK',
  '..BBBBBBBBBBWWW.',
  '...BBBBBBBBB.P..',
  '..BB.......BB...',
  '.BB.........BB..',
]

const RUN_B = [
  '...........DD...',
  '..........DBBB..',
  'D.........BBKBB.',
  '.DDBBBBBBBBBBWWK',
  '..BBBBBBBBBBWWW.',
  '...BBBBBBBBB.P..',
  '....BB....BB....',
  '....B.B...B.B...',
]

const REST = [
  '................',
  '................',
  '................',
  '...........DD...',
  'D.........DBBB..',
  '.D........BBDBB.',
  '..DBBBBBBBBBBWWK',
  '..WWBBBBBBBWWWW.',
]

const REST_HAPPY = [
  '................',
  '................',
  '................',
  '...........DD...',
  'D.........DBBB..',
  '.D........BBKBB.',
  '..DBBBBBBBBBBWWK',
  '..WWBBBBBBBWWWW.',
]

const SLEEPY_Z = ['ZZZZ', '..Z.', '.Z..', 'ZZZZ']

const FLAG = ['FKFL', 'KFKL', 'FKFL', '...L', '...L', '...L', '...L', '...L']

export type Scene = {
  columns: number
  frame: number
  dogX: number
  isFacingLeft: boolean
  isWorking: boolean
  percent: number | null
}

// The furthest left pixel the dog may stand at on a track this wide.
export function furthestX(columns: number): number {
  return Math.max(0, columns - DOG_WIDTH - FLAG_ROOM)
}

// Where the dog heads: along the track by the progress, or a small run in
// place near the start while no progress has been reported.
export function targetX(columns: number, percent: number | null): number {
  if (percent === null) return Math.min(2, furthestX(columns))
  return Math.round((furthestX(columns) * percent) / 100)
}

export function drawScene(scene: Scene): string {
  const { columns } = scene
  const pixels = new Uint32Array(columns * PIXEL_ROWS)
  const scroll = scene.isWorking ? scene.frame : 0

  for (let x = 0; x < columns; x++) {
    if ((x + scroll) % 3 === 0) pixels[(PIXEL_ROWS - 1) * columns + x] = PALETTE.G ?? 0
  }

  if (scene.percent !== null) stamp(pixels, columns, FLAG, columns - 4, 0, false)

  if (scene.isWorking) {
    const behind = scene.isFacingLeft ? DOG_WIDTH : -1
    const step = scene.isFacingLeft ? 1 : -1
    const puff = scene.frame % 2
    plot(pixels, columns, scene.dogX + behind + step * puff, PIXEL_ROWS - 1, PALETTE.S)
    plot(pixels, columns, scene.dogX + behind + step * (2 + puff), PIXEL_ROWS - 2, PALETTE.S)
  }

  const sprite = scene.isWorking
    ? scene.frame % 2 === 0
      ? RUN_A
      : RUN_B
    : scene.percent === 100
      ? REST_HAPPY
      : REST
  stamp(pixels, columns, sprite, scene.dogX, 0, scene.isFacingLeft)

  if (!scene.isWorking && scene.percent !== 100) {
    stamp(pixels, columns, SLEEPY_Z, scene.dogX + DOG_WIDTH - 3, 0, false)
  }

  return encodeCells(pixels, columns)
}

function plot(pixels: Uint32Array, columns: number, x: number, y: number, color: number | undefined) {
  if (color === undefined || x < 0 || x >= columns || y < 0 || y >= PIXEL_ROWS) return
  pixels[y * columns + x] = color
}

function stamp(
  pixels: Uint32Array,
  columns: number,
  sprite: readonly string[],
  left: number,
  top: number,
  isMirrored: boolean,
) {
  sprite.forEach((row, y) => {
    for (let i = 0; i < row.length; i++) {
      const mark = isMirrored ? row.charAt(row.length - 1 - i) : row.charAt(i)
      plot(pixels, columns, left + i, top + y, PALETTE[mark])
    }
  })
}

function encodeCells(pixels: Uint32Array, columns: number): string {
  const bytes = new Uint8Array(columns * DOG_ROWS * 12)
  const view = new DataView(bytes.buffer)
  let at = 0

  for (let row = 0; row < DOG_ROWS; row++) {
    for (let x = 0; x < columns; x++) {
      const top = pixels[2 * row * columns + x] ?? 0
      const bottom = pixels[(2 * row + 1) * columns + x] ?? 0
      let glyph = 0x20
      let fore = DEFAULT
      let back = DEFAULT

      if (top !== 0) {
        glyph = 0x2580
        fore = top
        back = bottom !== 0 ? bottom : DEFAULT
      } else if (bottom !== 0) {
        glyph = 0x2584
        fore = bottom
      }

      view.setUint32(at, glyph, true)
      view.setUint32(at + 4, fore, true)
      view.setUint32(at + 8, back, true)
      at += 12
    }
  }

  return toBase64(bytes)
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : '='
  }

  return out
}
