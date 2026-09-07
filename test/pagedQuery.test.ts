import { describe, expect, it, vi } from "vitest";
import {
  createPagedQuery,
  type PagedListState,
  type PagedLoadState,
  type PageResult,
} from "../src/resource/index.js";

type Row = { id: string };

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (list: readonly Row[]) => list.map((row) => row.id);

// Keyed by the discriminant: a new arm on either axis stops this compiling.
const listStates: Record<PagedListState["status"], PagedListState> = {
  idle: { status: "idle" },
  loading: { status: "loading" },
  ready: { status: "ready" },
  error: { status: "error", error: new Error("boom") },
};

const loadStates: Record<PagedLoadState["status"], PagedLoadState> = {
  idle: { status: "idle" },
  loading: { status: "loading" },
  error: { status: "error", error: new Error("boom") },
};

/**
 * The three real pagination shapes in the park, each written as the adapter a
 * consumer would write. If any of them needs bookkeeping PagedQuery should own,
 * the abstraction is wrong — so all three drive the same assertions below.
 */

/** observatory: opaque base64 keyset cursor, server already returns null at the end. */
function opaqueCursorSource(pages: Row[][]) {
  return (cursor: string | undefined): Promise<PageResult<Row, string>> => {
    const index = cursor === undefined ? 0 : Number(atob(cursor));
    const items = pages[index] ?? [];
    const isLast = index >= pages.length - 1;
    return Promise.resolve({
      items,
      nextCursor: isLast ? null : btoa(String(index + 1)),
    });
  };
}

/** tg-gallery: 1-based page number plus a server-reported total; never returns null. */
function pageNumberSource(pages: Row[][], limit: number) {
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  return (cursor: number | undefined): Promise<PageResult<Row, number>> => {
    const page = cursor ?? 1;
    const items = pages[page - 1] ?? [];
    return Promise.resolve({
      items,
      // The adapter synthesises termination from what the server sent.
      nextCursor: page * limit >= total ? null : page + 1,
      total,
    });
  };
}

/** Retouch4Me JobsStore: numeric offset plus an explicit hasMore boolean. */
function offsetSource(pages: Row[][], limit: number) {
  return (cursor: number | undefined): Promise<PageResult<Row, number>> => {
    const offset = cursor ?? 0;
    const index = Math.floor(offset / limit);
    const items = pages[index] ?? [];
    const hasMore = index < pages.length - 1;
    return Promise.resolve({
      items,
      nextCursor: hasMore ? offset + limit : null,
    });
  };
}

const threePages = [rows("a", "b"), rows("c", "d"), rows("e", "f")];

describe("PagedQuery covers all three real cursor shapes", () => {
  const sources = {
    "opaque keyset cursor (observatory)": () =>
      createPagedQuery<Row, string>({
        fetchPage: opaqueCursorSource(threePages),
        keyOf: (row) => row.id,
      }),
    "page number with total (tg-gallery)": () =>
      createPagedQuery<Row, number>({
        fetchPage: pageNumberSource(threePages, 2),
        keyOf: (row) => row.id,
      }),
    "offset with hasMore (JobsStore)": () =>
      createPagedQuery<Row, number>({
        fetchPage: offsetSource(threePages, 2),
        keyOf: (row) => row.id,
      }),
  };

  for (const [name, make] of Object.entries(sources)) {
    it(`walks every page to the end with a ${name}`, async () => {
      const paged = make();
      expect(paged.state).toEqual(listStates.idle);

      await paged.load();
      expect(ids(paged.items)).toEqual(["a", "b"]);
      expect(paged.state).toEqual(listStates.ready);
      expect(paged.hasMore).toBe(true);

      await paged.loadMore();
      expect(ids(paged.items)).toEqual(["a", "b", "c", "d"]);
      expect(paged.hasMore).toBe(true);

      await paged.loadMore();
      expect(ids(paged.items)).toEqual(["a", "b", "c", "d", "e", "f"]);
      expect(paged.hasMore).toBe(false);
      expect(paged.pageCount).toBe(3);

      // Past the end, loadMore is an inert no-op the sentinel can keep calling.
      await paged.loadMore();
      expect(ids(paged.items)).toEqual(["a", "b", "c", "d", "e", "f"]);
      expect(paged.pageCount).toBe(3);
    });
  }

  it("passes a server-reported total through when there is one", async () => {
    const withTotal = createPagedQuery<Row, number>({
      fetchPage: pageNumberSource(threePages, 2),
      keyOf: (row) => row.id,
    });
    const withoutTotal = createPagedQuery<Row, string>({
      fetchPage: opaqueCursorSource(threePages),
      keyOf: (row) => row.id,
    });

    await withTotal.load();
    await withoutTotal.load();

    expect(withTotal.total).toBe(6);
    expect(withoutTotal.total).toBeNull();
  });
});

describe("PagedQuery first load", () => {
  it("starts idle and reaches ready with the first page", async () => {
    const paged = createPagedQuery<Row, string>({
      fetchPage: opaqueCursorSource(threePages),
      keyOf: (row) => row.id,
    });

    expect(paged.state).toEqual(listStates.idle);
    expect(paged.isEmpty).toBe(false);

    await paged.load();

    expect(paged.state).toEqual(listStates.ready);
    expect(paged.pageLoad).toEqual(loadStates.idle);
  });

  it("reports an empty result as empty rather than as missing", async () => {
    const paged = createPagedQuery<Row, string>({
      fetchPage: () => Promise.resolve({ items: [], nextCursor: null }),
      keyOf: (row) => row.id,
    });

    await paged.load();

    expect(paged.isEmpty).toBe(true);
    expect(paged.hasMore).toBe(false);
    expect(paged.state).toEqual(listStates.ready);
  });

  it("lands on error when the first page fails", async () => {
    const paged = createPagedQuery<Row, string>({
      fetchPage: () => Promise.reject(new Error("network down")),
      keyOf: (row) => row.id,
    });

    await paged.load();

    expect(paged.state).toMatchObject({ status: "error" });
    expect(paged.items).toEqual([]);
  });

  it("ignores a second load while the first is in flight", async () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
    const fetchPage = vi.fn(() => new Promise<PageResult<Row, string>>(() => {}));
    const paged = createPagedQuery<Row, string>({ fetchPage, keyOf: (row) => row.id });

    void paged.load();
    void paged.load();

    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe("PagedQuery loadMore", () => {
  it("does nothing before the first page has loaded", async () => {
    const fetchPage = vi.fn(opaqueCursorSource(threePages));
    const paged = createPagedQuery<Row, string>({ fetchPage, keyOf: (row) => row.id });

    await paged.loadMore();

    expect(fetchPage).not.toHaveBeenCalled();
    expect(paged.state).toEqual(listStates.idle);
  });

  it("ignores a second loadMore while a page is in flight", async () => {
    let calls = 0;
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) => {
        calls += 1;
        if (cursor === undefined) return Promise.resolve({ items: rows("a"), nextCursor: "1" });
        // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
        return new Promise<PageResult<Row, string>>(() => {});
      },
      keyOf: (row) => row.id,
    });

    await paged.load();
    void paged.loadMore();
    void paged.loadMore();

    expect(calls).toBe(2);
    expect(paged.pageLoad).toEqual(loadStates.loading);
  });

  it("drops rows already loaded so an overlapping page cannot duplicate a key", async () => {
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) =>
        Promise.resolve(
          cursor === undefined
            ? { items: rows("a", "b"), nextCursor: "1" }
            : { items: rows("b", "c"), nextCursor: null },
        ),
      keyOf: (row) => row.id,
    });

    await paged.load();
    await paged.loadMore();

    expect(ids(paged.items)).toEqual(["a", "b", "c"]);
  });

  // The donor's comment says why: a retry must re-request the page that
  // failed, not the one after it.
  it("keeps the cursor after a failed page so a retry re-requests it", async () => {
    const requested: (string | undefined)[] = [];
    let failNext = true;
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) => {
        requested.push(cursor);
        if (cursor === undefined) return Promise.resolve({ items: rows("a"), nextCursor: "p2" });
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("page failed"));
        }
        return Promise.resolve({ items: rows("b"), nextCursor: null });
      },
      keyOf: (row) => row.id,
    });

    await paged.load();
    await paged.loadMore();

    expect(paged.pageLoad).toMatchObject({ status: "error" });
    expect(paged.nextCursor).toBe("p2");
    expect(ids(paged.items)).toEqual(["a"]);
    // The list itself is untouched — only the page slot reports the failure.
    expect(paged.state).toEqual(listStates.ready);

    await paged.loadMore();

    expect(requested).toEqual([undefined, "p2", "p2"]);
    expect(ids(paged.items)).toEqual(["a", "b"]);
    expect(paged.pageLoad).toEqual(loadStates.idle);
  });
});

describe("PagedQuery revalidate", () => {
  it("re-walks every loaded page rather than collapsing to the first", async () => {
    const requested: (string | undefined)[] = [];
    let generation = 1;
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) => {
        requested.push(cursor);
        const index = cursor === undefined ? 0 : Number(cursor);
        const suffix = generation === 1 ? "" : `-v${generation}`;
        return Promise.resolve({
          items: rows(`${index}a${suffix}`, `${index}b${suffix}`),
          nextCursor: index >= 2 ? null : String(index + 1),
        });
      },
      keyOf: (row) => row.id,
    });

    await paged.load();
    await paged.loadMore();
    expect(paged.pageCount).toBe(2);

    generation = 2;
    requested.length = 0;
    await paged.revalidate();

    expect(requested).toEqual([undefined, "1"]);
    expect(ids(paged.items)).toEqual(["0a-v2", "0b-v2", "1a-v2", "1b-v2"]);
    expect(paged.pageCount).toBe(2);
    expect(paged.hasMore).toBe(true);
    expect(paged.refresh).toEqual(loadStates.idle);
  });

  it("falls back to a first load when nothing is loaded yet", async () => {
    const paged = createPagedQuery<Row, string>({
      fetchPage: opaqueCursorSource(threePages),
      keyOf: (row) => row.id,
    });

    await paged.revalidate();

    expect(ids(paged.items)).toEqual(["a", "b"]);
    expect(paged.pageCount).toBe(1);
  });

  // The list on screen is never blanked by a refresh that failed.
  it("keeps the existing items when the walk fails part-way", async () => {
    let generation = 1;
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) => {
        const index = cursor === undefined ? 0 : Number(cursor);
        if (generation === 2 && index === 1) return Promise.reject(new Error("page 2 failed"));
        return Promise.resolve({
          items: rows(`${index}a`, `${index}b`),
          nextCursor: index >= 2 ? null : String(index + 1),
        });
      },
      keyOf: (row) => row.id,
    });

    await paged.load();
    await paged.loadMore();
    const before = ids(paged.items);

    generation = 2;
    await paged.revalidate();

    expect(ids(paged.items)).toEqual(before);
    expect(paged.state).toEqual(listStates.ready);
    expect(paged.refresh).toMatchObject({ status: "error" });
    expect(paged.pageCount).toBe(2);
  });

  it("shortens the walk when the server now reports fewer pages", async () => {
    let generation = 1;
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) => {
        const index = cursor === undefined ? 0 : Number(cursor);
        if (generation === 2) return Promise.resolve({ items: rows("only"), nextCursor: null });
        return Promise.resolve({
          items: rows(`${index}a`),
          nextCursor: index >= 2 ? null : String(index + 1),
        });
      },
      keyOf: (row) => row.id,
    });

    await paged.load();
    await paged.loadMore();
    await paged.loadMore();
    expect(paged.pageCount).toBe(3);

    generation = 2;
    await paged.revalidate();

    expect(ids(paged.items)).toEqual(["only"]);
    expect(paged.pageCount).toBe(1);
    expect(paged.hasMore).toBe(false);
  });

  it("ignores a second revalidate while one is in flight", async () => {
    let calls = 0;
    const paged = createPagedQuery<Row, string>({
      fetchPage: (cursor) => {
        calls += 1;
        if (cursor === undefined && calls === 1) {
          return Promise.resolve({ items: rows("a"), nextCursor: null });
        }
        // biome-ignore lint/suspicious/noEmptyBlockStatements: a deliberate no-op, not an unfinished block
        return new Promise<PageResult<Row, string>>(() => {});
      },
      keyOf: (row) => row.id,
    });

    await paged.load();
    void paged.revalidate();
    void paged.revalidate();

    expect(calls).toBe(2);
    expect(paged.refresh).toEqual(loadStates.loading);
  });
});

describe("PagedQuery reset", () => {
  it("returns to the start", async () => {
    const paged = createPagedQuery<Row, string>({
      fetchPage: opaqueCursorSource(threePages),
      keyOf: (row) => row.id,
    });

    await paged.load();
    await paged.loadMore();
    paged.reset();

    expect(paged.items).toEqual([]);
    expect(paged.state).toEqual(listStates.idle);
    expect(paged.pageCount).toBe(0);
    expect(paged.nextCursor).toBeNull();
    expect(paged.total).toBeNull();
  });
});
