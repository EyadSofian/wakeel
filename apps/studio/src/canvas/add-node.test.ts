import { describe, expect, test } from "vitest";
import { freeSpot } from "./add-node";

describe("freeSpot", () => {
  const box = (x: number, y: number) => ({ x, y, width: 288, height: 136 });

  test("an empty canvas keeps the start point", () => {
    expect(freeSpot({ x: 100, y: 100 }, [])).toEqual({ x: 100, y: 100 });
  });

  test("a covered start moves below the node in the way", () => {
    expect(freeSpot({ x: 0, y: 0 }, [box(0, 0)])).toEqual({ x: 0, y: 168 });
  });

  test("the spot found never overlaps a node", () => {
    const taken = [box(0, 0), box(0, 168), box(320, 0), box(320, 168)];
    const spot = freeSpot({ x: 0, y: 0 }, taken);
    const overlaps = taken.some(
      (b) => spot.x < b.x + b.width && spot.x + 288 > b.x && spot.y < b.y + b.height && spot.y + 136 > b.y,
    );
    expect(overlaps).toBe(false);
  });
});
