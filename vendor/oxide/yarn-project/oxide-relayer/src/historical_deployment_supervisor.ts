export const HISTORICAL_DEPLOYMENT_RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;

export interface HistoricalDeploymentHandle {
  stop(): Promise<void>;
  close(): Promise<void>;
}

interface SupervisorLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HistoricalDeploymentSupervisorOptions {
  label: string;
  portal: string;
  start: () => Promise<HistoricalDeploymentHandle>;
  retryDelaysMs?: readonly number[];
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: SupervisorLog;
}

/** Start one historical worker without blocking current modes, with a bounded retry budget. */
export class HistoricalDeploymentSupervisor {
  private readonly abortController = new AbortController();
  private readonly retryDelaysMs: readonly number[];
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly log: SupervisorLog;
  private runPromise?: Promise<void>;
  private handle?: HistoricalDeploymentHandle;

  constructor(private readonly options: HistoricalDeploymentSupervisorOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? HISTORICAL_DEPLOYMENT_RETRY_DELAYS_MS;
    this.delay = options.delay ?? abortableDelay;
    this.log = options.log ?? console;
  }

  start(): void {
    this.runPromise ??= this.run();
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    await this.runPromise;
    if (this.handle) {
      await this.handle.stop();
    }
  }

  async close(): Promise<void> {
    await this.runPromise;
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
  }

  /** Wait until the processor starts or exhausts its retry budget. */
  async wait(): Promise<void> {
    await this.runPromise;
  }

  private async run(): Promise<void> {
    const attempts = this.retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts && !this.abortController.signal.aborted; attempt++) {
      try {
        const handle = await this.options.start();
        this.handle = handle;
        if (this.abortController.signal.aborted) {
          return;
        }
        this.log.info(
          `historical deployment worker started label=${this.options.label} portal=${this.options.portal} ` +
            `attempt=${attempt}`,
        );
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (attempt === attempts) {
          this.log.error(
            `historical deployment worker disabled until restart label=${this.options.label} ` +
              `portal=${this.options.portal} attempts=${attempts} error=${detail}`,
          );
          return;
        }
        const delayMs = this.retryDelaysMs[attempt - 1];
        this.log.warn(
          `historical deployment worker failed label=${this.options.label} portal=${this.options.portal} ` +
            `attempt=${attempt}/${attempts} retryMs=${delayMs} error=${detail}`,
        );
        await this.delay(delayMs, this.abortController.signal);
      }
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
