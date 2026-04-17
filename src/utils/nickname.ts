// Human-readable anonymous nickname generator. Avoids needing accounts
// while still giving each receiver a memorable handle like "BoldFox4829".
const ANIMALS = ['Fox', 'Wolf', 'Bear', 'Hawk', 'Lynx', 'Owl', 'Crow', 'Deer', 'Hare', 'Pike']
const ADJECTIVES = ['Swift', 'Bold', 'Calm', 'Keen', 'Wild', 'Wise', 'Dark', 'Bright']

export function generateNickname(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  const num = Math.floor(Math.random() * 10000)
  return `${adj}${animal}${num}`
}
