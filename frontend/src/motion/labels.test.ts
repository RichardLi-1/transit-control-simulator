import { describe, expect, it } from 'vitest'
import {
  boxesTouch, capsuleHitsRect, ObstacleSet, Obstacle, placeLabels, LabelPriority, type Box, type LabelRequest,
} from './labels'

const req = (key: string, priority: number, candidates: Box[], extra: Partial<LabelRequest> = {}): LabelRequest => ({
  key, priority, candidates, ...extra,
})
const B = (x: number, y: number, w = 20, h = 10): Box => ({ x, y, w, h })

describe('placeLabels (shared label pass)', () => {
  it('gives a contested slot to the higher priority, whatever the queue order', () => {
    const obs = new ObstacleSet()
    const placed = placeLabels([
      req('train', LabelPriority.train, [B(0, 0)]),
      req('station', LabelPriority.station, [B(5, 2)]),
    ], obs)
    expect(placed.map((p) => p.request.key)).toEqual(['station'])
  })

  it('moves lower-priority text to its next free candidate, and culls it when none is free', () => {
    const obs = new ObstacleSet()
    const placed = placeLabels([
      req('station', LabelPriority.station, [B(0, 0)]),
      req('signal', LabelPriority.signal, [B(10, 0), B(10, 30)]),
      req('speed', LabelPriority.speed, [B(0, 5), B(12, 28)]),
    ], obs)
    const by = new Map(placed.map((p) => [p.request.key, p]))
    expect(by.get('signal')!.index).toBe(1)
    expect(by.has('speed')).toBe(false)
  })

  it('keeps text off obstacles it avoids, but may sit on kinds it opts out of', () => {
    const obs = new ObstacleSet()
    obs.rect(0, 0, 30, 30, Obstacle.platform)
    obs.segment(100, -50, 100, 50, 1, Obstacle.track)
    const placed = placeLabels([
      req('yard', LabelPriority.yard, [B(5, 5), B(92, 0), B(40, 0)]),
      req('train', LabelPriority.train, [B(5, 5)], { avoid: Obstacle.track }),
    ], obs)
    const by = new Map(placed.map((p) => [p.request.key, p]))
    expect(by.get('yard')!.index).toBe(2) // not on the platform, not across the track
    expect(by.get('train')!.index).toBe(0) // train tags may overlap platforms
  })

  it('always places a forced (focus) label and skips off-screen candidates', () => {
    const obs = new ObstacleSet()
    obs.rect(0, 0, 100, 100, Obstacle.track)
    const placed = placeLabels([
      req('focus', LabelPriority.focus, [B(-500, -500), B(10, 10)], { force: true }),
      req('off', LabelPriority.station, [B(5000, 10)]),
    ], obs, { width: 800, height: 600 })
    expect(placed.map((p) => [p.request.key, p.index])).toEqual([['focus', 1]])
  })

  it('never returns overlapping labels (randomised)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const obs = new ObstacleSet()
    for (let k = 0; k < 40; k++) obs.segment(rnd() * 800, rnd() * 600, rnd() * 800, rnd() * 600, 1, Obstacle.track)
    const reqs: LabelRequest[] = []
    for (let k = 0; k < 300; k++) {
      const cands = Array.from({ length: 4 }, () => B(rnd() * 780, rnd() * 590, 10 + rnd() * 50, 10 + rnd() * 6))
      reqs.push(req(`l${k}`, Math.floor(rnd() * 6) * 10, cands, { pad: rnd() * 2 }))
    }
    const placed = placeLabels(reqs, obs)
    expect(placed.length).toBeGreaterThan(20)
    for (let i = 0; i < placed.length; i++) {
      expect(obs.hits(placed[i].box, Obstacle.all, 0)).toBe(false)
      for (let j = i + 1; j < placed.length; j++) expect(boxesTouch(placed[i].box, placed[j].box)).toBe(false)
    }
    // priority order is respected in the output
    for (let i = 1; i < placed.length; i++) expect(placed[i].request.priority).toBeGreaterThanOrEqual(placed[i - 1].request.priority)
  })

  it('tests capsules against boxes exactly (diagonal track near a label corner)', () => {
    // 45° segment starting 2.1 px right of the box's right edge, running away from it
    const d = 3 / Math.SQRT2
    expect(capsuleHitsRect(10 + d, 10 - d + 0, 30 + d, 30 - d, 1, 0, 0, 10, 10)).toBe(false)
    expect(capsuleHitsRect(10 + d, 10 - d + 0, 30 + d, 30 - d, 3.5, 0, 0, 10, 10)).toBe(true)
    expect(capsuleHitsRect(-5, 5, 15, 5, 0, 0, 0, 10, 10)).toBe(true)
  })
})
