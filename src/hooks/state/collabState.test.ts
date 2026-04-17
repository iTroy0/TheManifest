import { describe, it, expect } from 'vitest'
import {
  isValidSharedFile,
  validateSharedFile,
  sanitizeSharedFile,
  roomReducer,
  participantsReducer,
  filesReducer,
  transferReducer,
  initialRoomState,
  initialParticipantsState,
  initialFilesState,
  initialTransferState,
  type CollabParticipant,
  type SharedFile,
  type FileDownload,
} from './collabState'

// ── isValidSharedFile ────────────────────────────────────────────────────

describe('isValidSharedFile', () => {
  const valid: SharedFile = {
    id: 'f1',
    name: 'doc.txt',
    size: 1024,
    type: 'text/plain',
    owner: 'peer-1',
    ownerName: 'Alice',
    addedAt: Date.now(),
  }

  it('accepts a well-formed payload', () => {
    expect(isValidSharedFile(valid)).toBe(true)
  })

  it('accepts optional thumbnail and textPreview within bounds', () => {
    expect(isValidSharedFile({ ...valid, thumbnail: 'data:image/png;base64,x', textPreview: 'hello' })).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(isValidSharedFile(null)).toBe(false)
    expect(isValidSharedFile(undefined)).toBe(false)
    expect(isValidSharedFile('string')).toBe(false)
    expect(isValidSharedFile(42)).toBe(false)
  })

  it('rejects missing or empty id', () => {
    expect(isValidSharedFile({ ...valid, id: '' })).toBe(false)
    expect(isValidSharedFile({ ...valid, id: undefined })).toBe(false)
  })

  it('rejects id longer than 64 chars', () => {
    expect(isValidSharedFile({ ...valid, id: 'x'.repeat(65) })).toBe(false)
    expect(isValidSharedFile({ ...valid, id: 'x'.repeat(64) })).toBe(true)
  })

  it('rejects name longer than 255 chars', () => {
    expect(isValidSharedFile({ ...valid, name: 'a'.repeat(256) })).toBe(false)
    expect(isValidSharedFile({ ...valid, name: 'a'.repeat(255) })).toBe(true)
  })

  it('rejects empty name', () => {
    expect(isValidSharedFile({ ...valid, name: '' })).toBe(false)
  })

  it('rejects negative or non-integer size', () => {
    expect(isValidSharedFile({ ...valid, size: -1 })).toBe(false)
    expect(isValidSharedFile({ ...valid, size: 1.5 })).toBe(false)
    expect(isValidSharedFile({ ...valid, size: Infinity })).toBe(false)
    expect(isValidSharedFile({ ...valid, size: NaN })).toBe(false)
  })

  it('rejects size over 5 GB cap', () => {
    const over = 5 * 1024 * 1024 * 1024 + 1
    expect(isValidSharedFile({ ...valid, size: over })).toBe(false)
  })

  it('rejects oversized thumbnail (>200KB)', () => {
    expect(isValidSharedFile({ ...valid, thumbnail: 'a'.repeat(200_001) })).toBe(false)
  })

  it('rejects oversized textPreview (>2000)', () => {
    expect(isValidSharedFile({ ...valid, textPreview: 'x'.repeat(2001) })).toBe(false)
  })

  it('rejects empty owner or ownerName', () => {
    expect(isValidSharedFile({ ...valid, owner: '' })).toBe(false)
    expect(isValidSharedFile({ ...valid, ownerName: '' })).toBe(false)
  })

  it('rejects missing addedAt', () => {
    expect(isValidSharedFile({ ...valid, addedAt: undefined })).toBe(false)
    expect(isValidSharedFile({ ...valid, addedAt: 'not-a-number' })).toBe(false)
  })
})

describe('validateSharedFile (reason reporting)', () => {
  const valid: SharedFile = {
    id: 'f1',
    name: 'doc.txt',
    size: 1024,
    type: 'text/plain',
    owner: 'peer-1',
    ownerName: 'Alice',
    addedAt: Date.now(),
  }

  it('returns null for well-formed payload', () => {
    expect(validateSharedFile(valid)).toBeNull()
  })

  it('reports the failing field for length overflows', () => {
    expect(validateSharedFile({ ...valid, id: 'x'.repeat(65) })).toContain('id:len=')
    expect(validateSharedFile({ ...valid, name: 'a'.repeat(256) })).toContain('name:len=')
    expect(validateSharedFile({ ...valid, owner: '' })).toContain('owner:len=0')
    expect(validateSharedFile({ ...valid, thumbnail: 'x'.repeat(200_001) })).toContain('thumbnail:len=')
    expect(validateSharedFile({ ...valid, textPreview: 'y'.repeat(2001) })).toContain('textPreview:len=')
  })

  it('reports size issues distinctly', () => {
    expect(validateSharedFile({ ...valid, size: -1 })).toContain('size:out-of-range')
    expect(validateSharedFile({ ...valid, size: 1.5 })).toContain('size:not-integer')
  })
})

describe('sanitizeSharedFile', () => {
  const valid: SharedFile = {
    id: 'f1',
    name: 'doc.txt',
    size: 1024,
    type: 'text/plain',
    owner: 'peer-1',
    ownerName: 'Alice',
    addedAt: Date.now(),
  }

  it('returns the file unchanged when everything is valid', () => {
    const result = sanitizeSharedFile(valid)
    expect(result).not.toBeNull()
    expect(result!.file).toEqual(valid)
    expect(result!.droppedReasons).toEqual([])
  })

  it('strips an oversized thumbnail and accepts the file', () => {
    const over = { ...valid, thumbnail: 'x'.repeat(200_001) }
    const result = sanitizeSharedFile(over)
    expect(result).not.toBeNull()
    expect(result!.file.thumbnail).toBeUndefined()
    expect(result!.droppedReasons[0]).toContain('thumbnail:len=')
  })

  it('strips an oversized textPreview and accepts the file', () => {
    const over = { ...valid, textPreview: 'y'.repeat(2001) }
    const result = sanitizeSharedFile(over)
    expect(result).not.toBeNull()
    expect(result!.file.textPreview).toBeUndefined()
    expect(result!.droppedReasons[0]).toContain('textPreview:len=')
  })

  it('strips both cosmetic fields when both overflow', () => {
    const over = { ...valid, thumbnail: 'x'.repeat(200_001), textPreview: 'y'.repeat(2001) }
    const result = sanitizeSharedFile(over)
    expect(result).not.toBeNull()
    expect(result!.file.thumbnail).toBeUndefined()
    expect(result!.file.textPreview).toBeUndefined()
    expect(result!.droppedReasons.length).toBe(2)
  })

  it('returns null when an essential field is invalid', () => {
    expect(sanitizeSharedFile({ ...valid, id: '' })).toBeNull()
    expect(sanitizeSharedFile({ ...valid, owner: '' })).toBeNull()
    expect(sanitizeSharedFile({ ...valid, size: -1 })).toBeNull()
    expect(sanitizeSharedFile(null)).toBeNull()
  })
})

// ── roomReducer ──────────────────────────────────────────────────────────

describe('roomReducer', () => {
  it('SET merges partial payload', () => {
    const next = roomReducer(initialRoomState, { type: 'SET', payload: { roomId: 'room-1', myName: 'Alice' } })
    expect(next.roomId).toBe('room-1')
    expect(next.myName).toBe('Alice')
    expect(next.status).toBe('initializing') // unchanged
  })

  it('SET_STATUS updates status', () => {
    const next = roomReducer(initialRoomState, { type: 'SET_STATUS', payload: 'connected' })
    expect(next.status).toBe('connected')
  })

  it('SET_STATUS returns same reference when status is unchanged', () => {
    const next = roomReducer(initialRoomState, { type: 'SET_STATUS', payload: 'initializing' })
    expect(next).toBe(initialRoomState)
  })

  it('RESET returns initial state', () => {
    const dirty = roomReducer(initialRoomState, { type: 'SET', payload: { roomId: 'x', myName: 'y' } })
    const reset = roomReducer(dirty, { type: 'RESET' })
    expect(reset).toEqual(initialRoomState)
  })
})

// ── participantsReducer ──────────────────────────────────────────────────

describe('participantsReducer', () => {
  const p = (peerId: string, overrides: Partial<CollabParticipant> = {}): CollabParticipant => ({
    peerId,
    name: `name-${peerId}`,
    isHost: false,
    connectionStatus: 'connected',
    directConnection: true,
    ...overrides,
  })

  it('SET_PARTICIPANTS replaces list and updates onlineCount', () => {
    const next = participantsReducer(initialParticipantsState, {
      type: 'SET_PARTICIPANTS',
      payload: [p('a'), p('b'), p('c')],
    })
    expect(next.participants).toHaveLength(3)
    expect(next.onlineCount).toBe(3)
  })

  it('ADD_PARTICIPANT appends when peerId is new', () => {
    const state = { ...initialParticipantsState, participants: [p('a')], onlineCount: 1 }
    const next = participantsReducer(state, { type: 'ADD_PARTICIPANT', payload: p('b') })
    expect(next.participants).toHaveLength(2)
    expect(next.onlineCount).toBe(2)
  })

  it('ADD_PARTICIPANT is idempotent when peerId already exists', () => {
    const state = { ...initialParticipantsState, participants: [p('a')], onlineCount: 1 }
    const next = participantsReducer(state, { type: 'ADD_PARTICIPANT', payload: p('a', { name: 'renamed' }) })
    expect(next).toBe(state) // exact same reference
    expect(next.participants[0].name).toBe('name-a') // not updated — must use UPDATE
  })

  it('REMOVE_PARTICIPANT drops by peerId and recomputes onlineCount', () => {
    const state = { ...initialParticipantsState, participants: [p('a'), p('b')], onlineCount: 2 }
    const next = participantsReducer(state, { type: 'REMOVE_PARTICIPANT', peerId: 'a' })
    expect(next.participants).toEqual([p('b')])
    expect(next.onlineCount).toBe(1)
  })

  it('REMOVE_PARTICIPANT with unknown peerId is a no-op (still returns new object)', () => {
    const state = { ...initialParticipantsState, participants: [p('a')], onlineCount: 1 }
    const next = participantsReducer(state, { type: 'REMOVE_PARTICIPANT', peerId: 'unknown' })
    expect(next.participants).toEqual([p('a')])
  })

  it('UPDATE_PARTICIPANT merges payload into matching peerId only', () => {
    const state = { ...initialParticipantsState, participants: [p('a'), p('b')], onlineCount: 2 }
    const next = participantsReducer(state, {
      type: 'UPDATE_PARTICIPANT',
      peerId: 'a',
      payload: { fingerprint: 'abc123', directConnection: false },
    })
    expect(next.participants[0]).toMatchObject({ peerId: 'a', fingerprint: 'abc123', directConnection: false })
    expect(next.participants[1]).toEqual(p('b')) // untouched
  })

  it('RESET returns initial', () => {
    const state = { ...initialParticipantsState, participants: [p('a')], onlineCount: 1 }
    expect(participantsReducer(state, { type: 'RESET' })).toEqual(initialParticipantsState)
  })
})

// ── filesReducer ─────────────────────────────────────────────────────────

describe('filesReducer', () => {
  const f = (id: string, owner = 'peer-1'): SharedFile => ({
    id,
    name: `file-${id}`,
    size: 100,
    type: 'text/plain',
    owner,
    ownerName: 'Alice',
    addedAt: 0,
  })
  const d: FileDownload = { status: 'downloading', progress: 50, speed: 1000 }

  it('ADD_SHARED_FILE appends when id is new', () => {
    const next = filesReducer(initialFilesState, { type: 'ADD_SHARED_FILE', payload: f('a') })
    expect(next.sharedFiles).toHaveLength(1)
    expect(next.sharedFiles[0].id).toBe('a')
  })

  it('ADD_SHARED_FILE dedupes by id', () => {
    const state = filesReducer(initialFilesState, { type: 'ADD_SHARED_FILE', payload: f('a') })
    const next = filesReducer(state, { type: 'ADD_SHARED_FILE', payload: f('a') })
    expect(next).toBe(state)
  })

  it('REMOVE_SHARED_FILE drops file + its download + clears mySharedFiles entry', () => {
    let state = filesReducer(initialFilesState, { type: 'ADD_SHARED_FILE', payload: f('a') })
    state = filesReducer(state, { type: 'SET_DOWNLOAD', fileId: 'a', download: d })
    state = filesReducer(state, { type: 'ADD_MY_SHARED_FILE', fileId: 'a' })
    const next = filesReducer(state, { type: 'REMOVE_SHARED_FILE', fileId: 'a' })
    expect(next.sharedFiles).toEqual([])
    expect(next.downloads).toEqual({})
    expect(next.mySharedFiles.has('a')).toBe(false)
  })

  it('UPDATE_DOWNLOAD merges into existing download', () => {
    const state = filesReducer(initialFilesState, { type: 'SET_DOWNLOAD', fileId: 'a', download: d })
    const next = filesReducer(state, { type: 'UPDATE_DOWNLOAD', fileId: 'a', payload: { progress: 90 } })
    expect(next.downloads['a'].progress).toBe(90)
    expect(next.downloads['a'].status).toBe('downloading') // unchanged
  })

  it('UPDATE_DOWNLOAD is a no-op when the fileId has no existing entry', () => {
    const next = filesReducer(initialFilesState, { type: 'UPDATE_DOWNLOAD', fileId: 'missing', payload: { progress: 50 } })
    expect(next).toBe(initialFilesState)
  })

  it('CANCEL_ALL_DOWNLOADS clears downloads without touching sharedFiles or mySharedFiles', () => {
    let state = filesReducer(initialFilesState, { type: 'ADD_SHARED_FILE', payload: f('a') })
    state = filesReducer(state, { type: 'SET_DOWNLOAD', fileId: 'a', download: d })
    state = filesReducer(state, { type: 'ADD_MY_SHARED_FILE', fileId: 'a' })
    const next = filesReducer(state, { type: 'CANCEL_ALL_DOWNLOADS' })
    expect(next.downloads).toEqual({})
    expect(next.sharedFiles).toEqual([f('a')])
    expect(next.mySharedFiles.has('a')).toBe(true)
  })

  it('REMOVE_FILES_BY_OWNER drops all files from one owner and their downloads', () => {
    let state = filesReducer(initialFilesState, { type: 'ADD_SHARED_FILE', payload: f('a', 'peer-1') })
    state = filesReducer(state, { type: 'ADD_SHARED_FILE', payload: f('b', 'peer-1') })
    state = filesReducer(state, { type: 'ADD_SHARED_FILE', payload: f('c', 'peer-2') })
    state = filesReducer(state, { type: 'SET_DOWNLOAD', fileId: 'a', download: d })
    state = filesReducer(state, { type: 'SET_DOWNLOAD', fileId: 'c', download: d })
    const next = filesReducer(state, { type: 'REMOVE_FILES_BY_OWNER', ownerId: 'peer-1' })
    expect(next.sharedFiles.map(x => x.id)).toEqual(['c'])
    expect(next.downloads).toEqual({ c: d }) // peer-1's downloads wiped
  })

  it('UPDATE_SHARED_FILE_OWNER_NAME updates ownerName on matching files only', () => {
    let state = filesReducer(initialFilesState, { type: 'ADD_SHARED_FILE', payload: f('a', 'peer-1') })
    state = filesReducer(state, { type: 'ADD_SHARED_FILE', payload: f('b', 'peer-2') })
    const next = filesReducer(state, { type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: 'peer-1', newName: 'Bob' })
    expect(next.sharedFiles[0].ownerName).toBe('Bob')
    expect(next.sharedFiles[1].ownerName).toBe('Alice')
  })

  it('RESET returns initial with fresh empty mySharedFiles Set', () => {
    const state = filesReducer(initialFilesState, { type: 'ADD_MY_SHARED_FILE', fileId: 'a' })
    const reset = filesReducer(state, { type: 'RESET' })
    expect(reset.mySharedFiles.size).toBe(0)
    expect(reset.sharedFiles).toEqual([])
  })
})

// ── transferReducer ──────────────────────────────────────────────────────

describe('transferReducer', () => {
  it('START_UPLOAD adds entry with zero progress', () => {
    const next = transferReducer(initialTransferState, { type: 'START_UPLOAD', fileId: 'a', fileName: 'doc.txt' })
    expect(next.uploads['a']).toEqual({ progress: 0, speed: 0, fileName: 'doc.txt' })
  })

  it('UPDATE_UPLOAD merges progress/speed but preserves fileName', () => {
    let state = transferReducer(initialTransferState, { type: 'START_UPLOAD', fileId: 'a', fileName: 'doc.txt' })
    state = transferReducer(state, { type: 'UPDATE_UPLOAD', fileId: 'a', progress: 50, speed: 1024 })
    expect(state.uploads['a']).toEqual({ progress: 50, speed: 1024, fileName: 'doc.txt' })
  })

  it('UPDATE_UPLOAD is a no-op when fileId not present', () => {
    const next = transferReducer(initialTransferState, { type: 'UPDATE_UPLOAD', fileId: 'missing', progress: 10, speed: 1 })
    expect(next).toBe(initialTransferState)
  })

  it('END_UPLOAD removes the entry', () => {
    let state = transferReducer(initialTransferState, { type: 'START_UPLOAD', fileId: 'a', fileName: 'doc.txt' })
    state = transferReducer(state, { type: 'END_UPLOAD', fileId: 'a' })
    expect(state.uploads).toEqual({})
  })

  it('RESET clears all uploads', () => {
    let state = transferReducer(initialTransferState, { type: 'START_UPLOAD', fileId: 'a', fileName: 'doc.txt' })
    state = transferReducer(state, { type: 'START_UPLOAD', fileId: 'b', fileName: 'pic.png' })
    expect(transferReducer(state, { type: 'RESET' })).toEqual(initialTransferState)
  })
})
