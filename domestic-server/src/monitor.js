import { EventEmitter } from 'node:events';
import { probeTarget, summarizeSamples } from './probe.js';

export class NetworkMonitor extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.records = new Map((config.targets || []).map((target) => [target.id, []]));
    this.events = [];
    this.timer = null;
    this.running = false;
    this.cycleRunning = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.runCycle();
    this.timer = setInterval(() => this.runCycle(), this.config.probe.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
  }

  async runCycle() {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    const enabledTargets = this.config.targets.filter((target) => target.enabled !== false);
    try {
      await Promise.all(enabledTargets.map((target) => this.sample(target)));
      this.emit('update', this.snapshot());
    } finally {
      this.cycleRunning = false;
    }
  }

  replaceTargets(targets) {
    this.config.targets = targets.map((target) => ({ ...target }));
    const ids = new Set(targets.map((target) => target.id));
    for (const id of ids) if (!this.records.has(id)) this.records.set(id, []);
    for (const id of this.records.keys()) if (!ids.has(id)) this.records.delete(id);
    void this.runCycle();
  }

  async sample(target) {
    const samples = this.records.get(target.id);
    const previous = samples.at(-1);
    const result = await probeTarget(target, this.config.probe.timeoutMs);
    samples.push(result);
    if (samples.length > this.config.probe.historySize) samples.shift();

    if ((previous && (previous.ok !== result.ok || previous.errorCode !== result.errorCode)) || (!previous && !result.ok)) {
      this.events.unshift({
        timestamp: result.timestamp,
        targetId: target.id,
        targetLabel: target.label,
        level: result.ok ? 'recovered' : 'error',
        message: result.ok ? '连接恢复' : result.error,
      });
      this.events = this.events.slice(0, 100);
    }
  }

  snapshot() {
    const thresholds = this.config.probe;
    return {
      generatedAt: new Date().toISOString(),
      probeIntervalMs: thresholds.intervalMs,
      targets: this.config.targets.map((target) => {
        const samples = this.records.get(target.id) || [];
        return {
          id: target.id,
          label: target.label,
          host: target.host,
          port: target.port,
          mode: target.mode,
          enabled: target.enabled !== false,
          summary: target.enabled === false
            ? { state: 'disabled', sampleCount: 0 }
            : summarizeSamples(samples, thresholds),
          samples,
        };
      }),
      events: this.events.slice(0, 30),
    };
  }
}
