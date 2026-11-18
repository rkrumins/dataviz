/**
 * idbStore — a small key → value store in IndexedDB, for what is too large for localStorage
 * (~5 MB): a draft's unsaved work at tens of thousands of changes. Values are kept by structured
 * clone (no JSON). Every call settles — a browser without IndexedDB (private mode, some tests)
 * reads nothing and keeps nothing, and says so.
 */
const DB = 'synodic-staged-drafts'
const STORE = 'snapshots'

let opening: Promise<IDBDatabase> | null = null

export const idbAvailable = () => typeof indexedDB !== 'undefined'

function open(): Promise<IDBDatabase> {
  if (!idbAvailable()) return Promise.reject(new Error('IndexedDB is not available'))
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { opening = null; reject(req.error) }
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = op(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(tx.error)
  }))
}

/** The value kept under `key`, or undefined. */
export function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined)
}

/** Keep `value` under `key`; true once it is durable. */
export function idbSet(key: string, value: unknown): Promise<boolean> {
  return run('readwrite', (s) => s.put(value, key)).then(() => true, () => false)
}

export function idbDelete(key: string): Promise<void> {
  return run('readwrite', (s) => s.delete(key)).then(() => undefined, () => undefined)
}
