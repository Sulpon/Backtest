// Polyfills `indexedDB` globally for tests - pineIndexedDbCache.ts (and
// anything else touching IndexedDB) runs against this real, in-memory
// implementation of the spec rather than a hand-rolled mock, so tests
// exercise the actual read/write/index/cursor behavior the browser gives it.
import "fake-indexeddb/auto";
