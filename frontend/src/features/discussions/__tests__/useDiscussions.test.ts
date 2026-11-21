/**
 * An open thread polls only for what changed since its newest moment — a message posted, edited
 * or deleted — and merges the answer in: changed messages replace theirs, older pages stay.
 */
import { describe, expect, it } from 'vitest'
import { changedSince, mergeThread } from '../useDiscussions'
import { at, message, thread } from './fixtures'

describe('polling a thread', () => {
    it('asks from the newest moment anything in it changed, an edit or a delete included', () => {
        const t = thread()
        expect(changedSince(t)).toBe(at(20))
        const edited = thread({ messages: [...t.messages.slice(0, 2), { ...t.messages[2] }, { ...t.messages[1], id: 'm_x', editedAt: at(90) }] })
        expect(changedSince(edited)).toBe(at(90))
        const deleted = thread({ messages: [{ ...t.messages[0], deletedAt: at(120) }] })
        expect(changedSince(deleted)).toBe(at(120))
    })

    it('merges what changed: new and changed messages in order, the thread’s state from the page, older pages kept', () => {
        const before = thread({ olderCursor: 'older-1', status: 'open' })
        const page = thread({
            status: 'answered', answerMessageId: 'm_1', olderCursor: null,
            messages: [{ ...before.messages[1], body: 'From dim_customer (edited).', editedAt: at(30) }, message('m_3', 'u_ana', 'One more.', 25)],
        })
        const merged = mergeThread(before, page)
        expect(merged.messages.map((m) => m.id)).toEqual(['m_q', 'm_1', 'm_2', 'm_3'])
        expect(merged.messages[1].body).toBe('From dim_customer (edited).')
        expect(merged.status).toBe('answered')
        expect(merged.olderCursor).toBe('older-1')
    })
})
