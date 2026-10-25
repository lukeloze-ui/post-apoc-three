import { describe, expect, it } from 'vitest';
import { Marks, UNDO_LIMIT, cutPolyline, simplifyPolyline, type Stroke } from './marks';

const line = (x0: number, x1: number, y = 0): { x: number; y: number }[] => [
  { x: x0, y },
  { x: x1, y },
];

describe('simplifyPolyline', () => {
  it('drops points on the line and keeps corners', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.01 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(simplifyPolyline(pts, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });
});

describe('erase', () => {
  it('splits a stroke where it is erased', () => {
    const m = new Marks();
    m.addStroke(line(0, 100));
    expect(m.erase(50, 0, 10)).toBe(true);
    const strokes = m.all.filter((x): x is Stroke => x.kind === 'stroke');
    expect(strokes).toHaveLength(2);
    expect(strokes[0]!.pts).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
    ]);
    expect(strokes[1]!.pts).toEqual([
      { x: 60, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(strokes[0]!.id).not.toBe(strokes[1]!.id);
  });

  it('trims the end of a stroke and removes a stroke wholly inside the radius', () => {
    const m = new Marks();
    m.addStroke(line(0, 100));
    m.addStroke(line(200, 203));
    m.erase(0, 0, 10);
    m.erase(201, 0, 10);
    const strokes = m.all as Stroke[];
    expect(strokes).toHaveLength(1);
    expect(strokes[0]!.pts[0]).toEqual({ x: 10, y: 0 });
  });

  it('removes notes in range, keeps others, and never removes cross-outs', () => {
    const m = new Marks();
    m.addNote(0, 0, 'ford gone');
    m.addNote(500, 0, 'bridge?');
    m.addCross(0, 0);
    m.addStrike({ x: -5, y: 0 }, { x: 5, y: 0 });
    m.erase(0, 0, 20);
    expect(m.all.map((x) => x.kind).sort()).toEqual(['cross', 'note', 'strike']);
    expect(m.all.find((x) => x.kind === 'note')).toMatchObject({ text: 'bridge?' });
  });

  it('reports no change and leaves history alone when nothing is in range', () => {
    const m = new Marks();
    m.addStroke(line(0, 100, 50));
    expect(m.erase(0, 0, 5)).toBe(false);
    m.undo();
    expect(m.all).toHaveLength(0);
  });

  it('cutPolyline keeps pieces on both sides of a bend', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
    ];
    expect(cutPolyline(pts, { x: 50, y: 0 }, 5)).toHaveLength(2);
  });
});

describe('cross-out', () => {
  it('draws over a mark without deleting it', () => {
    const m = new Marks();
    const note = m.addNote(10, 10, 'camp')!;
    m.addStrike({ x: 0, y: 10 }, { x: 30, y: 10 }, note.id);
    expect(m.all).toHaveLength(2);
    expect(m.all[0]).toBe(note);
    expect(m.all[1]).toMatchObject({ kind: 'strike', target: note.id });
    expect(m.markNear({ x: 11, y: 11 }, 5)?.id).toBe(note.id);
  });
});

describe('undo', () => {
  it('goes back one action at a time', () => {
    const m = new Marks();
    m.addNote(0, 0, 'a');
    m.addNote(1, 1, 'b');
    expect(m.undo()).toBe(true);
    expect(m.all).toHaveLength(1);
    m.undo();
    expect(m.undo()).toBe(false);
    expect(m.all).toHaveLength(0);
  });

  it('goes back only the last 20 actions', () => {
    const m = new Marks();
    for (let i = 0; i < UNDO_LIMIT + 5; i++) m.addCross(i, 0);
    let n = 0;
    while (m.undo()) n++;
    expect(n).toBe(UNDO_LIMIT);
    expect(m.all).toHaveLength(5);
  });

  it('undoes a whole erase drag as one action', () => {
    const m = new Marks();
    m.addStroke(line(0, 100));
    m.beginGesture();
    m.erase(20, 0, 5);
    m.erase(60, 0, 5);
    m.endGesture();
    expect(m.all).toHaveLength(3);
    m.undo();
    expect(m.all).toHaveLength(1);
  });
});

describe('serialization', () => {
  it('notes and other marks round-trip through JSON', () => {
    const m = new Marks();
    m.addStroke([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 20, y: 0 },
    ]);
    const note = m.addNote(3.5, 7.25, '  Taw in flood, try upstream  ')!;
    m.addCross(1, 2);
    m.addStrike({ x: 0, y: 0 }, { x: 4, y: 4 }, note.id);
    const copy = new Marks();
    copy.load(JSON.parse(JSON.stringify(m.serialize())));
    expect(copy.all).toEqual(m.all);
    expect(copy.all.find((x) => x.kind === 'note')).toMatchObject({ x: 3.5, y: 7.25, text: 'Taw in flood, try upstream' });
    // New marks after loading do not reuse ids.
    const next = copy.addCross(9, 9);
    expect(copy.all.filter((x) => x.id === next.id)).toHaveLength(1);
  });

  it('ignores junk on load', () => {
    const m = new Marks();
    m.load({ marks: [{ kind: 'note', id: 1, x: 'a' }, { kind: 'zzz', id: 2 }, null, { kind: 'cross', id: 3, x: 1, y: 2 }] });
    expect(m.all).toEqual([{ kind: 'cross', id: 3, x: 1, y: 2 }]);
  });
});
