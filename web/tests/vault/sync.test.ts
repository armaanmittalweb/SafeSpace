import { describe, expect, it } from 'vitest';
import { VaultError, type VaultClient } from '../../src/vault/client';
import { newDataKey, openRecord } from '../../src/vault/crypto';
import { createVaultStore, memoryStorage } from '../../src/vault/sync';
import type { RecordKind, RecordsPage, SealedRecord } from '../../src/vault/types';

/** An in-memory stand-in for the vault's record routes, with the same version and cursor rules. */
function fakeServer(pageSize = 2) {
  const rows = new Map<string, SealedRecord & { seq: number }>();
  let seq = 0, prunedSeq = 0, clock = Date.UTC(2026, 8, 30), offline = false;
  const calls: string[] = [];
  const conflict = (id: string) => {
    const r = rows.get(id);
    return new VaultError(409, 'conflict', 'conflict', { current: r ? strip(r) : null });
  };
  const strip = ({ seq: _s, ...r }: SealedRecord & { seq: number }): SealedRecord => ({ ...r });
  const api: Pick<VaultClient, 'pull' | 'put' | 'remove'> = {
    async pull(since?: string): Promise<RecordsPage> {
      if (offline) throw new VaultError(0, 'offline', 'offline');
      calls.push(`pull ${since ?? ''}`);
      let from = Number(since ?? 0);
      const reset = from > 0 && from < prunedSeq;
      if (reset) from = 0;
      const all = [...rows.values()].filter(r => r.seq > from && (from > 0 || !r.deleted)).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, pageSize), more = all.length > pageSize;
      return { records: page.map(strip), cursor: String(more ? page[page.length - 1].seq : seq), more, ...(reset ? { reset: true } : {}) };
    },
    async put(id: string, body: { kind: RecordKind; iv: string; ct: string; baseVersion: number }) {
      if (offline) throw new VaultError(0, 'offline', 'offline');
      calls.push(`put ${id} ${body.baseVersion}`);
      const cur = rows.get(id);
      if ((cur?.version ?? 0) !== body.baseVersion) throw conflict(id);
      const version = body.baseVersion + 1;
      rows.set(id, { id, kind: body.kind, iv: body.iv, ct: body.ct, version, updatedAt: new Date(clock++).toISOString(), deleted: false, seq: ++seq });
      return { version };
    },
    async remove(id: string, baseVersion?: number) {
      if (offline) throw new VaultError(0, 'offline', 'offline');
      calls.push(`delete ${id} ${baseVersion}`);
      const cur = rows.get(id);
      if (!cur || cur.deleted) return;
      if (baseVersion !== undefined && cur.version !== baseVersion) throw conflict(id);
      rows.set(id, { ...cur, iv: '', ct: '', deleted: true, version: cur.version + 1, updatedAt: new Date(clock++).toISOString(), seq: ++seq });
    },
  };
  return {
    api, rows, calls,
    setOffline: (v: boolean) => { offline = v; },
    setClock: (t: number) => { clock = t; },
    prune: () => {
      for (const [id, r] of rows) if (r.deleted) { prunedSeq = Math.max(prunedSeq, r.seq); rows.delete(id); }
    },
  };
}

async function twoDevices(pageSize = 2) {
  const server = fakeServer(pageSize), dataKey = await newDataKey();
  const clockA = { t: 1000 }, clockB = { t: 1000 };
  const a = createVaultStore({ api: server.api, dataKey, storage: memoryStorage(), now: () => clockA.t });
  const b = createVaultStore({ api: server.api, dataKey, storage: memoryStorage(), now: () => clockB.t });
  return { server, dataKey, a, b, clockA, clockB };
}

const ID = '11111111-1111-4111-8111-111111111111';

describe('offline-first sync', () => {
  it('keeps saves locally while offline and pushes them later; the server only sees ciphertext', async () => {
    const { server, dataKey, a } = await twoDevices();
    server.setOffline(true);
    const rec = await a.save('checkin', { feeling: 2, note: 'secret note' });
    expect((await a.list('checkin'))[0]).toMatchObject({ id: rec.id, data: { feeling: 2, note: 'secret note' }, pending: true });
    await expect(a.sync()).rejects.toMatchObject({ code: 'offline' });
    expect(await a.pending()).toBe(1);

    server.setOffline(false);
    const res = await a.sync();
    expect(res.pushed).toBe(1);
    expect(await a.pending()).toBe(0);
    const stored = server.rows.get(rec.id)!;
    expect(stored.ct).not.toContain('secret');
    expect(await openRecord(dataKey, rec.id, 'checkin', stored)).toEqual({ updatedAt: rec.updatedAt, data: { feeling: 2, note: 'secret note' } });
  });

  it('pulls other devices\' records across pages with the cursor, and deletions as tombstones', async () => {
    const { a, b, server } = await twoDevices(2);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await a.save('checkin', { n: i })).id);
    await a.sync();
    expect((await b.sync()).pulled).toBe(5);
    expect((await b.list()).map(r => (r.data as { n: number }).n).sort()).toEqual([0, 1, 2, 3, 4]);

    await a.remove(ids[0]);
    await a.save('checkin', { n: 9 }, ids[1]);
    await a.sync();
    server.calls.length = 0;
    const res = await b.sync();
    expect(res.pulled).toBe(2);
    expect(server.calls[0]).toMatch(/^pull \d+$/); // resumed from the cursor, not from the start
    expect(await b.get(ids[0])).toBeNull();
    expect((await b.get<{ n: number }>(ids[1]))!.data.n).toBe(9);
  });

  it('409: the newer local edit wins and is written on top of the server version', async () => {
    const { a, b, clockA, clockB, server } = await twoDevices();
    await a.save('settings', { theme: 'light' }, ID);
    await a.sync();
    await b.sync();
    clockA.t = 2000;
    await a.save('settings', { theme: 'dark' }, ID);
    await a.sync();
    clockB.t = 3000; // B edits later, without having pulled A's change
    await b.save('settings', { theme: 'night' }, ID);
    const res = await b.sync();
    expect(res.conflicts).toBe(1);
    expect(server.rows.get(ID)!.version).toBe(3);
    await a.sync();
    expect((await a.get(ID))!.data).toEqual({ theme: 'night' });
    expect((await b.get(ID))!.data).toEqual({ theme: 'night' });
  });

  it('409: the newer server copy wins over an older local edit', async () => {
    const { a, b, clockA, clockB } = await twoDevices();
    await a.save('settings', { theme: 'light' }, ID);
    await a.sync();
    await b.sync();
    clockB.t = 1500; // B edits first but syncs last
    await b.save('settings', { theme: 'night' }, ID);
    clockA.t = 2500;
    await a.save('settings', { theme: 'dark' }, ID);
    await a.sync();
    const res = await b.sync();
    expect(res.conflicts).toBe(1);
    expect((await b.get(ID))!).toMatchObject({ data: { theme: 'dark' }, pending: false });
  });

  it('an edit newer than a deletion brings the record back; an older one is dropped', async () => {
    const { a, b, clockA, clockB, server } = await twoDevices();
    server.setClock(5000);
    await a.save('checkin', { v: 1 }, ID);
    await a.sync();
    await b.sync();
    clockA.t = 6000;
    await a.remove(ID);
    await a.sync(); // tombstone at server time ~5001
    clockB.t = 9000;
    await b.save('checkin', { v: 2 }, ID);
    await b.sync();
    expect(server.rows.get(ID)!.deleted).toBe(false);
    await a.sync();
    expect((await a.get(ID))!.data).toEqual({ v: 2 });

    clockA.t = 10_000;
    server.setClock(12_000); // the deletion reaches the server at 12 000
    await a.remove(ID);
    await a.sync();
    clockB.t = 9500; // B edits before the deletion, but syncs after it
    await b.save('checkin', { v: 3 }, ID);
    await b.sync();
    expect(await b.get(ID)).toBeNull();
    expect(server.rows.get(ID)!.deleted).toBe(true);
  });

  it('a deletion against a newer remote edit keeps the edit', async () => {
    const { a, b, clockA, clockB } = await twoDevices();
    await a.save('checkin', { v: 1 }, ID);
    await a.sync();
    await b.sync();
    clockB.t = 1500;
    await b.remove(ID);
    clockA.t = 3000;
    await a.save('checkin', { v: 2 }, ID);
    await a.sync();
    await b.sync();
    expect((await b.get(ID))!.data).toEqual({ v: 2 });
  });

  it('starts over when the server says the cursor predates pruned tombstones', async () => {
    const { a, b, server } = await twoDevices(10);
    const x = await a.save('checkin', { v: 'x' });
    const y = await a.save('checkin', { v: 'y' });
    await a.sync();
    await b.sync();
    await a.remove(x.id);
    await a.sync();
    await a.save('checkin', { v: 'z' });
    await a.sync();
    server.prune(); // B never saw x's tombstone
    const res = await b.sync();
    expect(res.pulled).toBeGreaterThan(0);
    expect((await b.list()).map(r => r.data)).toEqual(expect.arrayContaining([{ v: 'y' }, { v: 'z' }]));
    expect(await b.get(x.id)).toBeNull();
    expect(await b.get(y.id)).not.toBeNull();
  });

  it('never sends a record that was created and deleted offline, and marks refused records', async () => {
    const { a, server } = await twoDevices();
    const r = await a.save('checkin', { v: 1 });
    await a.remove(r.id);
    await a.sync();
    expect(server.calls.filter(c => c.startsWith('put') || c.startsWith('delete'))).toEqual([]);

    const big = await a.save('import', { v: 2 });
    const put = server.api.put;
    server.api.put = async () => { throw new VaultError(413, 'too_large', 'A record can be at most 64 KB.'); };
    const res = await a.sync();
    expect(res.rejected).toEqual([{ id: big.id, code: 'too_large' }]);
    server.api.put = put;
    expect((await a.sync()).pushed).toBe(0); // not retried until saved again
    await a.save('import', { v: 3 }, big.id);
    expect((await a.sync()).pushed).toBe(1);
  });

  it('runs one sync at a time and tells subscribers', async () => {
    const { a } = await twoDevices();
    let calls = 0;
    const off = a.subscribe(() => calls++);
    await a.save('checkin', {});
    const [r1, r2] = await Promise.all([a.sync(), a.sync()]);
    expect(r1).toBe(r2);
    expect(calls).toBe(2);
    off();
  });
});
