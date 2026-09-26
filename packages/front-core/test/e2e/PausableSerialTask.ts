export class PausableSerialTask {
  private tail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private paused = true

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onBackgroundError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.paused = false
    this.timer = setInterval(() => {
      void this.runNow().catch(this.onBackgroundError)
    }, this.intervalMs)
  }

  runNow(): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.paused) return
      await this.task()
    })
    this.tail = run.catch(() => {})
    return run
  }

  async pauseAndDrain(): Promise<void> {
    this.paused = true
    await this.tail
  }

  async resumeAndRun(): Promise<void> {
    this.paused = false
    await this.runNow()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.pauseAndDrain()
  }
}
