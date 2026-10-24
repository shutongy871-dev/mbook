import { db } from '@/core/db/dexie';
import type { DecisionSnapshot, LtrModel, UserAction, UserEvent } from '@/core/shared/contracts';

export const FEATURE_VERSION = 'emotion-8-features-57-v1';
export const FEATURE_COUNT = 57;
export const BANDIT_DIM = 8;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
const multiply = (a: number[][], x: number[]) => a.map(row => dot(row, x));
const identity = () => Array.from({ length: BANDIT_DIM }, (_, i) =>
  Array.from({ length: BANDIT_DIM }, (_, j) => i === j ? 1 : 0));
export const validFeatures = (x: number[], n: number) =>
  x.length === n && x.every(v => Number.isFinite(v) && Math.abs(v) <= 1);

export function rewardFor(action: UserAction): number | null {
  return ({ play_start: null, sustained_play: .5, full_play: 1, like: 1,
    manual_switch: -.5, quick_skip: -1, dislike: -1, close_plugin: -2 })[action];
}

// Shared linear contextual model: A=I+Σxxᵀ, b=Σrx.
// Sherman–Morrison preserves the complete covariance, including cross-feature terms.
export function updateBandit(inverse: number[][], b: number[], x: number[], reward: number) {
  const ax = multiply(inverse, x);
  const denom = 1 + dot(x, ax);
  return {
    inverse: inverse.map((row, i) => row.map((v, j) => v - ax[i]! * ax[j]! / denom)),
    b: b.map((v, i) => v + reward * x[i]!),
  };
}

export function linUcb(inverse: number[][], b: number[], x: number[], decisions: number) {
  const variance = Math.max(0, dot(x, multiply(inverse, x)));
  const expected = dot(multiply(inverse, b), x);
  const decay = .2 - .1 * Math.min(1, decisions / 50);
  // Positive reward in this context increases optimism; both covariance and b affect selection.
  return Math.max(0, Math.min(10, 100 * decay * (expected + .3 * Math.sqrt(variance))));
}

interface Example { x: number[]; y: number; weight: number }
export function trainLogistic(examples: Example[], initial?: { weights: number[]; bias: number }) {
  const weights = initial ? [...initial.weights] : Array(FEATURE_COUNT).fill(0) as number[];
  let bias = initial?.bias ?? 0;
  // Small deterministic, regularized batch optimizer.
  for (let epoch = 0; epoch < 60; epoch++) {
    const gradient = Array(FEATURE_COUNT).fill(0) as number[];
    let gb = 0;
    let totalWeight = 0;
    for (const e of examples) {
      const error = (sigmoid(dot(weights, e.x) + bias) - e.y) * e.weight;
      gb += error;
      totalWeight += e.weight;
      e.x.forEach((v, i) => { gradient[i]! += error * v; });
    }
    if (!totalWeight) break;
    weights.forEach((v, i) => { weights[i] = v - .3 * (gradient[i]! / totalWeight + .005 * v); });
    bias -= .3 * gb / totalWeight;
  }
  return { weights, bias };
}

export class LocalLearning {
  private state: LtrModel | null = null;
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  hydrate(): Promise<void> {
    return this.loaded ??= (async () => {
      const existing = await db.ltrModel.get('local-ranking');
      this.state = existing?.feature_version === FEATURE_VERSION ? existing : {
        id: 'local-ranking', feature_version: FEATURE_VERSION, sample_count: 0,
        last_trained_at: 0, model_binary: null, last_event_id: 0,
        bandit_inverse: identity(), bandit_b: Array(BANDIT_DIM).fill(0),
      };
      // Crash between event commit and model commit is recovered exactly once.
      await this.consume();
    })().catch(error => { this.loaded = null; throw error; });
  }

  observe(): Promise<void> {
    const work = this.queue.then(async () => { await this.hydrate(); await this.consume(); });
    this.queue = work.catch(() => {});
    return work;
  }

  predict(snapshot: DecisionSnapshot, fallback: number): number {
    if (!this.state?.weights || this.state.sample_count < 200) return fallback;
    return 100 * sigmoid(dot(this.state.weights, snapshot.features) + (this.state.bias ?? 0));
  }

  get trained(): boolean { return !!this.state?.weights && this.state.sample_count >= 200; }

  explore(snapshot: DecisionSnapshot, decisions: number): number {
    return linUcb(this.state?.bandit_inverse ?? identity(),
      this.state?.bandit_b ?? Array(BANDIT_DIM).fill(0), snapshot.bandit, decisions);
  }

  private async consume(): Promise<void> {
    const state = this.state!;
    const events = await db.userEvents.where(':id').above(state.last_event_id ?? 0).toArray();
    if (!events.length) return;
    let inverse = state.bandit_inverse ?? identity();
    let b = state.bandit_b ?? Array(BANDIT_DIM).fill(0);
    const valid = (e: UserEvent) => e.decision?.version === FEATURE_VERSION &&
      validFeatures(e.decision.features, FEATURE_COUNT) && validFeatures(e.decision.bandit, BANDIT_DIM) &&
      rewardFor(e.action) != null && e.context_features.learning_excluded !== 1;
    for (const e of events.filter(valid)) {
      ({ inverse, b } = updateBandit(inverse, b, e.decision!.bandit, rewardFor(e.action)!));
    }
    const sampleCount = state.sample_count + events.filter(valid).length;
    const next = { ...state, sample_count: sampleCount, bandit_inverse: inverse, bandit_b: b,
      last_event_id: Math.max(...events.map(e => e.id ?? 0)) };
    if (Math.floor(sampleCount / 200) > Math.floor(state.sample_count / 200)) {
      const recent = (await db.userEvents.orderBy('ts').reverse().toArray()).filter(valid).slice(0, 4000);
      const examples = recent.map(e => ({ x: e.decision!.features,
        y: Math.max(0, Math.min(1, (rewardFor(e.action)! + 1) / 2)),
        weight: Math.exp(-(Date.now() - e.ts) / (30 * 86_400_000)) }));
      const fit = trainLogistic(examples, state.weights ?
        { weights: state.weights, bias: state.bias ?? 0 } : undefined);
      Object.assign(next, fit, { last_trained_at: Date.now() });
    }
    // Persist checkpoint and parameters together; never advance RAM if the write fails.
    await db.ltrModel.put(next);
    this.state = next;
  }
}

export const localLearning = new LocalLearning();
