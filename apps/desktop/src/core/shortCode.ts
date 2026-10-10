// Session short codes look like "H7K": letter-digit-letter, so they never collide with words like "yes".
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I/O
const DIGITS = '23456789' // no 0/1

export function makeShortCode(taken: Set<string>, rand: () => number = Math.random): string {
  const pick = (s: string) => s[Math.floor(rand() * s.length)]
  for (let i = 0; i < 1000; i++) {
    const code = pick(LETTERS) + pick(DIGITS) + pick(LETTERS)
    if (!taken.has(code)) return code
  }
  throw new Error('Out of session codes')
}
